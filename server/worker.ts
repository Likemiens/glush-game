import { DurableObject } from 'cloudflare:workers';
import { Room } from './room';
import type { WorldState } from './room';
import { RoomRuntime } from './runtime';
import { createWorldSchema, hashKey, makeKey } from '../src/net/protocol';
import { ACCESS_ERROR, hasTestAccess } from './access';
interface Env { ROOMS: DurableObjectNamespace<WorldRoom>; GATE: DurableObjectNamespace<CreateGate>; ALLOWED_ORIGINS: string; GLUSH_TEST_KEY_HASH?: string }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export class WorldRoom extends DurableObject<Env> {
  private runtime: RoomRuntime | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS snapshot_parts (part INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      const rows = ctx.storage.sql.exec<{ value: string }>('SELECT value FROM snapshot_parts ORDER BY part').toArray();
      const state = rows.length ? JSON.parse(rows.map(r => r.value).join('')) : await ctx.storage.get<WorldState>('world');
      if (state) this.runtime = this.createRuntime(Room.restore(state));
    });
  }
  private createRuntime(room: Room): RoomRuntime {
    return new RoomRuntime(room, async state => {
      const text = JSON.stringify(state), chunks: string[] = [];
      for (let start = 0; start < text.length; start += 250000) chunks.push(text.slice(start, start + 250000));
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM snapshot_parts WHERE part >= ?', chunks.length);
        chunks.forEach((chunk, i) => this.ctx.storage.sql.exec('INSERT INTO snapshot_parts(part,value) VALUES(?,?) ON CONFLICT(part) DO UPDATE SET value=excluded.value', i, chunk));
      });
      await this.ctx.storage.sync();
    });
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/initialize') {
      if (this.runtime) return json({ error: 'Мир уже существует.' }, 409);
      const data = await request.json() as { id: string; invite: string; key: string; name: string; seed?: string };
      const room = new Room(data.id, await hashKey(data.invite), data.seed), p = await room.join(data.key, data.invite, data.name); room.leave(p.id);
      this.runtime = this.createRuntime(room); await this.runtime.commit(); return json({ id: data.id, invite: data.invite });
    }
    const run = this.runtime; if (!run) return json({ error: 'Мир не найден.' }, 404);
    if (url.pathname.endsWith('/export')) {
      const key = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '', hashed = await hashKey(key);
      if (![...run.room.players.values()].some(p => p.keyHash === hashed)) return json({ error: 'Нужен ключ участника.' }, 403);
      let result: WorldState | undefined;
      await run.schedule(async () => { await run.commit(); result = run.room.export(); }); return json(result);
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    const pair = new WebSocketPair(), [client, server] = Object.values(pair); server.accept();
    const peer = { send: (text: string) => server.send(text), close: (code: number, reason: string) => server.close(code, reason) };
    const auth = setTimeout(() => { if (!run.peers.has(peer)) server.close(1008, 'Authentication timeout'); }, 10000);
    let messages = 0, started = Date.now();
    server.addEventListener('message', event => { if (Date.now() - started > 1000) { messages = 0; started = Date.now(); } if (++messages > 60) { server.close(1008, 'Rate limit'); return; } if (typeof event.data === 'string') void run.message(peer, event.data).catch(() => server.close(1011)); });
    server.addEventListener('close', () => { clearTimeout(auth); void run.disconnect(peer).catch(() => {}); });
    server.addEventListener('error', () => { server.close(1011); });
    const headers = request.headers.get('Sec-WebSocket-Protocol')?.split(',').some(p => p.trim() === 'glush') ? { 'Sec-WebSocket-Protocol': 'glush' } : undefined;
    return new Response(null, { status: 101, webSocket: client, headers });
  }
}
export class CreateGate extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const key = await request.text(), day = new Date().toISOString().slice(0, 10);
    return this.ctx.storage.transaction(async tx => {
      const state = await tx.get<{ day: string; total: number; ips: Record<string, number> }>('limits') ?? { day, total: 0, ips: {} };
      if (state.day !== day) { state.day = day; state.total = 0; state.ips = {}; }
      if (state.total >= 25 || (state.ips[key] ?? 0) >= 5) return json({ error: 'Лимит новых миров на сегодня. Продолжи сохранённый мир.' }, 429);
      state.total++; state.ips[key] = (state.ips[key] ?? 0) + 1; await tx.put('limits', state); return json({ ok: true });
    });
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin'), allowed = (env.ALLOWED_ORIGINS ?? '').split(',');
    if (origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403);
    const cors = (response: Response): Response => {
      if (response.status === 101) return response;
      const r = new Response(response.body, response); if (origin) r.headers.set('Access-Control-Allow-Origin', origin);
      r.headers.set('Vary', 'Origin'); r.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Glush-Test-Key'); r.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); return r;
    };
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health') return cors(json({ ok: true, protocol: 1 }));
      if (!await hasTestAccess(request.headers, env.GLUSH_TEST_KEY_HASH)) return cors(json({ error: ACCESS_ERROR }, 401));
      if (url.pathname === '/access' && request.method === 'GET') return cors(json({ ok: true }));
      if (url.pathname === '/worlds' && request.method === 'POST') {
        const body = await request.text(); if (body.length > 4096) return cors(json({ error: 'Request too large' }, 413));
        const data = createWorldSchema.parse(JSON.parse(body));
        const gate = await env.GATE.getByName('create').fetch(new Request('https://internal/limit', { method: 'POST', body: await hashKey(request.headers.get('CF-Connecting-IP') ?? 'unknown') }));
        if (!gate.ok) return cors(gate);
        const id = crypto.randomUUID(), invite = makeKey();
        return cors(await env.ROOMS.getByName(id).fetch(new Request('https://internal/initialize', { method: 'POST', body: JSON.stringify({ ...data, id, invite }) })));
      }
      const match = url.pathname.match(/^\/worlds\/([a-f0-9-]{36})\/(socket|export)$/);
      if (match && request.method === 'GET') return cors(await env.ROOMS.getByName(match[1]).fetch(request));
      return cors(json({ error: 'Not found' }, 404));
    } catch { return cors(json({ error: 'Не удалось выполнить запрос. Попробуй позже.' }, 400)); }
  },
} satisfies ExportedHandler<Env>;
