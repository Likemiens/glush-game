import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaign, REGIONS } from '../src/game/campaign';
import { execute } from '../src/game/commands';
import { cells, fits, pack } from '../src/game/inventory';
import { Simulation, type Controls } from '../src/game/simulation';
import { restoreSnapshot, snapshot } from '../src/game/snapshot';
import { headlightField, lightKey } from '../src/game/lighting';
import { World, Terrain, SIZE, TILE } from '../src/game/world';
import { makeExpedition } from '../src/game/storage';
import { Room } from '../server/room';
import { RoomRuntime, type Peer } from '../server/runtime';
import { hashKey, makeKey } from '../src/net/protocol';

const idle: Controls = { x: 0, y: 0, boost: false, brake: true, pulse: false, dash: false, interact: false };
const flat = () => { const sim = makeExpedition(createCampaign('mechanics')); sim.world.tiles.fill(Terrain.Meadow); sim.launch(); return sim; };
const update = (sim: Simulation, seconds: number, controls = idle) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) { sim.update(1 / 60, controls); sim.events = []; } };
const place = (sim: Simulation, p: { x: number; y: number }) => { Object.assign(sim.car, p, { speed: 0, vx: 0, vy: 0 }); Object.assign(sim.player, p, { vx: 0, vy: 0 }); };

test('Grid packing, all rotations, blocked moves and overflow preserve every cargo identity', () => {
  const sim = flat(); sim.cargo = [sim.makeCargo(0, 'heavy'), sim.makeCargo(1, 'relic'), sim.makeCargo(2, 'scrap')];
  assert(pack(sim.cargo, 3)); const original = structuredClone(sim.cargo);
  assert(!sim.moveCargo(0, { x: 3, y: 2, rotation: 0 })); assert.deepEqual(sim.cargo, original);
  for (let rotation = 0; rotation < 4; rotation++) {
    const shape = cells('relic', rotation); assert.equal(new Set(shape.map(String)).size, 3);
    assert(fits([], sim.cargo[1], { x: 0, y: 0, rotation }, 3));
  }
  const overflow = Array.from({ length: 4 }, (_, i) => sim.makeCargo(i, 'heavy'));
  assert(!pack(overflow, 3)); assert(overflow.every(i => !i.placement));
  assert(sim.moveCargo(2, { x: 2, y: 2, rotation: 1 }));
  assert.deepEqual(sim.cargo.map(i => i.uid), original.map(i => i.uid));
});

test('Headlights remain on the parked vehicle, obey walls and combine without overexposure', () => {
  const sim = flat(); place(sim, { x: 1100, y: 1100 }); sim.car.angle = 0;
  const source = { ...sim.car, headlights: true, level: 2, flood: false };
  const lit = headlightField(sim.world, [source]); assert(lit.has(lightKey(1140, 1100))); assert(!lit.has(lightKey(1060, 1100)));
  assert.deepEqual(headlightField(sim.world, Array(5).fill(source)), lit);
  assert.equal(headlightField(sim.world, [{ ...source, headlights: false }]).size, 0);
  for (let y = 0; y < SIZE; y++) sim.world.tiles[y * SIZE + 96] = Terrain.Wall;
  assert(!headlightField(sim.world, [source]).has(lightKey(1170, 1100)));
  sim.interact(); assert(!sim.driving); update(sim, .5, { ...idle, x: -1 }); assert.equal(sim.car.x, 1100);
});

test('112 worlds have reachable rare scenes, radio deliveries and evacuation posts', () => {
  let shortest = Infinity;
  for (let seed = 0; seed < 16; seed++) for (let region = 0; region < REGIONS.length; region++) {
    const w = new World('reach-' + seed, region), visited = new Uint8Array(SIZE * SIZE);
    const index = (p: { x: number; y: number }) => Math.floor(p.y / TILE) * SIZE + Math.floor(p.x / TILE);
    const queue = [index(w.camp)]; visited[queue[0]] = 1;
    for (let i = 0; i < queue.length; i++) for (const delta of [1, -1, SIZE, -SIZE]) {
      const n = queue[i] + delta; if (n < 0 || n >= visited.length || visited[n]) continue;
      if (!w.drivable((n % SIZE + .5) * TILE, (Math.floor(n / SIZE) + .5) * TILE)) continue;
      visited[n] = 1; queue.push(n);
    }
    for (const p of [w.rare, w.rescueZone, ...w.wrecks, ...[1, 2, 3].map(i => w.findClearing('job:' + i, 500 + i % 3 * 150))]) assert(visited[index(p)], `Unreachable ${seed}/${region}`);
    for (const wreck of w.wrecks) shortest = Math.min(shortest, Math.hypot(wreck.x - w.rescueZone.x, wreck.y - w.rescueZone.y));
  }
  assert(shortest > 950, `Rescue too short: ${shortest}`);
});

test('Rescue lasts over a minute, persists its position and only settles at the safe post', () => {
  const sim = flat(), wreck = sim.world.wrecks[0], destination = sim.world.rescueZone;
  const angle = Math.atan2(destination.y - wreck.y, destination.x - wreck.x);
  place(sim, { x: wreck.x + Math.cos(angle) * 28, y: wreck.y + Math.sin(angle) * 28 }); sim.car.angle = angle;
  wreck.attached = true; wreck.attachedTo = sim.actorId;
  update(sim, 35, { ...idle, x: Math.cos(angle), y: Math.sin(angle), brake: false });
  assert(!wreck.rescued); sim.rememberWorld(); const position = { x: wreck.x, y: wreck.y };
  const next = makeExpedition(sim.campaign); assert.equal(next.world.wrecks[0].x, position.x);
  const restored = restoreSnapshot(snapshot(sim)); restored.world.tiles.fill(Terrain.Meadow); const saved = restored.world.wrecks[0];
  assert(saved.attached); assert.equal(saved.y, position.y);
  update(restored, 140, { ...idle, x: Math.cos(angle), y: Math.sin(angle), brake: false });
  assert(saved.rescued); assert.equal(restored.rescued, 1);
});

test('Fresh tracks fade; the same route only becomes worn after three separate trips', () => {
  let sim = flat(); const c = sim.campaign, start = { ...sim.car };
  for (let trip = 0; trip < 3; trip++) {
    if (trip) { sim = new Simulation(sim.world, c); sim.launch(); }
    place(sim, start); sim.car.angle = 0; update(sim, 2, { ...idle, brake: false, x: 1 });
    const key = `${Math.floor((start.x + 30) / 24)}:${Math.floor(start.y / 24)}`;
    assert.equal(sim.memory.roads[key], trip + 1);
    update(sim, 2, { ...idle, brake: false, x: -1 }); assert.equal(sim.memory.roads[key], trip + 1);
    sim.updateEffects(20); assert.equal(sim.tracks.length, 0);
    sim.finish(true); // Each actual expedition is a separate day, even after evacuation.
    sim = makeExpedition(c); sim.world.tiles.fill(Terrain.Meadow);
  }
});

test('Last signal is optional, unique per expedition and never consumes the story', () => {
  const sim = flat(); sim.elapsed = 451; update(sim, .1); assert.equal(sim.expedition.last.phase, 'offered');
  const chapters = [...sim.campaign.progression.radio.chapters]; sim.answerLast(true); sim.answerLast(true);
  assert.equal(sim.memory.drops.filter(d => d.item.uid?.includes(':last:')).length, 1);
  update(sim, 121); assert.equal(sim.expedition.last.phase, 'expired'); assert.equal(sim.memory.drops.length, 0);
  assert.deepEqual(sim.campaign.progression.radio.chapters, chapters);
});

test('Hunter gives warning, spawns away from every player and retreats from restored light', () => {
  const sim = flat(); place(sim, { x: 1450, y: 1450 }); sim.elapsed = 310; sim.expedition.hunter.noise = 30;
  sim.observers = [{ x: 1900, y: 1450 }]; update(sim, .1);
  const h = sim.expedition.hunter; assert.equal(h.state, 'warning');
  for (const p of [sim.player, ...sim.observers]) assert(Math.hypot(p.x - h.x, p.y - h.y) > 550);
  update(sim, 8.1); assert.equal(h.state, 'search');
  place(sim, sim.world.camp); update(sim, .1); assert.equal(h.state, 'retreat'); assert.equal(sim.hull, 100);
});

test('Modules are mutually exclusive and rules preserve basic movement and solo access', () => {
  const sim = flat(); sim.finish(); sim.campaign.relics.fill(true); sim.campaign.credits = 5000;
  execute(sim, { type: 'module', id: 'rack' }); assert.equal(sim.rows, 4);
  execute(sim, { type: 'module', id: 'padding' }); assert.equal(sim.rows, 3); assert.equal(sim.campaign.progression.owned.length, 2);
  const bank = sim.campaign.credits; execute(sim, { type: 'module', id: 'rack' }); assert.equal(sim.campaign.credits, bank);
  execute(sim, { type: 'rule', id: 'silent' }); sim.launch(); update(sim, .1, { ...idle, pulse: true }); assert.equal(sim.pulseCooldown, 0);
  sim.expedition.rule = 'battery'; place(sim, { x: 1700, y: 1600 }); sim.player.energy = .2; update(sim, 1); assert.equal(sim.player.energy, .2);
  place(sim, sim.world.camp); update(sim, 1); assert(sim.player.energy > .2);
});

test('A complete four-chapter radio chain rewards once and keeps an archive', () => {
  const c = createCampaign(); let sim = makeExpedition(c);
  for (let chapter = 0; chapter < 4; chapter++) {
    execute(sim, { type: 'radio', index: 0 });
    if (chapter === 0) c.delivered = 3;
    if (chapter === 1) c.regions[0].lamps = [1, 2, 3];
    if (chapter === 2) c.relics[0] = true;
    if (chapter === 3) c.relics.fill(true);
    sim = makeExpedition(c); sim.launch(); sim.finish();
    assert.equal(c.progression.radio.chapters[0], chapter + 1);
    const bank = c.credits; sim.finish(); assert.equal(c.credits, bank);
  }
  assert.equal(c.progression.radio.archive.length, 4); assert(!c.progression.radio.accepted[0]);
});

async function crew() {
  const invite = makeKey(), room = new Room(crypto.randomUUID(), await hashKey(invite), 'crew-test');
  const keys = Array.from({ length: 5 }, () => makeKey());
  const players = [];
  for (const [i, key] of keys.entries()) players.push(await room.join(key, invite, 'Driver ' + i));
  const command = (i: number, command: Parameters<Room['command']>[2]) => { const p = players[i]; room.command(p.id, `${p.id}:${p.lastCommand + 1}`, command); };
  for (let i = 0; i < 5; i++) command(i, { type: 'depart', region: 0 });
  return { room, players, keys, invite, command };
}

test('Five players arbitrate one pickup, transfer cargo and share rewards exactly once', async () => {
  const { room, players, command } = await crew(); assert(players.every(p => !p.sim.docked));
  const cache = room.world.caches[0];
  for (const p of players) { place(p.sim, cache); p.sim.driving = false; }
  for (let i = 0; i < 5; i++) command(i, { type: 'interact' });
  assert.equal(players.filter(p => p.sim.carried).length, 1); assert(cache.collected);
  command(0, { type: 'load' }); assert.equal(players[0].sim.cargo.length, 1);
  command(0, { type: 'drop', index: 0 }); assert.equal(room.campaign.regions[0].drops.length, 1);
  players[1].sim.driving = false; command(1, { type: 'interact' }); command(1, { type: 'load' }); assert.equal(players[1].sim.cargo.length, 1);
  assert.equal(players[0].sim.cargo.length, 0); assert.equal(room.campaign.regions[0].drops.length, 0);
  const p = players[1]; place(p.sim, room.world.camp); p.sim.elapsed = 10; command(1, { type: 'interact' });
  assert(p.sim.docked); const bank = p.sim.campaign.credits; assert(bank > 0);
  assert(players.every(p => p.sim.campaign.credits === bank));
  room.command(p.id, `${p.id}:${p.lastCommand}`, { type: 'interact' }); assert.equal(p.sim.campaign.credits, bank);
  command(1, { type: 'depart', region: 0 }); assert(!p.sim.docked); assert(room.world.caches[0].collected);
  assert.equal(room.campaign.delivered, 1);
});

test('Creator leaves, fifth player resumes after restart, cargo survives 30s grace and all-offline freezes', async () => {
  const { room, players, keys, invite, command } = await crew(); const first = players[0];
  await assert.rejects(() => room.join(makeKey(), invite, 'Sixth'), /пять/);
  place(first.sim, room.world.caches[0]); first.sim.driving = false; command(0, { type: 'interact' }); command(0, { type: 'load' });
  const cargo = first.sim.cargo[0].uid; room.leave(first.id);
  for (let i = 0; i < 29 * 60; i++) room.step(); assert(!first.sim.docked);
  for (let i = 0; i < 2 * 60; i++) room.step(); assert(first.sim.docked); assert(room.campaign.regions[0].drops.some(d => d.item.uid === cargo));
  for (const p of players) room.leave(p.id); const elapsed = room.elapsed; for (let i = 0; i < 600; i++) room.step(); assert.equal(room.elapsed, elapsed);
  const saved = room.export(), restored = Room.restore(saved); await restored.join(keys[4], undefined, 'Driver 4');
  assert.equal(restored.participants.size, 5); assert.equal(restored.campaign.regions[0].drops[0].item.uid, cargo);
  assert.equal(restored.players.get(first.id)?.online, false); restored.step(); assert(restored.elapsed > elapsed);
  const repeat = Room.restore(restored.export()); assert.equal(repeat.players.size, 5);
});

test('Station readiness, private upgrades and late-player equipment survive export/import', async () => {
  const { room, players, keys, invite, command } = await crew();
  command(0, { type: 'evacuate' }); command(0, { type: 'depart', region: 1 }); assert(players[0].sim.docked);
  for (let i = 1; i < 5; i++) command(i, { type: 'evacuate' });
  room.campaign.relics[0] = true; players[0].sim.campaign.delivered = 3; players[0].sim.campaign.credits = 1000; command(0, { type: 'upgrade', id: 'tires' });
  assert.equal(players[0].sim.campaign.upgrades.tires, 1); assert.equal(players[1].sim.campaign.upgrades.tires, 0);
  command(0, { type: 'depart', region: 1 }); assert(players.every(p => p.sim.docked));
  for (let i = 1; i < 5; i++) command(i, { type: 'depart', region: 1 }); assert(players.every(p => !p.sim.docked)); assert.equal(room.world.region, 1);
  room.leave(players[0].id); const newcomer = await room.join(makeKey(), invite, 'Late friend'); assert(newcomer.sim.docked); assert(newcomer.sim.campaign.upgrades.tires >= 1);
  const imported = Room.restore(room.export()); const old = await imported.join(keys[0], undefined, 'Driver 0');
  assert.equal(old.sim.campaign.upgrades.tires, 1); assert.equal(old.sim.world.region, 1);
});

test('Acknowledgements follow storage, duplicate commands are harmless and failure pauses authority', async () => {
  const invite = makeKey(), key = makeKey(), room = new Room(crypto.randomUUID(), await hashKey(invite));
  const commits: ReturnType<Room['export']>[] = [], messages: Record<string, unknown>[] = []; let fail = false, closed = false;
  const runtime = new RoomRuntime(room, async state => { if (fail) throw Error('disk full'); commits.push(structuredClone(state)); });
  const peer: Peer = { send: text => messages.push(JSON.parse(text)), close: () => { closed = true; } };
  try {
    await runtime.message(peer, JSON.stringify({ type: 'hello', version: 1, key, invite, name: 'Driver' }));
    const player = [...room.players.values()][0], id = player.id + ':1';
    await runtime.message(peer, JSON.stringify({ type: 'command', id, command: { type: 'depart', region: 0 } }));
    assert(messages.some(m => m.type === 'ack' && m.id === id)); assert.equal(commits.at(-1)?.players[0].lastCommand, 1);
    const count = room.players.size; await runtime.message(peer, JSON.stringify({ type: 'command', id, command: { type: 'depart', region: 0 } })); assert.equal(room.players.size, count);
    fail = true; await runtime.message(peer, JSON.stringify({ type: 'command', id: player.id + ':2', command: { type: 'lights' } }));
    assert(closed); assert(!messages.some(m => m.type === 'ack' && m.id === player.id + ':2'));
    assert.equal(commits.at(-1)?.players[0].lastCommand, 1);
  } finally { runtime.stop(); }
});

test('Full and awkward trunks allow boarding after leaving an oversized item on the ground', () => {
  const sim = flat(); place(sim, { x: 1100, y: 1100 }); sim.driving = false;
  sim.cargo = Array.from({length:6}, (_, i) => sim.makeCargo(i, 'scrap')); assert(pack(sim.cargo, sim.rows));
  sim.carried = sim.makeCargo(900, 'heavy', 'test'); assert(sim.dropCargo());
  assert.equal(sim.interaction, 'СЕСТЬ'); sim.interact(); assert(sim.driving); assert.equal(sim.memory.drops.length,1);
  sim.driving=false; sim.cargo.pop(); execute(sim,{type:'board'}); assert(sim.driving);
  assert.equal(sim.memory.drops.length,1);
});

test('Station radio can acknowledge previous deeds immediately and pays the crew once', async () => {
  const {room, players, command} = await crew();
  for(let i=0;i<5;i++) command(i,{type:'evacuate'});
  players[0].sim.campaign.delivered=3;
  const before=players.map(p=>p.sim.campaign.credits);
  command(0,{type:'radio',index:0});
  assert.equal(room.campaign.progression.radio.chapters[0],1);
  assert(players.every((p,i)=>p.sim.campaign.credits===before[i]+120));
  command(0,{type:'radio',index:0});
  assert(players.every((p,i)=>p.sim.campaign.credits===before[i]+120));
  const bad=room.export();bad.players[1].id=bad.players[0].id;
  assert.throws(()=>Room.restore(bad),/Duplicate/);
});

test('A driver delivered to safety still counts if the tow vehicle is later lost', () => {
  const sim=flat();sim.rescued=1;sim.world.wrecks[0].rescued=true;sim.rememberWorld();
  sim.finish(true);assert.equal(sim.campaign.rescued,1);assert(sim.receipt!.credits>=80);
  assert(sim.memory.rescued.includes(0));const bank=sim.campaign.credits;sim.finish(true);assert.equal(sim.campaign.credits,bank);
});
