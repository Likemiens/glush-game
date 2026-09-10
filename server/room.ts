import { z } from 'zod';
import { createCampaign, regionLock } from '../src/game/campaign';
import type { Campaign } from '../src/game/campaign';
import { Simulation } from '../src/game/simulation';
import type { Controls, GameEvent } from '../src/game/simulation';
import { World } from '../src/game/world';
import { execute } from '../src/game/commands';
import type { Command } from '../src/game/commands';
import { campaignSchema, tripSchema, tripSnapshot, applyTrip, surveyEncode, surveyRestore } from '../src/game/snapshot';
import { hashKey } from '../src/net/protocol';
import type { ActorFrame, PlayerProfile } from '../src/net/protocol';
import { fits } from '../src/game/inventory';

const idle = (): Controls => ({ x: 0, y: 0, boost: false, brake: true, dash: false, interact: false, pulse: false });
export const worldStateSchema = z.object({ version: z.literal(1), id: z.string().uuid(), inviteHash: z.string().regex(/^[a-f0-9]{64}$/), campaign: campaignSchema, region: z.number().int().min(0).max(6), day: z.number().int().positive(), tick: z.number().int().nonnegative(), elapsed: z.number().finite().nonnegative(), revision: z.number().int().nonnegative(), participants: z.array(z.string().uuid()).max(20).default([]), carTows: z.array(z.tuple([z.string().uuid(), z.string().uuid()])).max(5).default([]), players: z.array(z.object({ id: z.string().uuid(), keyHash: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(24), campaign: z.object({ credits: campaignSchema.shape.credits, research: campaignSchema.shape.research, earned: campaignSchema.shape.earned, upgrades: campaignSchema.shape.upgrades, progression: campaignSchema.shape.progression }), trip: tripSchema, lastCommand: z.number().int().nonnegative() })).max(20) });
export type WorldState = z.infer<typeof worldStateSchema>;
export type VehicleState = Simulation['car'];
export type PlayerState = { id: string; keyHash: string; name: string; sim: Simulation; controls: Controls; online: boolean; offlineAt: number; ready: number | null; lastInput: number; lastCommand: number; inputAge: number };
export class Room {
  campaign: Campaign;
  world: World;
  players = new Map<string, PlayerState>();
  tick = 0;
  elapsed = 0;
  revision = 0;
  dirty = true;
  events: GameEvent[] = [];
  pings: { x: number; y: number; label: string; ttl: number }[] = [];
  participants = new Set<string>();
  constructor(readonly id: string, readonly inviteHash: string, seed = 'GLUSH-' + id.slice(0, 8)) { this.campaign = createCampaign(seed); this.world = new World(seed); }
  static restore(raw: unknown): Room {
    const data = worldStateSchema.parse(raw), room = new Room(data.id, data.inviteHash, data.campaign.seed);
    const items = [...data.campaign.regions.flatMap(r => r.drops.map(d => d.item)), ...data.players.flatMap(p => [...p.trip.cargo, ...(p.trip.carried ? [p.trip.carried] : [])])];
    if (new Set(items.map(i => i.uid)).size !== items.length || new Set(data.players.map(p => p.id)).size !== data.players.length || new Set(data.players.map(p => p.keyHash)).size !== data.players.length) throw new Error('Duplicate identity or cargo');
    room.campaign = data.campaign; room.world = new World(data.campaign.seed, data.region, data.day); surveyRestore(room.world, data.campaign.survey[data.region]);
    room.tick = data.tick; room.elapsed = data.elapsed; room.revision = data.revision;
    for (const p of data.players) {
      const c = structuredClone(room.campaign); Object.assign(c, { credits: p.campaign.credits, research: p.campaign.research, earned: p.campaign.earned, upgrades: p.campaign.upgrades });
      c.progression = { ...p.campaign.progression, radio: room.campaign.progression.radio };
      const sim = new Simulation(room.world, c); applyTrip(sim, p.trip); sim.actorId = p.id;
      if (p.trip.region !== data.region || !room.world.walkable(sim.player.x, sim.player.y) || !room.world.drivable(sim.car.x, sim.car.y)) throw new Error('Invalid player position');
      if (sim.cargo.some(item => !item.placement || !fits(sim.cargo, item, item.placement, sim.rows)) || (sim.docked && (sim.cargo.length || sim.carried || sim.rescued))) throw new Error('Invalid cargo placement');
      room.players.set(p.id, { id: p.id, keyHash: p.keyHash, name: p.name, sim, online: false, offlineAt: room.elapsed, ready: null, controls: idle(), lastInput: -1, lastCommand: p.lastCommand, inputAge: 0 });
      if (!sim.docked) room.participants.add(p.id);
    }
    for (const id of data.participants) if (room.players.has(id)) room.participants.add(id);
    room.carTows = new Map(data.carTows);
    room.share(); room.dirty = false; return room;
  }
  async join(key: string, invite: string | undefined, name: string): Promise<PlayerState> {
    const keyHash = await hashKey(key);
    let p = [...this.players.values()].find(p => p.keyHash === keyHash);
    if (!p) {
      if (!invite || await hashKey(invite) !== this.inviteHash) throw new Error('Нужна действующая ссылка-приглашение.');
      if (this.players.size >= 20) throw new Error('В этом мире уже 20 участников.');
    }
    if ([...this.players.values()].filter(q => q.online && q !== p).length >= 5) throw new Error('В комнате уже пять игроков.');
    if (!p) {
      const c = structuredClone(this.campaign), tier = this.campaign.relics.filter(Boolean).length;
      c.credits = tier ? 160 : 0; c.research = tier ? 2 : 0; c.earned = 0;
      c.progression.owned = []; c.progression.modules = {};
      for (const id of Object.keys(c.upgrades) as (keyof Campaign['upgrades'])[]) c.upgrades[id] = tier ? Math.min(4, 1 + Math.floor(tier / 2)) : 0;
      const id = crypto.randomUUID(), liveWrecks = this.world.wrecks.map(w => ({ ...w })), sim = new Simulation(this.world, c); sim.actorId = id;
      if (this.players.size) liveWrecks.forEach((w, i) => Object.assign(this.world.wrecks[i], w));
      p = { id, keyHash, name, sim, controls: idle(), online: true, offlineAt: 0, ready: null, lastInput: -1, lastCommand: 0, inputAge: 0 };
      this.players.set(id, p);
    }
    p.name = name; p.online = true; p.controls = idle(); p.lastInput = -1; p.inputAge = 0;
    this.share(); this.dirty = true; this.revision++;
    this.events.push({ type: 'enter', message: `${name} на связи` }); return p;
  }
  leave(id: string): void {
    const p = this.players.get(id); if (!p) return;
    p.online = false; p.offlineAt = this.elapsed; p.controls = idle(); p.ready = null;
    p.sim.car.boosting = false; this.dirty = true; this.revision++;
  }
  input(id: string, seq: number, controls: Controls): void {
    const p = this.players.get(id); if (!p?.online || seq <= p.lastInput) return;
    p.lastInput = seq; p.inputAge = 0;
    p.controls = { ...controls, interact: false, home: false, lights: false };
  }
  command(id: string, operation: string, command: Command): void {
    const p = this.players.get(id); if (!p?.online) throw new Error('Подключение потеряно.');
    const prefix = id + ':'; if (!operation.startsWith(prefix)) throw new Error('Неверный идентификатор команды.');
    const n = Number(operation.slice(prefix.length));
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('Неверный номер команды.');
    if (n <= p.lastCommand) return;
    if (n !== p.lastCommand + 1) throw new Error('Команды пришли не по порядку. Переподключись.');
    p.lastCommand = n; this.dirty = true; this.revision++;
    if (command.type === 'depart') this.depart(p, command.region);
    else {
      const before = p.sim.docked, receipt = p.sim.receipt;
      execute(p.sim, command);
      if (!before && p.sim.docked) this.settled(p);
      else if (before && p.sim.receipt !== receipt && (command.type === 'upgrade' || command.type === 'radio')) this.settled(p);
      this.adopt(p.sim.campaign); this.collect(p);
    }
    this.share();
  }
  ping(id: string, label: string): void {
    const p = this.players.get(id); if (!p) return;
    if (label === 'Отцепить трос') {
      for (const w of this.world.wrecks) { if (w.helpers) w.helpers = w.helpers.filter(h => h !== id); if (w.attachedTo === id) { w.attached = false; w.attachedTo = undefined; } }
      this.carTows.delete(id); this.dirty = true;
    } else if (label === 'Зацепить трос') {
      const w = this.world.wrecks.find(w => w.attached && w.attachedTo !== id && Math.hypot(w.x - p.sim.car.x, w.y - p.sim.car.y) < 80);
      if (w) { w.helpers ??= []; if (!w.helpers.includes(id)) w.helpers.push(id); this.events.push({ type: 'pickup', message: `${p.name} подключил вторую лебёдку` }); }
      else {
        const target = [...this.players.values()].find(q => q !== p && !q.sim.docked && Math.hypot(q.sim.car.x - p.sim.car.x, q.sim.car.y - p.sim.car.y) < 70 && q.sim.car.speed < 3);
        if (target) this.carTows.set(id, target.id);
      }
      this.dirty = true;
    }
    this.pings.push({ x: p.sim.player.x, y: p.sim.player.y, label, ttl: 8 }); this.pings = this.pings.slice(-8);
  }
  carTows = new Map<string, string>();
  private depart(p: PlayerState, region: number): void {
    if (!p.sim.docked) return;
    if (regionLock(this.campaign, region, true)) { this.events.push({ type: 'pulse', message: 'Сначала восстановите связь с предыдущим районом.' }); return; }
    const online = [...this.players.values()].filter(p => p.online);
    if (online.some(q => !q.sim.docked)) {
      if (region !== this.world.region) { this.events.push({ type: 'pulse', message: 'Дождитесь возвращения команды, чтобы сменить район.' }); return; }
      p.sim = this.newSimulation(p, this.world); p.sim.launch(); p.sim.elapsed = this.elapsed; this.participants.add(p.id); return;
    }
    p.ready = region;
    if (!online.every(q => q.ready === region)) { this.events.push({ type: 'pulse', message: `${p.name} готов. Выберите тот же район и нажмите «Выехать».` }); return; }
    for (const q of this.players.values()) q.sim.rememberWorld();
    this.campaign.survey[this.world.region] = surveyEncode(this.world);
    this.world = new World(this.campaign.seed, region, this.campaign.day); surveyRestore(this.world, this.campaign.survey[region]);
    this.elapsed = 0; this.participants.clear(); this.carTows.clear();
    for (const q of this.players.values()) {
      if (!q.sim.docked) { q.sim.finish(true); this.adopt(q.sim.campaign); }
      q.sim = this.newSimulation(q, this.world); q.ready = null;
      if (q.online) { q.sim.launch(); this.participants.add(q.id); }
    }
    this.share();
  }
  private newSimulation(p: PlayerState, world: World): Simulation {
    const ongoing = [...this.players.values()].find(q => q.sim.world === world && !q.sim.docked)?.sim.expedition;
    const liveWrecks = world.wrecks.map(w => ({ ...w }));
    const sim = new Simulation(world, p.sim.campaign); sim.actorId = p.id; sim.headlights = p.sim.headlights;
    if (ongoing) sim.expedition = ongoing;
    if (world === this.world && [...this.players.values()].some(q => q.sim.world === world && !q.sim.docked)) liveWrecks.forEach((w, i) => Object.assign(world.wrecks[i], w));
    return sim;
  }
  private adopt(c: Campaign): void {
    const shared = this.campaign;
    for (const key of ['day', 'delivered', 'rescued', 'expeditions', 'relics', 'claimed', 'regions', 'scouted', 'survey', 'stats'] as const) Object.assign(shared, { [key]: c[key] });
    shared.progression.radio = c.progression.radio; shared.progression.rareCount = c.progression.rareCount; shared.progression.rule = c.progression.rule;
  }
  private share(): void {
    let expedition: Simulation['expedition'] | undefined;
    for (const p of this.players.values()) {
      const c = p.sim.campaign, shared = this.campaign;
      for (const key of ['day', 'delivered', 'rescued', 'expeditions', 'relics', 'claimed', 'regions', 'scouted', 'survey', 'stats'] as const) Object.assign(c, { [key]: shared[key] });
      c.progression.radio = shared.progression.radio; c.progression.rareCount = shared.progression.rareCount; c.progression.rule = shared.progression.rule;
      p.sim.checkedLamps = [...p.sim.memory.lamps];
      if (!p.sim.docked) { expedition ??= p.sim.expedition; p.sim.expedition = expedition; }
    }
  }
  private settled(p: PlayerState): void {
    const receipt = p.sim.receipt; if (!receipt) return;
    for (const id of this.participants) {
      const q = this.players.get(id); if (!q || q === p) continue;
      q.sim.campaign.credits += receipt.credits; q.sim.campaign.research += receipt.research; q.sim.campaign.earned += receipt.credits;
    }
    this.adopt(p.sim.campaign); this.dirty = true; this.revision++;
  }
  private collect(p: PlayerState): void {
    for (const event of p.sim.events) {
      if (event.type !== 'step' && event.type !== 'signal' && event.type !== 'water') this.events.push(event);
      if (['pickup', 'beacon', 'rescue', 'dock', 'wisp'].includes(event.type)) { this.dirty = true; this.revision++; }
    }
    p.sim.events = [];
  }
  step(dt = 1 / 60): void {
    const online = [...this.players.values()].filter(p => p.online);
    if (!online.length) return;
    const active = [...this.players.values()].filter(p => !p.sim.docked);
    if (!active.length) return;
    this.tick++; this.elapsed += dt;
    const hunter = active[0].sim.expedition.hunter;
    const authority = active.filter(p => p.online).sort((a, b) => hunter.state === 'dormant' ? b.sim.car.speed - a.sim.car.speed : Math.hypot(a.sim.player.x - hunter.x, a.sim.player.y - hunter.y) - Math.hypot(b.sim.player.x - hunter.x, b.sim.player.y - hunter.y))[0];
    for (const p of active) {
      p.inputAge += dt;
      if (!p.online && this.elapsed - p.offlineAt > 30) { p.sim.finish(true); this.settled(p); this.collect(p); continue; }
      p.sim.elapsed = this.elapsed - dt; p.sim.environmentAuthority = p === authority; p.sim.observers = active.map(q => q.sim.player);
      p.sim.update(dt, p.inputAge < .25 && p.online ? p.controls : idle());
      p.controls.dash = p.controls.pulse = false;
      if (p.sim.docked) this.settled(p);
      this.adopt(p.sim.campaign); this.share(); this.collect(p);
    }
    for (const w of this.world.wrecks) if (w.helpers) w.helpers = w.helpers.filter(id => { const p = this.players.get(id); return p?.online && Math.hypot(w.x - p.sim.car.x, w.y - p.sim.car.y) < 120; });
    for (const [id, targetId] of this.carTows) {
      const a = this.players.get(id), b = this.players.get(targetId); if (!a || !b || a.sim.docked || b.sim.docked) { this.carTows.delete(id); continue; }
      const dx = a.sim.car.x - b.sim.car.x, dy = a.sim.car.y - b.sim.car.y, d = Math.hypot(dx, dy);
      if (d > 120 || b.sim.car.speed > 25) { this.carTows.delete(id); continue; }
      if (d > 28) {
        const pull = Math.min(d - 28, dt * 40), x = b.sim.car.x + dx / d * pull, y = b.sim.car.y + dy / d * pull;
        if (this.world.drivable(x, y)) { b.sim.car.x = x; b.sim.car.y = y; if (b.sim.driving) { b.sim.player.x = x; b.sim.player.y = y; } }
      }
    }
    for (const ping of this.pings) ping.ttl -= dt; this.pings = this.pings.filter(p => p.ttl > 0);
  }
  frames(): ActorFrame[] {
    return [...this.players.values()].filter(p => p.online || !p.sim.docked).map(p => ({ id: p.id, name: p.name, online: p.online, ready: p.ready, ackInput: p.lastInput, ackCommand: p.lastCommand, trip: tripSnapshot(p.sim), profile: this.profile(p), towTarget: this.carTows.get(p.id) }));
  }
  profile(p: PlayerState): PlayerProfile { const c = p.sim.campaign; return { credits: c.credits, research: c.research, earned: c.earned, upgrades: c.upgrades, modules: c.progression.modules, owned: c.progression.owned }; }
  export(): WorldState {
    for (const p of this.players.values()) p.sim.rememberWorld();
    this.campaign.survey[this.world.region] = surveyEncode(this.world);
    return worldStateSchema.parse({ version: 1, id: this.id, inviteHash: this.inviteHash, campaign: this.campaign, region: this.world.region, day: this.world.day, tick: this.tick, elapsed: this.elapsed, revision: this.revision,
      participants: [...this.participants], carTows: [...this.carTows], players: [...this.players.values()].map(p => ({ id: p.id, keyHash: p.keyHash, name: p.name, campaign: { credits: p.sim.campaign.credits, research: p.sim.campaign.research, earned: p.sim.campaign.earned, upgrades: p.sim.campaign.upgrades, progression: p.sim.campaign.progression }, trip: tripSnapshot(p.sim), lastCommand: p.lastCommand })),
    });
  }
}
