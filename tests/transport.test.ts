import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { makeKey, type ActorFrame, type ServerMessage } from '../src/net/protocol';
import type { Command } from '../src/game/commands';
import { World } from '../src/game/world';
import type { WorldState } from '../server/room';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 8000): Promise<void> {
  const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw Error('Timed out waiting for game state'); await delay(25); }
}
class Driver {
  socket: WebSocket; id = ''; frame?: ActorFrame; seq = 0; operation = 0; errors: string[] = []; acks = new Set<string>();
  constructor(server: string, room: string, key: string, invite?: string, name = 'Test driver') {
    this.socket = new WebSocket(server.replace('http:', 'ws:') + `/worlds/${room}/socket`);
    this.socket.on('open', () => this.socket.send(JSON.stringify({ type: 'hello', version: 1, key, invite, name })));
    this.socket.on('message', text => {
      const m = JSON.parse(text.toString()) as ServerMessage;
      if (m.type === 'error') this.errors.push(m.message);
      else if (m.type === 'ack') this.acks.add(m.id);
      else { if (m.type === 'welcome') this.id = m.playerId; this.frame = m.actors.find(a => a.id === this.id); if (this.frame) this.operation = Math.max(this.operation, this.frame.ackCommand); }
    });
  }
  input(x = 0, y = 0) { this.socket.send(JSON.stringify({ type: 'input', seq: ++this.seq, controls: { x, y, brake: !x && !y, boost: false, dash: false, pulse: false, interact: false } })); }
  async command(command: Command) { const id = `${this.id}:${++this.operation}`; this.socket.send(JSON.stringify({ type: 'command', id, command })); await until(() => this.acks.has(id)); return id; }
  async move(target: { x: number; y: number }, stop = 9) {
    const start = Date.now();
    while (Math.hypot(this.frame!.trip.player.x - target.x, this.frame!.trip.player.y - target.y) > stop) {
      if (Date.now() - start > 18000) throw Error('Route timed out');
      const p = this.frame!.trip.player, dx = target.x - p.x, dy = target.y - p.y, d = Math.hypot(dx, dy), amount = Math.min(1, d / 35);
      this.input(dx / d * amount, dy / d * amount); await delay(55);
    }
    this.input(); await delay(300);
  }
  close() { this.socket.terminate(); }
}

const external = process.env.GLUSH_TEST_SERVER;
test(external ? 'Five real clients complete a delivery on the Cloudflare adapter' : 'Five real WebSocket clients complete a delivery; reconnect, process restart and SQLite import retain it', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'glush-network-')), port = 18879, server = external ?? `http://127.0.0.1:${port}`;
  let process: ChildProcess | undefined, clients: Driver[] = [], output = '';
  const env = { ...globalThis.process.env, PORT: String(port), GLUSH_DATA_DIR: directory, GLUSH_TEST_MODE: '1' };
  async function start(dataDir = directory) {
    if (external) return;
    output = ''; process = spawn(globalThis.process.execPath, ['--import', 'tsx', 'server/node.ts'], { cwd: globalThis.process.cwd(), env: { ...env, GLUSH_DATA_DIR: dataDir }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout?.on('data', chunk => { output += String(chunk); }); process.stderr?.on('data', chunk => { output += String(chunk); });
    await until(() => output.includes('GLUSH server'), 10000);
  }
  async function stop() { if (!process || process.exitCode !== null) return; const exited = once(process, 'exit'); process.kill('SIGTERM'); await exited; }
  try {
    await start();
    const keys = Array.from({ length: 5 }, () => makeKey());
    const response = await fetch(server + '/worlds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: keys[0], name: 'Ada', seed: 'MOSS-0842' }) });
    assert(response.ok); const { id, invite } = await response.json() as { id: string; invite: string };
    clients = keys.map((key, i) => new Driver(server, id, key, invite, ['Ada', 'Lev', 'Mira', 'Yuki', 'Nika'][i]));
    await until(() => clients.every(c => !!c.frame));
    await Promise.all(clients.map(c => c.command({ type: 'depart', region: 0 }))); await until(() => clients.every(c => !c.frame!.trip.docked));
    const world = new World('MOSS-0842'), cache = world.caches[0];
    await Promise.all(clients.map(c => c.move(cache, 13)));
    await Promise.all(clients.map(c => c.command({ type: 'interact' })));
    await Promise.all(clients.map(c => c.move(cache, 8)));
    await Promise.all(clients.map(c => c.command({ type: 'interact' })));
    const winner = clients.find(c => c.frame?.trip.carried); assert(winner); assert.equal(clients.filter(c => c.frame?.trip.carried).length, 1);
    await winner.command({ type: 'load' }); await winner.command({ type: 'interact' });
    for (const c of clients.filter(c => c !== winner)) if (!c.frame!.trip.driving) await c.command({ type: 'interact' });
    await Promise.all(clients.map(c => c.move(world.camp, 25)));
    await Promise.all(clients.map(c => c.command({ type: 'interact' }))); assert(clients.every(c => c.frame!.trip.docked));
    const bank = winner.frame!.profile.credits; assert(bank > 0); assert(clients.every(c => c.frame!.profile.credits === bank));
    const exportResponse = await fetch(`${server}/worlds/${id}/export`, { headers: { Authorization: 'Bearer ' + keys[4] } });
    assert(exportResponse.ok); const saved = await exportResponse.json() as WorldState; assert.equal(saved.campaign.delivered, 1); assert(saved.campaign.regions[0].taken.includes(0));
    assert.equal((await fetch(`${server}/worlds/${id}/export`, { headers: { Authorization: 'Bearer ' + invite } })).status, 403);
    if (external) {
      await mkdir('test-results', {recursive:true});
      await writeFile('test-results/cloud-world.json',JSON.stringify(saved));
      await writeFile('test-results/cloud-resume.json',JSON.stringify({server,id,invite,key:keys[4],bank}));
      const imported = spawn(globalThis.process.execPath, ['--import','tsx','server/node.ts','--import',join(globalThis.process.cwd(),'test-results/cloud-world.json')], {env,windowsHide:true});
      const [code] = await once(imported,'exit');assert.equal(code,0,'Public Cloudflare export imports into Node SQLite');
      clients[0].close();await delay(250);await clients[4].command({type:'lights'});
      for(const c of clients)c.close();clients=[];await delay(300);
      const back=new Driver(server,id,keys[4]);clients.push(back);await until(()=>!!back.frame);assert.equal(back.frame!.profile.credits,bank);
      return;
    }
    clients[0].close(); await delay(250); await clients[4].command({ type: 'lights' });
    for (const c of clients) c.close(); clients = []; await delay(300); await stop();
    await start(); const resumed = new Driver(server, id, keys[4]); clients.push(resumed); await until(() => !!resumed.frame); assert.equal(resumed.frame!.profile.credits, bank);
    const duplicate = `${resumed.id}:${resumed.frame!.ackCommand}`; resumed.socket.send(JSON.stringify({ type: 'command', id: duplicate, command: { type: 'upgrade', id: 'engine' } }));
    await until(() => resumed.acks.has(duplicate)); assert.equal(resumed.frame!.profile.credits, bank);
    await resumed.command({ type: 'depart', region: 0 }); assert(!resumed.frame!.trip.docked);
    assert.deepEqual(resumed.errors, []); resumed.close(); clients = []; await delay(250); await stop();
    const exportPath = join(directory, 'world.json'); await writeFile(exportPath, JSON.stringify(saved));
    const importedDir = join(directory, 'imported');
    const imported = spawn(globalThis.process.execPath, ['--import', 'tsx', 'server/node.ts', '--import', exportPath], { env: { ...env, GLUSH_DATA_DIR: importedDir }, windowsHide: true });
    const [exitCode] = await once(imported, 'exit'); assert.equal(exitCode, 0);
    await start(importedDir); const moved = new Driver(server, id, keys[4]); clients.push(moved); await until(() => !!moved.frame); assert.equal(moved.frame!.profile.credits, bank);
    const roundTrip = await (await fetch(`${server}/worlds/${id}/export`, { headers: { Authorization: 'Bearer ' + keys[4] } })).json() as WorldState;
    assert.deepEqual(roundTrip.campaign.regions, saved.campaign.regions); assert.equal(roundTrip.players.length, 5);
  } catch (error) { console.error(output.slice(-4000)); throw error; }
  finally {
    for (const c of clients) c.close(); await delay(100); await stop();
    if (!directory.startsWith(join(tmpdir(), 'glush-network-'))) throw Error('Unexpected temporary directory');
    await rm(directory, { recursive: true, force: true });
  }
});
