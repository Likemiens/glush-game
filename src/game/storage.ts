import { Simulation } from './simulation';
import { SIZE, World } from './world';
import { CARGO, CONTRACTS, createCampaign, MAX_LEVEL, REGIONS, UPGRADES } from './campaign';
import type { Campaign, CargoKind, UpgradeId } from './campaign';
import { restoreSnapshot, snapshot } from './snapshot';
import { createRegionMemory } from './features';
import { pack } from './inventory';

const SAVE_KEY = 'quietwood:campaign:v5';
const LEGACY_KEY = 'quietwood:campaign:v4';
const SETTINGS_KEY = 'quietwood:settings:v3';
export type Settings = { sound: boolean; music: number; effects: number; reducedMotion: boolean; zoom: number };
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown, min = 0, max = 1e8): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, min: number, max: number): v is number => finite(v, min, max) && Number.isInteger(v);
const flags = (v: unknown, length: number): v is boolean[] => Array.isArray(v) && v.length === length && v.every(x => typeof x === 'boolean');
const indices = (v: unknown, max: number): v is number[] => Array.isArray(v) && v.length <= max + 1 && v.every(i => integer(i, 0, max)) && new Set(v).size === v.length;

export function encodeSurvey(world: World): string { return btoa(String.fromCharCode(...world.explored)); }
export function restoreSurvey(world: World, encoded: string): boolean {
  try {
    if (!encoded) return true;
    if (encoded.length > SIZE * SIZE * 2) return false;
    const decoded = atob(encoded); if (decoded.length !== SIZE * SIZE || ![...decoded].every(c => c === '\0' || c === '\x01')) return false;
    for (let i = 0; i < decoded.length; i++) world.explored[i] |= decoded.charCodeAt(i);
    world.exploredCount = world.explored.reduce((sum, value) => sum + value, 0); return true;
  } catch { return false; }
}
export function makeExpedition(campaign: Campaign, region = 0): Simulation {
  const world = new World(campaign.seed, region, campaign.day);
  restoreSurvey(world, campaign.survey[region]);
  return new Simulation(world, campaign);
}
export function saveGame(sim: Simulation): boolean {
  try {
    if (sim.cargo.some(item => !item.placement)) pack(sim.cargo, sim.rows);
    const serialized = JSON.stringify(snapshot(sim));
    const previous = localStorage.getItem(SAVE_KEY);
    if (previous) localStorage.setItem(SAVE_KEY + ':backup', previous);
    localStorage.setItem(SAVE_KEY, serialized);
    return true;
  } catch { return false; }
}
export function loadGame(): Simulation | undefined {
  for (const key of [SAVE_KEY, SAVE_KEY + ':backup']) {
    try { const data = localStorage.getItem(key); if (data) return restoreSnapshot(JSON.parse(data)); } catch { /* Try the last complete checkpoint. */ }
  }
  const legacy = loadLegacy();
  if (legacy) {
    legacy.memory.lamps = [...legacy.checkedLamps]; legacy.activatedThisTrip = [];
    legacy.cargo.forEach(item => { item.uid = `${legacy.world.region}:cache:${item.id}`; item.region = legacy.world.region; });
    pack(legacy.cargo, legacy.rows); legacy.rememberWorld();
    try { const old = localStorage.getItem(LEGACY_KEY) ?? localStorage.getItem('quietwood:campaign:v3'); if (old) localStorage.setItem('quietwood:before-v5', old); } catch { /* The original version remains untouched. */ }
    saveGame(legacy);
  }
  return legacy;
}
function migrateLegacy(raw: Record<string, unknown>): boolean {
  if (!object(raw.campaign) || !object(raw.trip)) return false;
  const c = raw.campaign, t = raw.trip;
  if (!flags(c.relics, 3) || !flags(c.claimed, 4) || !Array.isArray(c.survey) || c.survey.length !== 3 || !object(c.upgrades)) return false;
  const fresh = createCampaign();
  c.relics = [...c.relics, false, false, false, false];
  c.claimed = [...c.claimed, ...fresh.claimed.slice(4)];
  c.survey = [...c.survey, '', '', '', ''];
  c.upgrades = { ...c.upgrades, armor: 0, battery: 0 };
  c.regions = fresh.regions; c.scouted = fresh.scouted; c.stats = fresh.stats;
  if (!indices(t.checkedLamps, 3) || t.checkedLamps.includes(0)) t.checkedLamps = [];
  if (integer(t.region, 0, 2) && Array.isArray(t.caches)) {
    fresh.regions[t.region].taken = t.caches.flatMap((cache, i) => object(cache) && cache.collected === true ? [i] : []);
    if (Array.isArray(t.wrecks)) fresh.regions[t.region].rescued = t.wrecks.flatMap((w, i) => object(w) && w.rescued === true ? [i] : []);
    if (Array.isArray(t.wisps)) fresh.regions[t.region].wisps = t.wisps.flatMap((w, i) => w === true ? [i] : []);
    t.caches.forEach((cache, i) => { if (object(cache)) cache.kind = i === 4 && typeof t.day === 'number' && t.day % 2 === 0 ? 'volatile' : ['scrap', 'fragile', 'heavy', 'volatile', 'scrap', 'relic', 'heavy', 'fragile'][i]; });
  }
  return true;
}
function loadLegacy(): Simulation | undefined {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? localStorage.getItem('quietwood:campaign:v3') ?? 'null');
    if (!object(raw) || raw.version !== 3 && raw.version !== 4 || !object(raw.campaign) || !object(raw.trip)) return;
    const legacy = raw.version === 3;
    if (legacy && !migrateLegacy(raw)) return;
    const saved = raw.campaign, trip = raw.trip;
    if (typeof saved.seed !== 'string' || saved.seed.length < 1 || saved.seed.length > 40 || !integer(saved.day, 1, 1e6)) return;
    const campaign = createCampaign(saved.seed), regionCount = REGIONS.length;
    for (const key of ['credits', 'research', 'delivered', 'rescued', 'expeditions', 'earned', 'day'] as const) { if (!integer(saved[key], key === 'day' ? 1 : 0, 1e8)) return; campaign[key] = saved[key]; }
    if (!object(saved.upgrades) || !flags(saved.relics, regionCount) || !flags(saved.claimed, CONTRACTS.length)) return;
    for (const id of Object.keys(UPGRADES) as UpgradeId[]) { if (!integer(saved.upgrades[id], 0, MAX_LEVEL)) return; campaign.upgrades[id] = saved.upgrades[id]; }
    if (!Array.isArray(saved.survey) || saved.survey.length !== regionCount || !saved.survey.every(s => typeof s === 'string' && s.length <= SIZE * SIZE * 2)) return;
    if (!Array.isArray(saved.regions) || saved.regions.length !== regionCount || !saved.regions.every(r => object(r) && indices(r.taken, 7) && indices(r.rescued, 1) && indices(r.wisps, 21))) return;
    if (!Array.isArray(saved.scouted) || saved.scouted.length !== regionCount || !saved.scouted.every(n => integer(n, 0, SIZE * SIZE)) || !object(saved.stats)) return;
    for (const key of Object.keys(campaign.stats) as (keyof Campaign['stats'])[]) { if (!integer(saved.stats[key], 0, 1e8)) return; campaign.stats[key] = saved.stats[key]; }
    campaign.relics = saved.relics; campaign.claimed = saved.claimed; campaign.survey = saved.survey; campaign.scouted = saved.scouted;
    campaign.regions = saved.regions.map(r => ({ ...createRegionMemory(), taken: [...r.taken], rescued: [...r.rescued], wisps: [...r.wisps] }));
    if (!integer(trip.region, 0, regionCount - 1) || !integer(trip.day, 1, campaign.day) || !object(trip.player) || !object(trip.car)) return;
    const world = new World(campaign.seed, trip.region, trip.day), sim = new Simulation(world, campaign);
    if (!restoreSurvey(world, campaign.survey[trip.region])) return;
    for (const key of ['x', 'y'] as const) if (!finite(trip.player[key], 0, 2304) || !finite(trip.car[key], 0, 2304)) return;
    if (!finite(trip.car.angle, -1e8, 1e8) || !world.walkable(trip.player.x as number, trip.player.y as number) || !world.drivable(trip.car.x as number, trip.car.y as number)) return;
    if (typeof trip.driving !== 'boolean' || typeof trip.docked !== 'boolean' || !finite(trip.elapsed, 0, 1e7) || !finite(trip.hull, 0, sim.maxHull) || !finite(trip.exposure, 0, 100) || !finite(trip.energy, 0, 1)) return;
    if (!Array.isArray(trip.caches) || trip.caches.length !== world.caches.length || !trip.caches.every(c => object(c) && typeof c.collected === 'boolean' && typeof c.discovered === 'boolean')) return;
    if (!flags(trip.wisps, world.wisps.length) || !Array.isArray(trip.wrecks) || trip.wrecks.length !== world.wrecks.length || !integer(trip.rescued, 0, world.wrecks.length)) return;
    if (!indices(trip.checkedLamps, 3) || trip.checkedLamps.includes(0)) return;
    for (let i = 0; i < world.caches.length; i++) {
      const cache = world.caches[i], data = trip.caches[i] as Record<string, unknown>;
      // v3 changed this one cache on even days; keep an already-loaded cell stable through migration.
      if (i === 4 && data.kind === 'volatile') cache.kind = 'volatile';
      if (data.kind !== undefined && data.kind !== cache.kind) return;
      cache.collected = cache.collected || data.collected === true; cache.discovered = data.discovered === true;
    }
    world.wisps.forEach((wisp, i) => { wisp.collected = wisp.collected || (trip.wisps as boolean[])[i]; });
    let attached = 0;
    for (let i = 0; i < trip.wrecks.length; i++) {
      const wreck = trip.wrecks[i];
      if (!object(wreck) || !finite(wreck.x, 24, 2280) || !finite(wreck.y, 24, 2280) || !finite(wreck.progress, 0, 100) || typeof wreck.rescued !== 'boolean' || typeof wreck.attached !== 'boolean' || !world.drivable(wreck.x, wreck.y, 4)) return;
      if (wreck.attached) attached++; if (wreck.rescued && wreck.attached) return;
      Object.assign(world.wrecks[i], { x: wreck.x, y: wreck.y, rescued: wreck.rescued || world.wrecks[i].rescued, attached: wreck.attached, progress: wreck.progress });
    }
    if (attached > 1 || !Array.isArray(trip.cargo) || trip.cargo.length > 8) return;
    const ids = new Set<number>();
    for (const item of trip.cargo) {
      if (!object(item) || !integer(item.id, 0, world.caches.length - 1) || typeof item.kind !== 'string' || !(item.kind in CARGO) || !finite(item.condition, 0, 100) || !finite(item.ttl, 0, 135)) return;
      if (ids.has(item.id) || world.caches[item.id].kind !== item.kind || !world.caches[item.id].collected) return;
      ids.add(item.id); sim.cargo.push({ id: item.id, kind: item.kind as CargoKind, condition: item.condition, ttl: item.ttl });
    }
    if (sim.usedSlots > sim.capacity || trip.docked && (sim.cargo.length > 0 || trip.rescued > 0)) return;
    Object.assign(sim.player, { x: trip.player.x, y: trip.player.y, energy: trip.energy });
    Object.assign(sim.car, { x: trip.car.x, y: trip.car.y, angle: trip.car.angle });
    sim.driving = trip.driving; sim.docked = trip.docked; sim.elapsed = trip.elapsed; sim.time = trip.elapsed; sim.remaining = Math.max(0, 480 - sim.elapsed);
    sim.hull = trip.hull; sim.exposure = trip.exposure; sim.rescued = trip.rescued; sim.checkedLamps = trip.checkedLamps; sim.returning = trip.returning === true || sim.full; sim.failed = trip.failed === true;
    if (sim.driving) { sim.player.x = sim.car.x; sim.player.y = sim.car.y; }
    const receipt = trip.receipt;
    if (sim.docked && object(receipt) && integer(receipt.credits, 0, 1e8) && integer(receipt.research, 0, 1e6) && integer(receipt.delivered, 0, 8) && integer(receipt.rescued, 0, 2) && typeof receipt.lost === 'boolean' && Array.isArray(receipt.messages) && receipt.messages.length <= 30 && receipt.messages.every(m => typeof m === 'string' && m.length <= 200)) {
      sim.receipt = { credits: receipt.credits, research: receipt.research, delivered: receipt.delivered, rescued: receipt.rescued, lost: receipt.lost, messages: receipt.messages };
    }
    sim.rememberWorld();
    return sim;
  } catch { return; }
}
export function readSettings(): Settings {
  const defaults: Settings = { sound: true, music: .55, effects: .65, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, zoom: 4 };
  try {
    const current = localStorage.getItem(SETTINGS_KEY);
    const data: unknown = JSON.parse(current ?? localStorage.getItem('quietwood:settings:v2') ?? '{}');
    if (!object(data)) return defaults;
    return { sound: typeof data.sound === 'boolean' ? data.sound : defaults.sound, music: finite(data.music, 0, 1) ? data.music : defaults.music, effects: finite(data.effects, 0, 1) ? data.effects : defaults.effects,
      reducedMotion: typeof data.reducedMotion === 'boolean' ? data.reducedMotion : defaults.reducedMotion, zoom: current && [2, 3, 4].includes(Number(data.zoom)) ? Number(data.zoom) : defaults.zoom };
  } catch { return defaults; }
}
export function storeSettings(settings: Settings): void { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Settings still apply to this session. */ } }
