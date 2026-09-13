import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { Room, worldStateSchema } from './room';
import type { WorldState } from './room';
import { RoomRuntime } from './runtime';
import { createWorldSchema, hashKey, makeKey } from '../src/net/protocol';

const directory = resolve(process.env.GLUSH_DATA_DIR ?? '.data'); mkdirSync(directory, { recursive: true });
const db = new DatabaseSync(resolve(directory, 'worlds.sqlite'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, amount INTEGER NOT NULL);');
const put = db.prepare('INSERT INTO worlds(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state');
const get = db.prepare('SELECT state FROM worlds WHERE id=?');
const imports = process.argv.indexOf('--import');
if (imports >= 0) {
  const state = worldStateSchema.parse(JSON.parse(readFileSync(resolve(process.argv[imports + 1]), 'utf8')));
  Room.restore(state);
  if (get.get(state.id)) throw new Error('World already exists; use a separate data directory to avoid replacing it.');
  put.run(state.id, JSON.stringify(state)); console.log('Imported world ' + state.id); db.close(); process.exit(0);
}
const live = new Map<string, RoomRuntime>();
const save = async (state: WorldState): Promise<void> => { put.run(state.id, JSON.stringify(state)); };
function runtime(id: string): RoomRuntime | undefined {
  if (live.has(id)) return live.get(id);
  const row = get.get(id); if (!row) return;
  const run = new RoomRuntime(Room.restore(JSON.parse(String(row.state))), save); live.set(id, run); return run;
}
const origins = (process.env.ALLOWED_ORIGINS ?? 'https://glush-game.vercel.app,https://glush.varantsov.ru,http://127.0.0.1:4175,http://localhost:4175,http://127.0.0.1:8787').split(',');
const allowed = (origin?: string): boolean => !origin || origins.includes(origin);
const clientRoot = resolve('dist');
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!allowed(origin)) { res.writeHead(403); res.end(); return; }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const json = (data: unknown, status = 200): void => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') { json({ ok: true, protocol: 1 }); return; }
    if (url.pathname === '/multiplayer.json') { json({ server: process.env.PUBLIC_SERVER_URL || `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}` }); return; }
    if (url.pathname === '/worlds' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) { json({ error: 'Request too large' }, 413); return; } }
      const data = createWorldSchema.parse(JSON.parse(body));
      const date = new Date().toISOString().slice(0, 10), ip = req.socket.remoteAddress ?? 'local', limitKey = date + ':' + ip;
      const amount = Number(db.prepare('SELECT amount FROM limits WHERE key=?').get(limitKey)?.amount ?? 0);
      if (amount >= 5 && process.env.GLUSH_TEST_MODE !== '1') { json({ error: 'Сегодня уже создано пять миров. Продолжи один из них.' }, 429); return; }
      db.prepare('INSERT INTO limits(key,amount) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET amount=amount+1').run(limitKey);
      db.prepare('DELETE FROM limits WHERE key NOT LIKE ?').run(date + '%');
      const id = crypto.randomUUID(), invite = makeKey(), room = new Room(id, await hashKey(invite), data.seed);
      const player = await room.join(data.key, invite, data.name); room.leave(player.id);
      const run = new RoomRuntime(room, save); await run.commit(); live.set(id, run); json({ id, invite }); return;
    }
    const match = url.pathname.match(/^\/worlds\/([a-f0-9-]{36})\/export$/);
    if (match && req.method === 'GET') {
      const run = runtime(match[1]); if (!run) { json({ error: 'Мир не найден.' }, 404); return; }
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const hash = await hashKey(token);
      if (![...run.room.players.values()].some(p => p.keyHash === hash)) { json({ error: 'Нужен ключ участника.' }, 403); return; }
      await run.schedule(async () => { await run.commit(); json(run.room.export()); }); return;
    }
    if (req.method === 'GET' && existsSync(clientRoot)) {
      let file = resolve(clientRoot, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(clientRoot + sep) && file !== clientRoot) { json({ error: 'Invalid path' }, 400); return; }
      if (file === clientRoot || !existsSync(file) || !statSync(file).isFile()) file = resolve(clientRoot, 'index.html');
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file)); return;
    }
    json({ error: 'Not found' }, 404);
  } catch (error) { json({ error: error instanceof Error && !('issues' in error) ? error.message : 'Неверный запрос.' }, 400); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
server.on('upgrade', (req, socket, head) => {
  const match = (req.url ?? '').match(/^\/worlds\/([a-f0-9-]{36})\/socket$/);
  if (!match || !allowed(req.headers.origin)) { socket.destroy(); return; }
  const run = runtime(match[1]); if (!run) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    const peer = { send: (text: string) => { if (ws.bufferedAmount > 2e6) ws.close(1013, 'Slow connection'); else ws.send(text); }, close: (code: number, reason: string) => ws.close(code, reason) };
    const auth = setTimeout(() => { if (!run.peers.has(peer)) ws.close(1008, 'Authentication timeout'); }, 10000);
    let messages = 0, started = Date.now();
    ws.on('message', data => { if (Date.now() - started > 1000) { messages = 0; started = Date.now(); } if (++messages > 60) { ws.close(1008, 'Rate limit'); return; } void run.message(peer, data.toString()).catch(() => ws.close(1011)); });
    ws.on('close', () => { clearTimeout(auth); void run.disconnect(peer).catch(() => {}); });
    ws.on('error', () => ws.close());
  });
});
const port = Number(process.env.PORT ?? 8787);
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`GLUSH server http://127.0.0.1:${port}`));
async function shutdown(): Promise<void> { for (const run of live.values()) { run.stop(); await run.schedule(async () => { await run.commit(); }); } wss.close(); server.close(); db.close(); process.exit(0); }
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
