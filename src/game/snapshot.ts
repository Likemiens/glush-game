import { z } from 'zod';
import { Simulation } from './simulation';
import { SIZE, World } from './world';
import { pack, fits } from './inventory';
import { CARGO, CONTRACTS, UPGRADES } from './campaign';
import { MODULES, RULES } from './features';
const num = z.number().finite();
const count = num.int().min(0).max(100000000);
const coord = num.min(24).max(2280);
const point = z.object({ x: coord, y: coord });
const indices = (max: number) => z.array(count.max(max)).max(max + 1).refine(a => new Set(a).size === a.length);
const cargoKind = z.enum(['scrap', 'heavy', 'fragile', 'volatile', 'relic']);
const moduleId = z.enum(['winch', 'plow', 'scanner', 'light', 'rack', 'padding', 'battery', 'rescue']);
export const cargoSchema = z.object({ id: count, uid: z.string().min(1).max(100), region: count.max(6), kind: cargoKind, condition: num.min(0).max(100), ttl: num.min(0).max(1000), placement: z.object({ x: count.max(3), y: count.max(8), rotation: count.max(3) }).optional() });
const ground = point.extend({ item: cargoSchema });
const roadMap = z.record(z.string().regex(/^\d{1,2}:\d{1,2}$/), count).refine(m => Object.keys(m).length <= 9216);
const memorySchema = z.object({
  taken: indices(7), rescued: indices(1), wisps: indices(21), lamps: indices(3).refine(a => !a.includes(0)), discovered: indices(7),
  wrecks: z.array(point.extend({ progress: num.min(0).max(100) })).max(2), roads: roadMap, roadTrips: roadMap,
  drops: z.array(ground).max(500), rare: z.boolean(), rareSeen: z.boolean(), sequence: count, lastDay: num.int().min(-1).max(1000000),
  job: point.extend({ id: count, kind: z.enum(['scrap', 'fragile', 'heavy']), taken: z.boolean(), delivered: z.boolean() }).nullable(),
});
export const campaignSchema = z.object({
  seed: z.string().min(1).max(40), day: count.min(1).max(1000000), credits: count, research: count, delivered: count, rescued: count, expeditions: count, earned: count,
  upgrades: z.object({ engine: count.max(5), tires: count.max(5), lamps: count.max(5), rack: count.max(5), scanner: count.max(5), winch: count.max(5), armor: count.max(5), battery: count.max(5) }),
  relics: z.array(z.boolean()).length(7), claimed: z.array(z.boolean()).length(CONTRACTS.length), survey: z.array(z.string().max(50000)).length(7), regions: z.array(memorySchema).length(7), scouted: z.array(count.max(SIZE * SIZE)).length(7),
  stats: z.object({ fragile: count, volatile: count, heavy: count, patrols: count, cleanRuns: count, nightRuns: count }),
  progression: z.object({ radio: z.object({ chapters: z.array(count.max(4)).length(3), accepted: z.array(z.boolean()).length(3), archive: z.array(z.string().max(500)).max(200) }), owned: z.array(moduleId).max(8), modules: z.object({ front: moduleId.optional(), roof: moduleId.optional(), cargo: moduleId.optional(), rear: moduleId.optional() }), rule: z.enum(['normal', 'night', 'fog', 'fragile', 'convoy', 'battery', 'silent']), rareCount: count.max(7) }),
}).refine(c => Object.entries(c.progression.modules).every(([slot, id]) => MODULES[id].slot === slot && c.progression.owned.includes(id)));
export const expeditionSchema = z.object({ rule: z.enum(['normal', 'night', 'fog', 'fragile', 'convoy', 'battery', 'silent']), hunter: z.object({ x: num.min(0).max(2304), y: num.min(0).max(2304), state: z.enum(['dormant', 'warning', 'search', 'chase', 'retreat']), timer: num.min(0).max(1000), noise: num.min(0).max(100), targetX: num.min(0).max(2304), targetY: num.min(0).max(2304) }), last: z.object({ phase: z.enum(['waiting', 'offered', 'accepted', 'declined', 'expired', 'done']), x: num.min(0).max(2304), y: num.min(0).max(2304), ttl: num.min(0).max(120) }) });
const receiptSchema = z.object({ credits: count, research: count, delivered: count, rescued: count, lost: z.boolean(), messages: z.array(z.string().max(500)).max(100) });
export const tripSchema = z.object({
  region: count.max(6), day: count.min(1).max(1000000), player: point.extend({ vx: num, vy: num, facing: num, stride: num, energy: num.min(0).max(1), dashTime: num, dashCooldown: num, distance: num }),
  car: point.extend({ vx: num, vy: num, angle: num, speed: num, boosting: z.boolean(), drifting: z.boolean() }),
  driving: z.boolean(), docked: z.boolean(), hull: num.min(0).max(200), exposure: num.min(0).max(100), elapsed: num.min(0).max(1e7), cargo: z.array(cargoSchema).max(18), carried: cargoSchema.nullable(),
  pulseTime: num.min(0).max(3).default(0), pulseCooldown: num.min(0).max(3).default(0), headlights: z.boolean(), rescued: count.max(2), checkedLamps: indices(3).refine(a => !a.includes(0)), activatedThisTrip: indices(3).refine(a => !a.includes(0)), returning: z.boolean(), failed: z.boolean(), receipt: receiptSchema.optional(),
  expedition: expeditionSchema, wrecks: z.array(point.extend({ rescued: z.boolean(), attached: z.boolean(), attachedTo: z.string().max(100).optional(), helpers: z.array(z.string().max(100)).max(4).optional(), progress: num.min(0).max(100), vx: num, vy: num, tension: num.min(0).max(1) })).length(2),
});
export const snapshotSchema = z.object({ version: z.literal(5), campaign: campaignSchema, trip: tripSchema });
export type GameSnapshot = z.infer<typeof snapshotSchema>;
export type TripSnapshot = z.infer<typeof tripSchema>;
export function surveyEncode(world: World): string { return btoa(String.fromCharCode(...world.explored)); }
export function surveyRestore(world: World, encoded: string): void {
  if (!encoded) return;
  const data = atob(encoded); if (data.length !== SIZE * SIZE || !/^[\x00\x01]+$/.test(data)) throw new Error('Invalid survey');
  for (let i = 0; i < data.length; i++) world.explored[i] |= data.charCodeAt(i);
  world.exploredCount = world.explored.reduce((a, b) => a + b, 0);
}
export function snapshot(sim: Simulation): GameSnapshot {
  sim.rememberWorld(); sim.campaign.survey[sim.world.region] = surveyEncode(sim.world);
  const normalize = (item: import('./inventory').CargoItem) => ({ ...item, uid: item.uid ?? `${sim.world.region}:cache:${item.id}`, region: item.region ?? sim.world.region });
  return structuredClone({ version: 5, campaign: { ...sim.campaign, regions: sim.campaign.regions.map((r, region) => ({ ...r, drops: r.drops.map(d => ({ ...d, item: { ...normalize(d.item), region: d.item.region ?? region, uid: d.item.uid ?? `${region}:cache:${d.item.id}` } })) })) }, trip: tripSnapshot(sim) });
}
export function tripSnapshot(sim: Simulation): TripSnapshot {
  const normalize = (item: import('./inventory').CargoItem) => ({ ...item, uid: item.uid ?? `${sim.world.region}:cache:${item.id}`, region: item.region ?? sim.world.region });
  return structuredClone({
    region: sim.world.region, day: sim.world.day, player: { ...sim.player }, car: { ...sim.car }, driving: sim.driving, docked: sim.docked,
    hull: sim.hull, exposure: sim.exposure, elapsed: sim.elapsed, cargo: sim.cargo.map(normalize), carried: sim.carried ? normalize(sim.carried) : null,
    pulseTime: sim.pulseTime, pulseCooldown: sim.pulseCooldown, headlights: sim.headlights, rescued: sim.rescued, checkedLamps: [...sim.memory.lamps], activatedThisTrip: sim.activatedThisTrip, returning: sim.returning, failed: sim.failed, receipt: sim.receipt, expedition: sim.expedition,
    wrecks: sim.world.wrecks.map(({ x, y, rescued, attached, attachedTo, helpers, progress, vx, vy, tension }) => ({ x, y, rescued, attached, attachedTo, helpers, progress, vx, vy, tension })),
  });
}
export function restoreSnapshot(raw: unknown): Simulation {
  const saved = snapshotSchema.parse(raw), { campaign, trip } = saved;
  const world = new World(campaign.seed, trip.region, trip.day); surveyRestore(world, campaign.survey[trip.region]);
  const sim = new Simulation(world, campaign); applyTrip(sim, trip);
  if (!world.walkable(sim.player.x, sim.player.y) || !world.drivable(sim.car.x, sim.car.y)) throw new Error('Invalid position');
  const all = [...sim.cargo, ...(sim.carried ? [sim.carried] : []), ...campaign.regions.flatMap(r => r.drops.map(d => d.item))];
  if (new Set(all.map(i => i.uid)).size !== all.length) throw new Error('Duplicate cargo');
  if (sim.cargo.some(i => !i.placement) && !pack(sim.cargo, sim.rows)) throw new Error('Cargo overflow');
  for (const item of sim.cargo) if (!item.placement || !fitsPlacement(sim, item)) throw new Error('Invalid cargo placement');
  if (trip.docked && (trip.cargo.length || trip.carried || trip.rescued)) throw new Error('Invalid docked cargo');
  return sim;
}
function fitsPlacement(sim: Simulation, item: import('./inventory').CargoItem): boolean { return !!item.placement && fits(sim.cargo, item, item.placement, sim.rows); }
export function applyTrip(sim: Simulation, trip: TripSnapshot): void {
  Object.assign(sim.player, trip.player); Object.assign(sim.car, trip.car);
  for (const key of ['pulseTime','pulseCooldown','driving', 'docked', 'hull', 'exposure', 'elapsed', 'cargo', 'carried', 'headlights', 'rescued', 'checkedLamps', 'activatedThisTrip', 'returning', 'failed', 'receipt', 'expedition'] as const) Object.assign(sim, { [key]: structuredClone(trip[key]) });
  sim.time = trip.elapsed; sim.remaining = Math.max(0, 480 - trip.elapsed);
  trip.wrecks.forEach((w, i) => Object.assign(sim.world.wrecks[i], w));
}
export const validUpgrade = (id: string): id is keyof typeof UPGRADES => Object.hasOwn(UPGRADES, id);
export const validRule = (id: string): id is keyof typeof RULES => Object.hasOwn(RULES, id);
export const validCargo = (id: string): id is keyof typeof CARGO => Object.hasOwn(CARGO, id);
