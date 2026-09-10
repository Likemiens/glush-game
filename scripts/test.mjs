import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const temp = await mkdtemp(join(tmpdir(), 'quietwood-test-'));
try {
  const bundle = join(temp, 'game.mjs');
  await build({ stdin: { contents: "export * from './src/game/world.ts'; export * from './src/game/simulation.ts'; export * from './src/game/storage.ts'; export * from './src/game/campaign.ts'; export * from './src/game/inventory.ts'; export * from './src/game/commands.ts'; export * from './src/game/snapshot.ts'; export { trackOpacity } from './src/game/renderer.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: bundle });
  const { World, Simulation, SIZE, WORLD_SIZE, TILE, Terrain, angleDifference, saveGame, loadGame, createCampaign, makeExpedition, buyUpgrade, regionLock, CARGO, REGIONS, UPGRADES, levelLimit, activeContracts, trackOpacity, pack, snapshot, execute } = await import(pathToFileURL(bundle));
  const idle = { x: 0, y: 0, boost: false, brake: false, dash: false, interact: false, pulse: false };
  let count = 0;
  const test = (name, fn) => { fn(); count++; console.log('PASS ' + name); };
  const tick = (sim, controls = {}) => { sim.update(1 / 60, { ...idle, ...controls }); sim.events = []; };
  const ticks = (sim, n, controls = {}) => { for (let i = 0; i < n; i++) tick(sim, controls); };
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const item = (kind, id = 0) => ({ kind, id, condition: 100, ttl: kind === 'volatile' ? 75 : 0 });
  const flat = (terrain = Terrain.Meadow) => {
    const w = new World('test'); w.tiles.fill(terrain); w.wisps.length = 0; w.wrecks.length = 0;
    const sim = new Simulation(w); sim.launch(); sim.car.angle = 0; return sim;
  };
  test('Seed and region deterministically generate different landscapes', () => {
    const a = new World('Ива-123'), b = new World('Ива-123');
    assert.deepEqual(a.tiles, b.tiles); assert.deepEqual(a.caches, b.caches); assert.deepEqual(a.wrecks, b.wrecks);
    assert.notDeepEqual(a.tiles, new World('Ива-124').tiles); assert.notDeepEqual(a.tiles, new World('Ива-123', 1).tiles);
    assert(new World('Ива-123', 2).tiles.includes(Terrain.Ice));
  });
  test('112 worlds across seven biomes have intact foot sites and accessible pickups', () => {
    for (let seed = 0; seed < 16; seed++) for (let region = 0; region < REGIONS.length; region++) {
      const w = new World('route-' + seed, region), sim = new Simulation(w);
      assert(w.drivable(sim.car.x, sim.car.y)); assert.equal(w.caches.length, 8);
      assert.equal(new Set(w.caches.map(c => c.x + ',' + c.y)).size, 8);
      for (const site of w.sites) {
        assert(w.drivable(site.entrance.x, site.entrance.y));
        for (let y = site.y; y <= site.entrance.y; y += 2) assert(w.walkable(site.x, y), 'Foot gate blocked');
        assert(!w.drivable(site.x, site.y + 4 * TILE));
        for (let i = -4; i <= 4; i++) for (const [x, y] of [[i, -4], [-4, i], [4, i], [i, 4]]) {
          if (x === 0 && y === 4) continue;
          assert(!w.walkable(site.x + x * TILE, site.y + y * TILE), 'Broken wall ' + seed + '/' + region);
        }
      }
      for (const cache of w.caches) assert(w.walkable(cache.x, cache.y));
      for (const wreck of w.wrecks) assert(w.drivable(wreck.x, wreck.y, 4));
      for (const wisp of w.wisps) assert(w.drivable(wisp.x, wisp.y));
    }
  });
  test('Acceleration, diagonal speed, turning, turbo and energy regeneration', () => {
    const a = flat(), b = flat(); b.car.angle = Math.PI / 4;
    ticks(a, 90, { x: 1 }); ticks(b, 90, { x: 1, y: 1 });
    assert(a.car.speed > 115); assert(Math.abs(a.player.distance - b.player.distance) < .01);
    assert(Math.abs(angleDifference(-Math.PI + .05, Math.PI - .05) - .1) < 1e-6);
    const turbo = flat(); ticks(turbo, 120, { x: 1, boost: true });
    assert(turbo.car.speed > 190); assert(turbo.player.energy < .55); assert(turbo.tracks.length > 80);
    ticks(turbo, 420); assert.equal(turbo.player.energy, 1); assert(turbo.car.speed < .01);
  });
  test('Handbrake creates a lateral slide and stronger tracks', () => {
    const a = flat(), b = flat(); ticks(a, 60, { x: 1 }); ticks(b, 60, { x: 1 });
    ticks(a, 15, { y: 1 }); ticks(b, 15, { y: 1, brake: true });
    const lateral = sim => Math.abs(-sim.car.vx * Math.sin(sim.car.angle) + sim.car.vy * Math.cos(sim.car.angle));
    assert(b.car.drifting); assert(lateral(b) > lateral(a) + 5); assert(b.tracks.some(t => t.strong));
    ticks(b, 180, { y: 1, brake: true }); assert(b.car.speed < 60);
  });
  test('Exiting parks the car; foot dash preserves it; E enters again', () => {
    const sim = flat(); ticks(sim, 60, { x: 1 }); sim.interact(); assert(!sim.driving);
    const parked = { ...sim.car }; ticks(sim, 12, { y: 1 }); tick(sim, { dash: true }); ticks(sim, 8);
    assert(distance(sim.player, parked) > 20); assert.equal(distance(sim.car, parked), 0);
    sim.route = [parked]; ticks(sim, 120); assert(sim.nearCar); sim.interact(); assert(sim.driving);
  });
  test('Heavy cargo slows the car; engine upgrades improve loaded speed', () => {
    const empty = flat(), heavy = flat(), improved = flat();
    heavy.cargo.push(item('heavy')); improved.cargo.push(item('heavy')); improved.campaign.upgrades.engine = 1;
    for (const sim of [empty, heavy, improved]) ticks(sim, 90, { x: 1 });
    assert(heavy.car.speed < empty.car.speed * .85); assert(improved.car.speed > heavy.car.speed * 1.12); assert.equal(heavy.usedSlots, 4);
  });
  test('Pickup requires walking, carrying and loading; a second item cannot be carried', () => {
    const sim = flat(), cache = sim.world.caches[0];
    Object.assign(sim.car, {x:cache.x,y:cache.y}); Object.assign(sim.player, {x:cache.x,y:cache.y});
    sim.interact(); assert(!cache.collected); sim.interact(); assert(cache.collected && sim.carried); assert.equal(sim.cargo.length,0);
    sim.interact(); assert.equal(sim.cargo.length,1); assert(!sim.carried); sim.interact(); assert(sim.driving);
    const full=flat(); full.cargo=Array.from({length:6},(_,i)=>item('scrap',i)); assert(pack(full.cargo,full.rows));
    full.driving=false; full.carried=full.makeCargo(99,'heavy'); assert(!full.loadCarried()); assert(full.carried); assert(full.full && full.returning);
    full.campaign.upgrades.rack=2; assert(full.loadCarried()); assert.equal(full.usedSlots,16);
  });
  test('Fast rough driving damages optics; slow driving and padding protect them', () => {
    const fast = flat(Terrain.Stone), slow = flat(Terrain.Stone), padded = flat(Terrain.Stone);
    for (const sim of [fast, slow, padded]) sim.cargo.push(item('fragile')); padded.campaign.upgrades.rack = 2;
    ticks(fast, 240, { x: 1 }); ticks(slow, 240, { x: .45 }); ticks(padded, 240, { x: 1 });
    assert(fast.cargo[0].condition < 85); assert.equal(slow.cargo[0].condition, 100);
    assert(padded.cargo[0].condition > fast.cargo[0].condition + 5); assert(fast.score < slow.score);
  });
  test('Unstable cells expire once; prompt delivery retains full value', () => {
    const sim = flat(); sim.cargo.push(item('volatile')); sim.cargo[0].ttl = .1;
    ticks(sim, 7); assert.equal(sim.cargo[0].ttl, 0); assert.equal(sim.hull, 86); assert(sim.score < 15);
    ticks(sim, 60); assert.equal(sim.hull, 86);
    const fresh = flat(); fresh.cargo.push(item('volatile')); fresh.finish(); assert.equal(fresh.receipt.credits, CARGO.volatile.value);
  });
  test('Mud slows cars and leaves deep tracks; tires help; ice keeps momentum', () => {
    const road = flat(), mud = flat(Terrain.Mud), tires = flat(Terrain.Mud), ice = flat(Terrain.Ice);
    tires.campaign.upgrades.tires = 1;
    for (const sim of [road, mud, tires, ice]) ticks(sim, 120, { x: 1 });
    assert(mud.car.speed < road.car.speed * .4); assert(tires.car.speed > mud.car.speed * 1.45);
    assert(mud.tracks.every(t => t.mud && t.maxLife === 18 && t.life > 15)); ticks(road, 30); ticks(ice, 30); assert(ice.car.speed > road.car.speed * 5);
  });
  test('Water currents move idle cars and are stronger in the marsh', () => {
    const sim = flat(Terrain.Water), before = { ...sim.player }; ticks(sim, 120);
    assert(sim.player.x - before.x > 10); assert(sim.tracks.some(t => t.water));
    const marsh = new World('test', 1); marsh.tiles.fill(Terrain.Water);
    assert(Math.hypot(...Object.values(marsh.current(1000, 1000))) > Math.hypot(...Object.values(sim.world.current(1000, 1000))));
  });
  test('Walls and boundaries block fast cars; collisions damage hull', () => {
    const sim = flat(), tx = Math.floor(sim.car.x / TILE) + 8;
    for (let y = 0; y < SIZE; y++) sim.world.tiles[y * SIZE + tx] = Terrain.Wall;
    ticks(sim, 120, { x: 1, boost: true }); assert(sim.hull < 100); assert(sim.world.drivable(sim.car.x, sim.car.y)); assert(sim.car.x < tx * TILE);
    const edge = flat(); ticks(edge, 600, { x: 1, boost: true }); assert(edge.car.x < WORLD_SIZE - 24); assert(edge.world.drivable(edge.car.x, edge.car.y));
  });
  test('Signal strengthens nearby; scanner extends range; foot direction is precise', () => {
    const sim = flat(); sim.world.caches.splice(1); const cache = sim.world.caches[0];
    cache.x = sim.player.x + 230; cache.y = sim.player.y + 50;
    const distant = sim.signal; assert(distant); cache.x -= 100; assert(sim.signal.strength > distant.strength);
    const real = Math.atan2(cache.y - sim.player.y, cache.x - sim.player.x), carError = Math.abs(sim.signal.angle - real);
    sim.driving = false; assert(Math.abs(sim.signal.angle - real) < carError);
    cache.x += 350; assert(!sim.signal); sim.campaign.upgrades.scanner = 2; assert(sim.signal);
  });
  test('Q temporarily reveals a distant signal; B toggles home navigation', () => {
    const sim = flat(); sim.world.caches.splice(1); sim.world.caches[0].x = sim.player.x + 300; sim.world.caches[0].y = sim.player.y;
    assert(!sim.signal); tick(sim, { pulse: true }); assert(sim.signal); assert(sim.ripples.length);
    tick(sim, { home: true }); assert(sim.returning); tick(sim, { home: true }); assert(!sim.returning); ticks(sim, 190); assert(!sim.signal);
  });
  test('Night does not end the trip; storms move; shelters lower exposure', () => {
    const sim = flat(); sim.elapsed = 479.9; ticks(sim, 12); assert(sim.night > 0); assert(!sim.docked);
    sim.world.lamps.length = 0; sim.elapsed = 95; const before = sim.stormAt(sim.player); sim.elapsed = 120; assert.notEqual(sim.stormAt(sim.player), before);
    sim.exposure = 70; sim.world.lamps.push({ ...sim.player }); sim.memory.lamps=[1]; sim.world.lamps.push({ ...sim.player }); const light = sim.visibilityRadius; ticks(sim, 120); assert(sim.exposure < 47);
    sim.world.lamps.length = 0; sim.elapsed = 600; assert(sim.visibilityRadius < light);
    const unlit = sim.visibilityRadius; sim.campaign.upgrades.lamps = 2; assert(sim.visibilityRadius > unlit);
  });
  test('Failure loses only trip rewards, preserves bank and upgrades, and repairs next day', () => {
    const sim = flat(); sim.campaign.credits = 180; sim.campaign.upgrades.engine = 1; sim.cargo.push(item('relic')); sim.rescued = 0;
    sim.exposure = 100; sim.hull = .01; sim.world.lamps.length = 0; sim.elapsed = 600; tick(sim);
    assert(sim.docked && sim.failed); assert.equal(sim.campaign.credits, 180); assert.equal(sim.campaign.upgrades.engine, 1);
    assert.equal(sim.campaign.delivered, 0); assert.equal(sim.campaign.rescued, 0); assert(!sim.campaign.relics[0]);
    sim.finish(); assert.equal(sim.campaign.credits, 180); assert.equal(sim.cargo.length, 0);
    const next = makeExpedition(sim.campaign); assert.equal(next.hull, 100); assert.equal(next.player.energy, 1);
  });
  test('Towing only completes at the destination; circling and reattachment do not pay', () => {
    const sim=flat(); sim.car.x=sim.player.x=sim.world.camp.x+200;
    const wreck={ x:sim.car.x-22,y:sim.car.y,origin:{x:sim.car.x-22,y:sim.car.y},trail:[],attached:false,rescued:false,progress:0,vx:0,vy:0,tension:0 };
    sim.world.wrecks.push(wreck); sim.interact(); sim.interact(); assert(wreck.attached); sim.interact();
    for(let i=0;i<3600;i++) tick(sim,{x:Math.cos(i/180),y:Math.sin(i/180)});
    assert(!wreck.rescued); assert.equal(sim.rescued,0);
    wreck.attached=true; wreck.attachedTo=sim.actorId;
    Object.assign(wreck,{x:sim.world.rescueZone.x+38,y:sim.world.rescueZone.y,vx:0,vy:0});
    Object.assign(sim.car,{x:wreck.x-30,y:wreck.y,angle:Math.PI}); Object.assign(sim.player,sim.car);
    ticks(sim,120,{x:-1}); assert(wreck.rescued); assert.equal(sim.campaign.credits,0);
    sim.finish(); assert.equal(sim.campaign.rescued,1); assert(sim.receipt.credits>=80); const bank=sim.campaign.credits; sim.finish(); assert.equal(sim.campaign.credits,bank);
  });
  test('Winch upgrades improve towing; excessive tension releases the rope', () => {
    const make = level => { const sim = flat(Terrain.Mud); sim.car.x = sim.player.x += 200; sim.campaign.upgrades.winch = level;
      sim.world.wrecks.push({ x: sim.car.x - 30, y: sim.car.y, origin: { x: sim.car.x - 30, y: sim.car.y }, trail: [], attached: true, rescued: false, progress: 0, vx:0,vy:0,tension:0 }); return sim; };
    const a = make(0), b = make(2); ticks(a, 90, { x: 1 }); ticks(b, 90, { x: 1 });
    assert(b.car.speed > a.car.speed * 1.1);
    a.world.wrecks[0].x -= 300; tick(a); assert(!a.world.wrecks[0].attached); assert(!a.rescued);
  });
  test('Purchases spend resources atomically and technology unlocks cap all eight branches at five', () => {
    const c = createCampaign(); assert(!buyUpgrade(c, 'engine')); c.credits = 240;
    assert(buyUpgrade(c, 'engine')); assert.equal(c.credits, 160); assert(!buyUpgrade(c, 'engine'));
    c.research = 1; assert(buyUpgrade(c, 'engine')); assert.equal(c.credits, 10); assert.equal(c.research, 0);
    c.credits = 999; c.research = 9; assert(!buyUpgrade(c, 'engine')); assert.equal(c.credits, 999);
    c.relics.fill(true); c.credits = 100000; c.research = 1000; assert.equal(levelLimit(c), 5);
    for (const id of Object.keys(UPGRADES)) { while (c.upgrades[id] < 5) assert(buyUpgrade(c, id)); assert(!buyUpgrade(c, id)); }
    assert.equal(Object.values(c.upgrades).reduce((a,b) => a+b,0), 40);
  });
  test('Deliveries award contracts once, unlock regions, and restore unique relays', () => {
    const c = createCampaign(); assert(regionLock(c, 1)); assert(regionLock(c, 2));
    let sim = makeExpedition(c); sim.launch(); sim.cargo.push(item('scrap'), item('fragile', 1), item('heavy', 2)); sim.finish();
    assert.equal(c.delivered, 3); assert.equal(c.credits, 300); assert.equal(c.research, 2); assert(c.claimed[0]);
    assert(buyUpgrade(c, 'tires')); assert.equal(regionLock(c, 1), '');
    sim = makeExpedition(c, 1); sim.launch(); sim.cargo.push(item('relic', 5)); sim.finish();
    assert(c.relics[1]); assert(c.claimed[2]); assert(buyUpgrade(c, 'lamps')); assert(buyUpgrade(c, 'scanner'));
    assert.equal(regionLock(c, 2), ''); assert(makeExpedition(c, 1).world.caches[5].collected);
    for (const region of [0, 2]) { sim = makeExpedition(c, region); sim.launch(); sim.cargo.push(item('relic', 5)); sim.finish(); }
    assert(c.relics.slice(0, 3).every(Boolean)); assert(c.claimed[3]); const credits = c.credits; sim.finish(); assert.equal(c.credits, credits);
  });
  test('Repair pickups work once, map discovery is monotonic, and effects are bounded', () => {
    const sim = flat(); sim.hull = 60; sim.world.wisps.push({ ...sim.player, collected: false, phase: 0 }); tick(sim); assert.equal(sim.hull, 80);
    tick(sim); assert.equal(sim.hull, 80); const explored = sim.world.exploredCount; ticks(sim, 60, { x: 1 }); assert(sim.world.exploredCount > explored);
    const track = sim.tracks[0], alpha = trackOpacity(track); sim.updateEffects(1); assert(trackOpacity(track) < alpha);
    sim.updateEffects(5); assert(trackOpacity(track) < alpha * .5); sim.updateEffects(18); assert.equal(sim.tracks.length, 0); assert.equal(trackOpacity(track), 0);
    sim.burst(sim.player.x, sim.player.y, '#fff', 1000); sim.updateEffects(.01); assert.equal(sim.particles.length, 420);
    assert.equal(sim.world.explored.reduce((a, b) => a + b, 0), sim.world.exploredCount);
  });

  // Integration paths use collision-checked geometry and the normal analog movement controls.
  const navigate = (sim, target, stop = 5) => {
    const w = sim.world, pass = sim.driving ? (x, y) => w.drivable(x, y) : (x, y) => w.walkable(x, y);
    const index = p => Math.floor(p.y / TILE) * SIZE + Math.floor(p.x / TILE);
    const point = i => ({ x: (i % SIZE + .5) * TILE, y: (Math.floor(i / SIZE) + .5) * TILE });
    const start = index(sim.player), end = index(target), parents = new Int32Array(SIZE * SIZE).fill(-1), queue = [start]; parents[start] = start;
    for (let n = 0; n < queue.length && parents[end] < 0; n++) for (const d of [1, -1, SIZE, -SIZE]) {
      const next = queue[n] + d; if (next < 0 || next >= parents.length || parents[next] >= 0) continue;
      const p = point(next); if (!pass(p.x, p.y)) continue; parents[next] = queue[n]; queue.push(next);
    }
    assert(parents[end] >= 0, 'No navigable route');
    const path = []; for (let i = end; i !== start; i = parents[i]) path.unshift(point(i)); path.push(target);
    const clear = (from, to) => { const n = Math.ceil(distance(from, to) / 2); for (let i = 1; i <= n; i++) if (!pass(from.x + (to.x - from.x) * i / n, from.y + (to.y - from.y) * i / n)) return false; return true; };
    while (path.length) {
      let furthest = 0; for (let i = 1; i < path.length; i++) if (clear(sim.player, path[i])) furthest = i;
      const destination = path[furthest]; path.splice(0, furthest + 1); let budget = 6000;
      while (distance(sim.player, destination) > (path.length ? sim.driving ? 9 : 3 : stop) && budget-- > 0 && !sim.docked) {
        const d = distance(sim.player, destination), turn = Math.abs(angleDifference(Math.atan2(destination.y-sim.player.y,destination.x-sim.player.x),sim.car.angle)), amount = Math.min(sim.driving && turn>.5 ? .15 : 1, d / (sim.driving ? 28 : 12));
        const current = sim.driving ? {x:0,y:0} : w.current(sim.player.x, sim.player.y), footSpeed = (w.at(sim.player.x, sim.player.y) === Terrain.Water ? 31 : 54) * (sim.carried ? sim.carried.kind==='heavy' ? .55 : .75 : 1);
        tick(sim, { x: (destination.x - sim.player.x) / d * amount - current.x * .4 / footSpeed, y: (destination.y - sim.player.y) / d * amount - current.y * .4 / footSpeed });
        assert(pass(sim.player.x, sim.player.y), 'Actor crossed a wall');
      }
      assert(budget > 0 && !sim.docked, 'Navigation stuck near ' + JSON.stringify(destination) + ' from ' + sim.player.x + ',' + sim.player.y + ' region ' + w.region + ' driving ' + sim.driving + ' hull ' + sim.hull + ' elapsed ' + sim.elapsed + ' docked ' + sim.docked);
    }
  };
  const fetchAndReturn = (sim, id) => {
    const cache = sim.world.caches[id], site = sim.world.sites.find(s => s.x === cache.x && s.y === cache.y);
    navigate(sim, site ? site.entrance : cache, 12); sim.interact(); assert(!sim.driving);
    navigate(sim, cache, 8); sim.interact(); assert(cache.collected); navigate(sim, sim.car, 12); sim.interact(); assert(!sim.carried); sim.interact(); assert(sim.driving);
    navigate(sim, sim.world.camp, 25); sim.interact(); assert(sim.docked && !sim.failed); assert.equal(sim.receipt.delivered, 1);
  };
  test('24 expeditions drive, exit, collect and return without teleporting', () => {
    let longest = 0;
    for (let i = 0; i < 24; i++) { const sim = makeExpedition(createCampaign(i === 0 ? 'MOSS-0842' : 'expedition-' + i)); sim.launch(); fetchAndReturn(sim, 0); longest = Math.max(longest, sim.elapsed); }
    console.log('  Longest first delivery: ' + longest.toFixed(1) + ' seconds');
  });
  test('Full seven-biome campaign: unique loot funds required upgrades and every relay is reachable', () => {
    const c = createCampaign(); let sim;
    const required = [{}, {tires:1}, {lamps:1,scanner:1}, {engine:2,tires:2}, {engine:3,battery:2}, {armor:3,lamps:3}, {scanner:4,lamps:4}];
    for (let region = 0; region < REGIONS.length; region++) {
      for (const [id, target] of Object.entries(required[region])) while(c.upgrades[id] < target) assert(buyUpgrade(c, id), 'Cannot afford '+id+' before region '+region+'; bank '+c.credits+'/'+c.research);
      assert.equal(regionLock(c, region), '');
      for (const id of [0, 1, 2, 3, 4, 5, 6, 7]) {
        sim = makeExpedition(c, region); execute(sim, {type:'radio',index:0}); sim.launch(); assert(!sim.world.caches[id].collected); fetchAndReturn(sim, id);
        assert(makeExpedition(c, region).world.caches[id].collected, 'Cargo respawned');
      }
      if (region === 0) {
        sim = makeExpedition(c, region); execute(sim,{type:'radio',index:0}); sim.launch();
        for (const lamp of sim.world.lamps.slice(1)) {
          navigate(sim,lamp,12);sim.interact();navigate(sim,lamp,8);sim.interact();
          navigate(sim,sim.car,12);execute(sim,{type:'board'});assert(sim.driving);
        }
        navigate(sim,sim.world.camp,25);sim.interact();assert(sim.docked);assert.equal(c.regions[0].lamps.length,3);
        execute(sim,{type:'radio',index:0});execute(sim,{type:'radio',index:0});
      }
    }
    assert.equal(c.progression.radio.chapters[0],4);
    assert(c.relics.every(Boolean)); assert(c.claimed[19]); assert(c.credits > 0); assert.equal(c.delivered, 56);
    console.log('  Campaign: ' + c.expeditions + ' deliveries, ' + c.credits + ' credits left, all relays restored');
  });
  test('Save restores cargo, parked car, upgrades and map; reload cannot duplicate rewards', () => {
    const values = new Map(); globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    const sim = makeExpedition(createCampaign('save-лес')); sim.launch(); ticks(sim, 120, { x: 1 }); sim.interact(); ticks(sim, 20, { y: -1 });
    sim.world.caches[1].collected = true; sim.cargo.push(item('fragile', 1)); sim.campaign.credits = 250; sim.campaign.upgrades.rack = 1; sim.elapsed = 600;
    sim.world.wrecks[0].attached = true; sim.world.wrecks[0].progress = 56;
    assert(saveGame(sim)); const restored = loadGame(); assert(restored);
    assert(restored.world.wrecks[0].attached); assert.equal(restored.world.wrecks[0].progress, 56);
    assert.equal(restored.player.x, sim.player.x); assert.equal(restored.car.y, sim.car.y); assert(!restored.driving); assert.equal(restored.cargo[0].kind, 'fragile');
    assert.equal(restored.campaign.credits, 250); assert(restored.night > 0); assert.deepEqual(restored.world.explored, sim.world.explored);
    restored.finish(); assert(saveGame(restored)); const docked = loadGame(); assert(docked?.docked); assert.deepEqual(docked.receipt, restored.receipt); const credits = docked.campaign.credits; docked.finish(); assert.equal(docked.campaign.credits, credits);
    const valid = values.get('quietwood:campaign:v5');
    for (const mutate of [v => { v.trip.wrecks = []; }, v => { v.trip.hull = -5; }, v => { v.campaign.upgrades.engine = 9; }, v => { v.campaign.survey[0] = 'bad'; }]) {
      const data = JSON.parse(valid); mutate(data); values.delete('quietwood:campaign:v5:backup'); values.set('quietwood:campaign:v5', JSON.stringify(data)); assert.equal(loadGame(), undefined);
    }
    values.delete('quietwood:campaign:v5:backup'); values.set('quietwood:campaign:v5', '{'); assert.equal(loadGame(), undefined);
    globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.equal(loadGame(), undefined); assert.equal(saveGame(sim), false);
  });
  const memoryStore = () => {
    const values = new Map(); globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; return values;
  };
  test('Delivered cargo, rescued cars and repair pickups stay depleted after relaunch, region switch and reload', () => {
    memoryStore(); const c = createCampaign('persistent'), sim = makeExpedition(c); sim.launch();
    fetchAndReturn(sim, 0); sim.world.wrecks[0].rescued = true; sim.world.wisps[0].collected = true; assert(saveGame(sim));
    const restored = loadGame(); assert(restored); const next = makeExpedition(restored.campaign); next.launch();
    assert(next.world.caches[0].collected); assert(next.world.wrecks[0].rescued); assert(next.world.wisps[0].collected);
    const elsewhere = makeExpedition(next.campaign, 1); assert(!elsewhere.world.caches[0].collected); assert(saveGame(elsewhere));
    assert(makeExpedition(loadGame().campaign, 0).world.caches[0].collected);
    assert.deepEqual(new World('persistent', 0, 1).caches.map(c=>c.kind), new World('persistent',0,2).caches.map(c=>c.kind));
  });
  test('A full trunk shows home; dropping one item frees space without respawning the source', () => {
    const sim=flat(); sim.cargo=Array.from({length:6},(_,i)=>sim.makeCargo(i,'scrap')); assert(pack(sim.cargo,sim.rows));
    assert(sim.full); assert(sim.dropCargo(0)); assert(!sim.full); assert.equal(sim.memory.drops.length,1); sim.driving=false;
    Object.assign(sim.player,sim.memory.drops[0]); sim.interact(); assert(sim.carried); assert.equal(sim.memory.drops.length,0); assert(sim.loadCarried()); assert(sim.full && sim.returning);
  });
  test('Armor and battery upgrades change survival, cell lifetime and boost endurance', () => {
    const c = createCampaign(); c.upgrades.armor = 5; c.upgrades.battery = 5;
    const sim = makeExpedition(c); assert.equal(sim.hull,200); sim.launch(); sim.driving=false;
    Object.assign(sim.player, sim.world.caches[3]); sim.interact(); assert.equal(sim.carried.ttl,270);
    const a = flat(), b = flat(); b.campaign.upgrades.battery=5; ticks(a,120,{x:1,boost:true}); ticks(b,120,{x:1,boost:true}); assert(b.player.energy > a.player.energy+.15);
    const exposed = flat(), armored = flat(); armored.campaign.upgrades.armor=5;
    for(const x of [exposed,armored]) {x.world.lamps.length=0;x.exposure=100;x.elapsed=600;ticks(x,30);}
    assert(armored.hull > exposed.hull);
  });
  test('Lamps are restored once; distinct radio deliveries fund an exhausted district', () => {
    const c=createCampaign(); c.regions[0].taken=[0,1,2,3,4,5,6,7]; c.regions[0].rescued=[0,1];
    let sim=makeExpedition(c); sim.launch();
    for(const lamp of sim.world.lamps.slice(1)) {
      navigate(sim,lamp,10); sim.interact(); navigate(sim,lamp,8); sim.interact();
      navigate(sim,sim.car,12); sim.interact(); assert(sim.driving);
    }
    assert(sim.patrolComplete); navigate(sim,sim.world.camp,25); sim.interact(); const bank=c.credits;
    sim=makeExpedition(c); sim.launch(); assert(sim.patrolComplete); const job={...sim.memory.job}; sim.finish(); assert.equal(c.credits,bank);
    sim=makeExpedition(c); sim.launch(); assert.deepEqual(sim.memory.job,job);
    navigate(sim,job,12); sim.interact(); navigate(sim,job,8); sim.interact(); assert(sim.carried); navigate(sim,sim.car,12); sim.interact(); sim.interact();
    navigate(sim,sim.world.camp,25); sim.interact(); assert(c.credits>bank); assert(c.regions[0].job.delivered);
    sim=makeExpedition(c); sim.launch(); assert(sim.memory.job.id>job.id); assert.equal(c.stats.patrols,1);
  });
  test('A lost relay heart remains recoverable while ordinary lost cargo stays depleted', () => {
    const sim=makeExpedition(createCampaign()); sim.launch(); sim.world.caches[5].collected=true; sim.world.caches[0].collected=true;
    sim.cargo.push(item('relic',5), item('scrap',0)); sim.finish(true);
    const next=makeExpedition(sim.campaign); assert(next.world.caches[5].collected); assert(next.world.caches[0].collected); assert(!next.campaign.relics[0]); assert.equal(next.memory.drops.length,2);
  });
  test('Quest chains unlock gradually; repeat settlement never pays twice', () => {
    const c=createCampaign(); assert.equal(activeContracts(c).length,3);
    c.relics[0]=true; c.relics[1]=true; c.delivered=4; c.stats.fragile=2; c.stats.nightRuns=1;
    const before=activeContracts(c).length; assert(before>3); let sim=makeExpedition(c); sim.launch(); sim.finish();
    assert(c.claimed[4] && c.claimed[9]); const bank=c.credits;
    sim=makeExpedition(c); sim.launch(); sim.finish(); assert.equal(c.credits,bank);
  });
  const legacySave = sim => {
    sim.rememberWorld(); const data=snapshot(sim);
    return {version:4,campaign:data.campaign,trip:{...data.trip,energy:sim.player.energy,caches:sim.world.caches.map(c=>({collected:c.collected,discovered:c.discovered,kind:c.kind})),wisps:sim.world.wisps.map(w=>w.collected)}};
  };
  test('V3 and V4 migration retain property, terrain, known lamps and a complete backup', () => {
    for(const version of [3,4]) {
      const values=memoryStore(), c=createCampaign('legacy'); c.credits=340;c.research=4;c.upgrades.winch=1;c.upgrades.rack=2;c.day=2;
      const sim=makeExpedition(c);sim.launch();sim.world.caches[4].kind='volatile';sim.world.caches[4].collected=true;sim.cargo.push(item('volatile',4));sim.checkedLamps=[1];
      const legacy=legacySave(sim); legacy.version=version;
      if(version===3) {
        for(const key of ['relics','survey'])legacy.campaign[key]=legacy.campaign[key].slice(0,3);legacy.campaign.claimed=legacy.campaign.claimed.slice(0,4);
        delete legacy.campaign.upgrades.armor;delete legacy.campaign.upgrades.battery;
        for(const key of ['regions','scouted','stats'])delete legacy.campaign[key];delete legacy.trip.checkedLamps;legacy.trip.caches.forEach(c=>delete c.kind);
      }
      const original=JSON.stringify(legacy); values.set('quietwood:campaign:v'+version,original); const restored=loadGame(); assert(restored);
      assert.equal(restored.campaign.credits,340);assert.equal(restored.campaign.research,4);assert.equal(restored.campaign.upgrades.winch,1);assert.equal(restored.capacity,20);
      assert.equal(restored.cargo[0].kind,'volatile');assert(restored.cargo[0].placement);assert(restored.memory.taken.includes(4));
      assert.deepEqual(restored.world.tiles,sim.world.tiles); if(version===4) assert.deepEqual(restored.memory.lamps,[1]);
      assert.equal(values.get('quietwood:before-v5'),original);assert(saveGame(restored));assert(loadGame());assert(values.has('quietwood:campaign:v'+version));
    }
  });
  test('V5 keeps restored light; invalid saves are rejected and a valid checkpoint recovers', () => {
    const values=memoryStore(), sim=makeExpedition(createCampaign());sim.launch();sim.checkedLamps=[1,2];assert(saveGame(sim));assert.deepEqual(loadGame().checkedLamps,[1,2]);
    const valid=values.get('quietwood:campaign:v5');
    for(const mutate of [v=>v.trip.checkedLamps=[1,1],v=>v.trip.checkedLamps=[0],v=>v.campaign.regions[0].taken=[99],v=>v.campaign.regions[0].rescued=[0,0],v=>v.version='5']) {
      const data=JSON.parse(valid);mutate(data);values.delete('quietwood:campaign:v5:backup');values.set('quietwood:campaign:v5',JSON.stringify(data));assert.equal(loadGame(),undefined);
    }
    values.set('quietwood:campaign:v5:backup',valid); assert(loadGame());
  });
  console.log('\n' + count + ' checks passed.');
} finally {
  if (!temp.startsWith(join(tmpdir(), 'quietwood-test-'))) throw new Error('Unexpected test output path');
  await rm(temp, { recursive: true, force: true });
}
