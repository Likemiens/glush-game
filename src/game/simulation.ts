import { Terrain, TILE, World } from './world';
import type { Cache, Point, Wreck } from './world';
import { CARGO, createCampaign, REGIONS, settleContracts } from './campaign';
import type { Campaign, CargoKind, Receipt } from './campaign';
import { cargoBalance, cells, findPlacement, fits, pack } from './inventory';
import type { CargoItem, CargoPlacement } from './inventory';
export type { CargoItem } from './inventory';
import { RARE_PLACES, RULES, settleStories } from './features';
import type { ModuleId, RuleId } from './features';

export const ROUND_SECONDS = 480;
export interface Controls { x: number; y: number; boost: boolean; brake: boolean; dash: boolean; interact: boolean; pulse: boolean; home?: boolean; lights?: boolean }
export type ExpeditionState = {
  rule: RuleId;
  hunter: { x: number; y: number; state: 'dormant' | 'warning' | 'search' | 'chase' | 'retreat'; timer: number; noise: number; targetX: number; targetY: number };
  last: { phase: 'waiting' | 'offered' | 'accepted' | 'declined' | 'expired' | 'done'; x: number; y: number; ttl: number };
};
export type Particle = Point & { vx: number; vy: number; life: number; maxLife: number; color: string; size: number };
export type Ripple = Point & { life: number; maxLife: number; radius: number; color: string };
export type Track = { ax: number; ay: number; bx: number; by: number; life: number; maxLife: number; water: boolean; strong: boolean; mud?: boolean };
export type GameEvent = { type: 'dash' | 'step' | 'water' | 'pickup' | 'wisp' | 'pulse' | 'complete' | 'timeout' | 'enter' | 'exit' | 'signal' | 'rescue' | 'dock' | 'damage' | 'beacon' | 'full'; message?: string; strength?: number; pan?: number };
const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
export const angleDifference = (a: number, b: number): number => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export class Simulation {
  player = { x: 0, y: 0, vx: 0, vy: 0, facing: 1, stride: 0, energy: 1, dashTime: 0, dashCooldown: 0, distance: 0 };
  car = { x: 0, y: 0, vx: 0, vy: 0, angle: -.6, speed: 0, boosting: false, drifting: false };
  driving = true;
  particles: Particle[] = [];
  ripples: Ripple[] = [];
  tracks: Track[] = [];
  events: GameEvent[] = [];
  route: Point[] = [];
  time = 0;
  elapsed = 0;
  remaining = ROUND_SECONDS;
  pulseCooldown = 0;
  pulseTime = 0;
  collected = 0;
  failed = false;
  docked = true;
  hull = 100;
  exposure = 0;
  returning = false;
  cargo: CargoItem[] = [];
  receipt: Receipt | undefined;
  rescued = 0;
  checkedLamps: number[] = [];
  actorId = 'solo';
  displayName = 'Водитель';
  carried: CargoItem | null = null;
  headlights = true;
  activatedThisTrip: number[] = [];
  expedition: ExpeditionState = { rule: 'normal', hunter: { x: 0, y: 0, state: 'dormant', timer: 0, noise: 0, targetX: 0, targetY: 0 }, last: { phase: 'waiting', x: 0, y: 0, ttl: 0 } };
  environmentAuthority = true;
  observers: Point[] = [];
  private pingTimer = 0;
  private impactCooldown = 0;
  private warnedNight = false;
  private warnedDamage = false;
  private lastDirection: Point = { x: 1, y: 0 };
  private footDash: Point = { x: 0, y: 0 };
  private oldWheels: [Point, Point] | undefined;
  private trailDistance = 0;
  private dustTimer = 0;
  private footstep = 0;
  private revealTimer = 0;
  private boostLocked = false;

  constructor(readonly world: World, readonly campaign: Campaign = createCampaign(world.seed)) {
    this.car.x = this.player.x = world.camp.x + 16;
    this.car.y = this.player.y = world.camp.y + 22;
    const first = world.caches[0];
    this.car.angle = Math.atan2(first.y - this.car.y, first.x - this.car.x);
    world.reveal(this.player.x, this.player.y, 9);
    this.hull = this.maxHull;
    const memory = campaign.regions[world.region];
    this.checkedLamps = [...memory.lamps];
    for (const cache of world.caches) { if (memory.taken.includes(cache.id)) cache.collected = true; cache.discovered = memory.discovered.includes(cache.id); }
    world.wrecks.forEach((wreck, i) => { if (memory.rescued.includes(i)) { wreck.rescued = true; wreck.progress = 100; } });
    world.wrecks.forEach((wreck, i) => { const saved = memory.wrecks[i]; if (saved && !wreck.rescued) Object.assign(wreck, saved); });
    world.wisps.forEach((wisp, i) => { wisp.collected = memory.wisps.includes(i); });
    if (campaign.relics[world.region]) for (const cache of world.caches) if (cache.kind === 'relic') cache.collected = true;
  }

  get recovered(): number { return this.cargo.length; }
  get maxHull(): number { return 100 + this.campaign.upgrades.armor * 20; }
  get full(): boolean { return !findPlacement(this.cargo, { id: -1, kind: 'scrap', condition: 100, ttl: 0 }, this.rows); }
  get patrolComplete(): boolean { return this.checkedLamps.length >= 3; }
  get nearbyLamp(): number { return this.world.lamps.findIndex((lamp, i) => i > 0 && !this.checkedLamps.includes(i) && Math.hypot(lamp.x - this.player.x, lamp.y - this.player.y) < 18); }
  get rows(): number { return 3 + this.campaign.upgrades.rack + Number(this.hasModule('rack')); }
  get capacity(): number { return 4 * this.rows; }
  get usedSlots(): number { return this.cargo.reduce((sum, item) => sum + cells(item.kind).length, 0); }
  get load(): number { return this.cargo.reduce((sum, item) => sum + (item.kind === 'heavy' ? 3 : item.kind === 'relic' ? 1.5 : .5), 0); }
  get returnReady(): boolean { return this.cargo.length > 0 || this.carried !== null || this.rescued > 0 || this.activatedThisTrip.length > 0; }
  get nearbyCache(): Cache | undefined { return this.world.caches.find(c => !c.collected && Math.hypot(c.x - this.player.x, c.y - this.player.y) < 20 && this.world.sight(this.player, c)); }
  get atCamp(): boolean { return Math.hypot(this.world.camp.x - this.player.x, this.world.camp.y - this.player.y) < 38; }
  get nearCar(): boolean { return Math.hypot(this.car.x - this.player.x, this.car.y - this.player.y) < 28; }
  get score(): number { return this.cargo.reduce((sum, item) => sum + this.itemValue(item), 0) + this.rescued * 80; }
  get night(): number { return this.expedition.rule === 'night' ? 1 : clamp((this.elapsed - ROUND_SECONDS) / 90, 0, 1); }
  get nearbyWreck(): Wreck | undefined { return this.world.wrecks.find(w => !w.rescued && Math.hypot(w.x - this.player.x, w.y - this.player.y) < 29); }
  get towing(): Wreck | undefined { return this.world.wrecks.find(w => w.attached && !w.rescued && (!w.attachedTo || w.attachedTo === this.actorId)); }
  get towSpeed(): number { return (12 + this.campaign.upgrades.winch) * (this.hasModule('winch') ? 1.4 : 1) * (this.hasModule('rescue') ? 1.15 : 1) * (1 + (this.towing?.helpers?.length ?? 0) * .25) / (this.expedition.rule === 'convoy' ? 1.2 : 1); }
  get memory() { return this.campaign.regions[this.world.region]; }
  hasModule(id: ModuleId): boolean { return Object.values(this.campaign.progression.modules).includes(id); }
  sheltered(point: Point = this.player): boolean {
    return this.world.lamps.some((l, i) => (i === 0 || this.memory.lamps.includes(i)) && Math.hypot(l.x - point.x, l.y - point.y) < 70 + this.campaign.upgrades.lamps * 10) || Math.hypot(point.x - this.world.rescueZone.x, point.y - this.world.rescueZone.y) < 60;
  }
  stormAt(point: Point): number {
    if (this.elapsed < 25) return 0;
    const front = (((this.elapsed - 25 + this.world.day * 11) % 165) / 165 * 1.5 - .2) * 2304;
    return clamp(1 - Math.abs(point.x * .8 + point.y * .2 - front) / 210, 0, 1);
  }
  get storm(): number { return this.stormAt(this.player) * (this.sheltered() ? .12 : 1); }
  get visibilityRadius(): number {
    const lamps = this.campaign.upgrades.lamps;
    return this.sheltered() ? 9 + lamps : Math.max(3.2, (this.driving ? 7.6 : 6.7) + (this.headlights ? lamps * 1.2 : 0) - (this.expedition.rule === 'fog' ? 2 : 0) - this.storm * 2.8 - this.night * Math.max(.5, 2.4 - lamps * .5));
  }
  get signal(): { strength: number; angle: number; target: Point; rescue: boolean } | undefined {
    const range = (250 + this.campaign.upgrades.scanner * 140 + (this.hasModule('scanner') ? 250 : 0)) * (this.pulseTime > 0 ? 1.5 : 1);
    const targets = [...this.world.caches.filter(c => !c.collected).map(c => ({ target: c as Point, rescue: false })), ...this.world.wrecks.filter(w => !w.rescued).map(w => ({ target: w as Point, rescue: true })), ...this.memory.drops.map(d => ({ target: d as Point, rescue: false }))];
    if (this.memory.job && !this.memory.job.taken) targets.push({ target: this.memory.job, rescue: false });
    if (!this.memory.rare) targets.push({ target: this.world.rare, rescue: false });
    targets.sort((a, b) => Math.hypot(a.target.x - this.player.x, a.target.y - this.player.y) - Math.hypot(b.target.x - this.player.x, b.target.y - this.player.y));
    const candidate = targets[0]; if (!candidate) return;
    const distance = Math.hypot(candidate.target.x - this.player.x, candidate.target.y - this.player.y); if (distance > range) return;
    const angle = Math.atan2(candidate.target.y - this.player.y, candidate.target.x - this.player.x);
    const step = this.driving ? Math.PI / (4 + this.campaign.upgrades.scanner * 4) : Math.PI / 24;
    return { ...candidate, strength: 1 - distance / range, angle: Math.round(angle / step) * step };
  }
  itemValue(item: CargoItem): number { return Math.round(CARGO[item.kind].value * REGIONS[this.world.region].value * (item.kind === 'volatile' && item.ttl <= 0 ? .12 : .2 + item.condition / 125)); }
  rememberWorld(): void {
    const memory = this.campaign.regions[this.world.region];
    memory.taken = this.world.caches.filter(c => c.collected).map(c => c.id);
    memory.rescued = this.world.wrecks.flatMap((w, i) => w.rescued ? [i] : []);
    memory.wisps = this.world.wisps.flatMap((w, i) => w.collected ? [i] : []);
    memory.lamps = [...new Set([...memory.lamps, ...this.checkedLamps])];
    memory.discovered = this.world.caches.filter(c => c.discovered).map(c => c.id);
    memory.wrecks = this.world.wrecks.map(w => ({ x: w.x, y: w.y, progress: w.progress }));
    this.campaign.scouted[this.world.region] = Math.max(this.campaign.scouted[this.world.region], this.world.exploredCount);
  }
  launch(): void {
    this.docked = false; this.receipt = undefined; this.expedition.rule = this.campaign.progression.rule;
    const m = this.memory;
    if ((!m.job || m.job.delivered) && this.campaign.expeditions > 0) {
      m.sequence++; const p = this.world.findClearing(`job:${m.sequence}`, 500 + m.sequence % 3 * 150);
      m.job = { ...p, id: 10000 + m.sequence, kind: (['scrap', 'fragile', 'heavy'] as const)[m.sequence % 3], taken: false, delivered: false };
      this.events.push({ type: 'signal', message: 'Новая передача: на маршруте оставлен груз. Координаты записаны.' });
    }
  }

  finish(lost = false): void {
    if (this.docked) return;
    if (this.carried) { this.cargo.push(this.carried); this.carried = null; }
    const receipt: Receipt = { credits: lost ? this.rescued * 80 : this.score, research: 0, delivered: lost ? 0 : this.cargo.length, rescued: this.rescued, lost, messages: [] };
    this.rememberWorld();
    if (lost) {
      for (const item of this.cargo) this.memory.drops.push({ x: this.car.x, y: this.car.y, item: { ...item, placement: undefined } });
      receipt.messages.push('Груз остался у машины. Место отмечено на карте.');
    }
    if (this.activatedThisTrip.length) {
      const reward = this.activatedThisTrip.length * (35 + this.world.region * 15);
      receipt.credits += reward; receipt.research += Number(this.patrolComplete);
      if (this.patrolComplete) this.campaign.stats.patrols++;
      receipt.messages.push(`Восстановлено фонарей: ${this.activatedThisTrip.length}. Свет останется на маршруте.`);
    }
    const eligible = this.expedition.rule === 'fragile' ? this.cargo.some(i => i.kind === 'fragile' && i.condition >= 60) : this.expedition.rule === 'convoy' ? this.rescued > 0 || this.cargo.some(i => i.kind === 'heavy') : receipt.delivered + receipt.rescued > 0;
    if (!lost && eligible && this.expedition.rule !== 'normal') { const bonus = Math.round(receipt.credits * RULES[this.expedition.rule].bonus); receipt.credits += bonus; receipt.messages.push(`${RULES[this.expedition.rule].name} · +${bonus}`); }
    if (!lost && this.cargo.length) {
      if (this.hull / this.maxHull >= .9) this.campaign.stats.cleanRuns++;
      if (this.night > 0) this.campaign.stats.nightRuns++;
    }
    if (!lost) for (const item of this.cargo) {
      if (item.kind === 'relic') {
        const region = item.region ?? this.world.region;
        if (!this.campaign.relics[region]) receipt.messages.push(`СВЯЗЬ ВОССТАНОВЛЕНА: ${REGIONS[region].name}`);
        this.campaign.relics[region] = true; receipt.research += 2;
      } else if (item.kind === 'fragile' && item.condition >= 60) {
        receipt.research++; if (item.condition >= 80) this.campaign.stats.fragile++;
      }
      if (item.kind === 'heavy') this.campaign.stats.heavy++;
      if (item.kind === 'volatile' && item.ttl > 0) this.campaign.stats.volatile++;
      if (this.memory.job?.id === item.id) { this.memory.job.delivered = true; receipt.research++; receipt.messages.push('Радиогруз доставлен. Ожидается следующая передача.'); }
    }
    this.campaign.credits += receipt.credits; this.campaign.earned += receipt.credits; this.campaign.research += receipt.research;
    this.campaign.delivered += receipt.delivered; this.campaign.rescued += receipt.rescued;
    if (receipt.delivered || receipt.rescued || this.activatedThisTrip.length || lost) { this.campaign.day++; this.campaign.expeditions++; }
    settleContracts(this.campaign, receipt);
    settleStories(this.campaign, receipt);
    this.cargo = []; this.rescued = 0; this.receipt = receipt; this.docked = true; this.failed = lost;
    this.activatedThisTrip = [];
    this.car.speed = this.car.vx = this.car.vy = 0; this.car.boosting = false;
    for (const wreck of this.world.wrecks) if (wreck.attachedTo === this.actorId || !wreck.attachedTo) { wreck.attached = false; wreck.attachedTo = undefined; }
    this.rememberWorld();
    this.events.push({ type: lost ? 'timeout' : 'complete' }); this.events.push({ type: 'dock' });
  }

  get interaction(): string {
    if (this.atCamp && this.elapsed > 3) return this.returnReady ? 'СДАТЬ ГРУЗ' : 'НА БАЗУ';
    if (this.driving) return 'Выйти';
    if (this.carried) return this.nearCar ? 'ПОГРУЗИТЬ' : 'НЕСУ К МАШИНЕ';
    if (this.nearCar && this.full) return 'СЕСТЬ';
    if (this.nearbyGround || this.nearbyCache || this.nearbyJob) return 'ПОДНЯТЬ ГРУЗ';
    if (this.nearRare) return RARE_PLACES[this.world.region][3];
    if (this.nearbyWreck && !this.nearbyWreck.attached) return 'ЗАЦЕПИТЬ ТРОС';
    if (this.nearbyLamp > 0) return 'ЗАЖЕЧЬ ФОНАРЬ';
    if (this.nearCar) return 'СЕСТЬ';
    return this.nearbyWreck?.attached ? 'ОТЦЕПИТЬ' : '';
  }

  get nearbyGround() { return this.memory.drops.find(d => Math.hypot(d.x - this.player.x, d.y - this.player.y) < 22 && this.world.sight(this.player, d)); }
  get nearbyJob() { const j = this.memory.job; return j && !j.taken && Math.hypot(j.x - this.player.x, j.y - this.player.y) < 22 ? j : undefined; }
  get nearRare(): boolean { return !this.memory.rare && Math.hypot(this.world.rare.x - this.player.x, this.world.rare.y - this.player.y) < 34; }
  makeCargo(id: number, kind: CargoKind, source = 'cache'): CargoItem { return { id, uid: `${this.world.region}:${source}:${id}`, region: this.world.region, kind, condition: 100, ttl: kind === 'volatile' ? 150 + this.campaign.upgrades.battery * 24 : 0 }; }
  loadCarried(): boolean {
    if (!this.carried || !this.nearCar || this.driving) return false;
    const placement = findPlacement(this.cargo, this.carried, this.rows);
    if (!placement) { this.returning = true; this.events.push({ type: 'full', message: 'Груз не помещается. Открой багажник: переложи вещи или вернись на базу.' }); return false; }
    this.carried.placement = placement; this.cargo.push(this.carried); this.carried = null;
    this.events.push({ type: 'pickup', message: 'Груз закреплён' });
    if (this.full) { this.returning = true; this.events.push({ type: 'full', message: 'Багажник полон · На базу' }); }
    return true;
  }
  moveCargo(index: number, placement: CargoPlacement): boolean {
    const item = this.cargo[index];
    if (!item || this.car.speed > 2 || !this.nearCar || !fits(this.cargo, item, placement, this.rows)) return false;
    item.placement = { x: placement.x, y: placement.y, rotation: placement.rotation }; return true;
  }
  packCargo(): boolean { return this.car.speed < 2 && this.nearCar && pack(this.cargo, this.rows); }
  dropCargo(index = -1): boolean {
    if (this.car.speed > 2 || (index >= 0 && !this.nearCar)) return false;
    const item = index < 0 ? this.carried : this.cargo[index]; if (!item) return false;
    const p = this.world.walkable(this.player.x + 12, this.player.y) ? { x: this.player.x + 12, y: this.player.y } : { x: this.player.x, y: this.player.y };
    this.memory.drops.push({ ...p, item: { ...item, placement: undefined } });
    if (index < 0) this.carried = null; else this.cargo.splice(index, 1);
    return true;
  }
  answerLast(accept: boolean): void {
    const last = this.expedition.last; if (last.phase !== 'offered') return;
    last.phase = accept ? 'accepted' : 'declined';
    if (!accept) this.returning = true;
    if (accept) {
      this.memory.drops.push({ x: last.x, y: last.y, item: this.makeCargo(20000 + this.memory.lastDay, 'volatile', 'last') });
      this.events.push({ type: 'beacon', message: 'Координаты последнего сигнала отмечены. Ячейка ждёт 120 секунд.' });
    }
  }

  burst(x: number, y: number, color: string, count = 16, speed = 30): void {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2, force = (Math.random() * .7 + .3) * speed;
      const life = .45 + Math.random() * .65;
      this.particles.push({ x, y, vx: Math.cos(angle) * force, vy: Math.sin(angle) * force, life, maxLife: life, color, size: Math.random() > .65 ? 2 : 1 });
    }
  }

  interact(): void {
    if (this.docked) return;
    if (this.atCamp && this.elapsed > 3) { this.finish(); return; }
    if (this.driving) {
      const offset = this.car.angle + Math.PI / 2;
      const candidates = [offset, offset + Math.PI, this.car.angle + Math.PI, this.car.angle];
      const point = candidates.map(a => ({ x: this.car.x + Math.cos(a) * 13, y: this.car.y + Math.sin(a) * 13 })).find(p => this.world.walkable(p.x, p.y));
      if (!point) return;
      this.driving = false; Object.assign(this.player, point, { vx: 0, vy: 0 });
      this.car.vx = 0; this.car.vy = 0; this.car.speed = 0; this.car.boosting = false; this.car.drifting = false;
      this.oldWheels = undefined; this.route = []; this.events.push({ type: 'exit' });
    } else if (this.carried) {
      this.loadCarried();
    } else if (this.nearCar && this.full) {
      this.driving = true; Object.assign(this.player, { x: this.car.x, y: this.car.y, vx: 0, vy: 0 });
      this.route = []; this.events.push({ type: 'enter' });
    } else if (this.nearbyGround) {
      const ground = this.nearbyGround;
      this.carried = ground.item; this.memory.drops.splice(this.memory.drops.indexOf(ground), 1);
      if (ground.item.uid?.includes(':last:')) this.expedition.last.phase = 'done';
      this.events.push({ type: 'pickup', message: 'Неси груз к машине' });
    } else if (this.nearbyJob) {
      const job = this.nearbyJob; job.taken = true; this.carried = this.makeCargo(job.id, job.kind, 'job');
      this.events.push({ type: 'pickup', message: 'Радиогруз найден. Неси к машине.' });
    } else if (this.nearRare) {
      this.memory.rare = this.memory.rareSeen = true;
      this.campaign.progression.rareCount = this.campaign.regions.filter(r => r.rare).length;
      const place = RARE_PLACES[this.world.region];
      this.campaign.progression.radio.archive.push(`${place[0]}: ${place[2]}`);
      this.memory.drops.push({ ...this.world.rare, item: this.makeCargo(5000 + this.world.region, 'fragile', 'rare') });
      this.events.push({ type: 'beacon', message: `${place[1]}: ${place[2]}` });
    } else if (this.nearbyCache) {
      const cache = this.nearbyCache;
      cache.collected = true;
      this.carried = this.makeCargo(cache.id, cache.kind);
      this.rememberWorld();
      this.burst(cache.x, cache.y, '#d3c877', 35, 45);
      this.events.push({ type: 'pickup', message: `${CARGO[cache.kind].name} · неси к машине` });
      this.pulseTime = 2;
    } else if (this.nearbyWreck && !this.nearbyWreck.attached) {
      if (Math.hypot(this.car.x - this.nearbyWreck.x, this.car.y - this.nearbyWreck.y) > 60 + this.campaign.upgrades.winch * 15) { this.events.push({ type: 'pickup', message: 'ПОДГОНИ МАШИНУ БЛИЖЕ' }); return; }
      if (this.towing) this.towing.attached = false;
      this.nearbyWreck.attached = true; this.nearbyWreck.attachedTo = this.actorId;
      this.events.push({ type: 'pickup', message: 'Трос закреплён. Доставь машину на эвакуационный пост ◆' });
    } else if (this.nearbyLamp > 0) {
      this.checkedLamps.push(this.nearbyLamp);
      this.activatedThisTrip.push(this.checkedLamps[this.checkedLamps.length - 1]); this.rememberWorld();
      this.events.push({ type: 'beacon', message: 'Фонарь восстановлен. Теперь здесь всегда безопасно.' });
    } else if (this.nearCar) {
      this.driving = true; Object.assign(this.player, { x: this.car.x, y: this.car.y, vx: 0, vy: 0 });
      this.route = []; this.events.push({ type: 'enter' });
    } else if (this.nearbyWreck?.attached && this.nearbyWreck.attachedTo === this.actorId) { this.nearbyWreck.attached = false; this.nearbyWreck.attachedTo = undefined;
    }
  }

  update(dt: number, controls: Controls): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (this.docked) { this.time += dt; this.updateEffects(dt); return; }
    this.time += dt; this.elapsed += dt;
    this.remaining = Math.max(0, ROUND_SECONDS - this.elapsed);
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    if (controls.lights) this.headlights = !this.headlights;
    if (controls.home) this.returning = !this.returning;
    this.pulseCooldown = Math.max(0, this.pulseCooldown - dt);
    this.pulseTime = Math.max(0, this.pulseTime - dt);
    this.player.dashCooldown = Math.max(0, this.player.dashCooldown - dt);
    if (controls.interact) this.interact();
    if (this.docked) return;
    let ix = controls.x, iy = controls.y;
    if (ix || iy) this.route = [];
    else if (this.route.length) {
      const point = this.route[0], dx = point.x - this.player.x, dy = point.y - this.player.y;
      const length = Math.hypot(dx, dy);
      if (length < (this.driving ? 20 : 4)) this.route.shift();
      else { ix = dx / length; iy = dy / length; }
    }
    const magnitude = Math.hypot(ix, iy);
    if (magnitude > 1) { ix /= magnitude; iy /= magnitude; }
    if (magnitude > .1) this.lastDirection = { x: ix / Math.hypot(ix, iy), y: iy / Math.hypot(ix, iy) };
    if (this.driving) this.drive(dt, ix, iy, controls);
    else this.walk(dt, ix, iy, controls);
    this.revealTimer -= dt;
    if (this.revealTimer <= 0) {
      this.world.reveal(this.player.x, this.player.y, Math.ceil(this.visibilityRadius));
      for (const cache of this.world.caches) if (Math.hypot(cache.x - this.player.x, cache.y - this.player.y) < this.visibilityRadius * TILE && this.world.sight(this.player, cache)) cache.discovered = true;
      this.revealTimer = .04;
    }
    if (controls.pulse && this.pulseCooldown === 0 && this.expedition.rule !== 'silent') {
      this.expedition.hunter.noise += this.hasModule('scanner') ? 25 : 15;
      this.pulseTime = 3; this.pulseCooldown = 3;
      this.ripples.push({ x: this.player.x, y: this.player.y, life: 1.3, maxLife: 1.3, radius: TILE * 13, color: '#c9c178' });
      const angle = this.signal?.angle ?? 0;
      for (let i = 1; i <= (this.signal ? 20 : 0); i++) {
        const life = 1.2 + i * .04;
        this.particles.push({ x: this.player.x + Math.cos(angle) * i * 3, y: this.player.y + Math.sin(angle) * i * 3, vx: Math.cos(angle) * 22, vy: Math.sin(angle) * 22, life, maxLife: life, color: '#d6ca7e', size: 1 });
      }
      this.events.push({ type: 'pulse' });
    }
    for (const wisp of this.world.wisps) {
      if (!wisp.collected && Math.hypot(wisp.x - this.player.x, wisp.y - this.player.y) < 12) {
        wisp.collected = true; this.collected++;
        this.hull = Math.min(this.maxHull, this.hull + 20); this.exposure = Math.max(0, this.exposure - 20);
        this.player.energy = Math.min(1, this.player.energy + .5);
        this.burst(wisp.x, wisp.y, '#c7d290', 18, 35);
        this.events.push({ type: 'wisp', message: 'Ремкомплект · +20 прочности' });
      }
    }
    this.updateExpedition(dt);
    this.updateEffects(dt);
  }

  private updateExpedition(dt: number): void {
    const lamps = this.campaign.upgrades.lamps;
    this.exposure = clamp(this.exposure + dt * (this.sheltered() ? -12 : (this.storm * 7 + this.night * 2.6) * REGIONS[this.world.region].risk / (1 + lamps * .55) - 1.4), 0, 100);
    if (this.exposure > 82) this.hull = Math.max(0, this.hull - dt * (this.exposure - 82) * .28 / (1 + this.campaign.upgrades.armor * .12));
    if (this.remaining === 0 && !this.warnedNight) { this.warnedNight = true; this.events.push({ type: 'pulse', message: 'НОЧЬ · ФОНАРИ ЗАЩИЩАЮТ ОТ ТУМАНА' }); }
    for (const item of [...this.cargo, ...(this.carried ? [this.carried] : [])]) if (item.kind === 'volatile' && item.ttl > 0) {
      item.ttl = Math.max(0, item.ttl - dt);
      if (item.ttl === 0) { item.condition = 0; this.hull = Math.max(0, this.hull - 14); this.burst(this.car.x, this.car.y, '#e89664', 35, 50); this.events.push({ type: 'damage', message: 'ЯЧЕЙКА РАЗРЯДИЛАСЬ · ЦЕННОСТЬ ПОТЕРЯНА' }); }
    }
    if (this.environmentAuthority) this.updateWorldEvents(dt);
    const wreck = this.towing;
    if (wreck && this.driving) {
      const dx = this.car.x - wreck.x, dy = this.car.y - wreck.y, length = Math.hypot(dx, dy);
      if (length > 105 + this.campaign.upgrades.winch * 25) { wreck.attached = false; this.events.push({ type: 'damage', message: 'ТРОС СОСКОЧИЛ · ПОДЪЕДЬ БЛИЖЕ' }); }
      else {
        wreck.tension = clamp((length - 19) / 65, 0, 1);
        const speed = Math.min(this.towSpeed, Math.max(0, length - 22) * 3);
        const blend = 1 - Math.exp(-dt * (this.hasModule('rescue') ? 8 : 3));
        wreck.vx += (dx / Math.max(1, length) * speed - wreck.vx) * blend;
        wreck.vy += (dy / Math.max(1, length) * speed - wreck.vy) * blend;
        if (this.world.drivable(wreck.x + wreck.vx * dt, wreck.y, 4)) wreck.x += wreck.vx * dt; else wreck.vx = 0;
        if (this.world.drivable(wreck.x, wreck.y + wreck.vy * dt, 4)) wreck.y += wreck.vy * dt; else wreck.vy = 0;
        const remaining = Math.hypot(wreck.x - this.world.rescueZone.x, wreck.y - this.world.rescueZone.y);
        wreck.progress = clamp(100 * (1 - remaining / Math.max(1, Math.hypot(wreck.origin.x - this.world.rescueZone.x, wreck.origin.y - this.world.rescueZone.y))), 0, 99);
        if (remaining < 35) { wreck.rescued = true; wreck.attached = false; wreck.progress = 100; this.rescued++; this.rememberWorld(); this.burst(wreck.x, wreck.y, '#b8cba4', 40); this.events.push({ type: 'rescue', message: 'Машина доставлена. Водитель в безопасности.' }); }
      }
    }
    this.pingTimer -= dt; const signal = this.signal;
    if (signal && this.pingTimer <= 0) { this.pingTimer = 1.5 - signal.strength * 1.25; this.events.push({ type: 'signal', strength: signal.strength, pan: Math.cos(signal.angle) }); }
    if (this.hull / this.maxHull < .3 && !this.warnedDamage) { this.warnedDamage = true; this.returning = true; this.events.push({ type: 'damage', message: 'КУЗОВ ПОВРЕЖДЁН · ВОЗВРАЩАЙСЯ' }); }
    if (this.hull <= 0) this.finish(true);
  }

  private updateWorldEvents(dt: number): void {
    const last = this.expedition.last, hunter = this.expedition.hunter;
    if (Math.hypot(this.player.x - this.world.rare.x, this.player.y - this.world.rare.y) < 150) this.memory.rareSeen = true;
    if (last.phase === 'waiting' && this.memory.lastDay !== this.world.day && this.elapsed > 360 && (this.returning || this.full || this.elapsed > 450)) {
      const p = this.world.findClearing(`last:${this.world.day}`, 600);
      Object.assign(last, p, { phase: 'offered', ttl: 120 }); this.memory.lastDay = this.world.day;
      this.events.push({ type: 'beacon', message: 'Последний сигнал. Кто-то оставил заряженную ячейку. Ответить по радио?' });
    }
    if (last.phase === 'offered' || last.phase === 'accepted') {
      last.ttl = Math.max(0, last.ttl - dt);
      if (!last.ttl) {
        last.phase = 'expired';
        this.memory.drops = this.memory.drops.filter(d => d.item.uid !== `${this.world.region}:last:${20000 + this.memory.lastDay}`);
        this.events.push({ type: 'pulse', message: 'Последний сигнал стих. Можно возвращаться.' });
      }
    }
    const motion = this.driving ? this.car.speed / 100 * (this.car.boosting ? 2.4 : .7) : .08;
    const bearing = Math.atan2(hunter.y - this.car.y, hunter.x - this.car.x);
    const aimed = Math.abs(angleDifference(bearing, this.car.angle)) < .35 + Number(this.hasModule('light')) * .2;
    const light = this.headlights ? hunter.state === 'dormant' ? .25 : aimed ? .75 : .05 : 0;
    hunter.noise = clamp(hunter.noise + dt * (this.sheltered() ? -5 : motion + light - .35), 0, 100);
    hunter.timer = Math.max(0, hunter.timer - dt);
    if (hunter.state === 'dormant') {
      if (this.elapsed < 300 || hunter.timer > 0 || hunter.noise < 18 || this.sheltered()) return;
      const actors = [this.player, ...this.observers];
      let point: Point | undefined;
      for (let i = 0; i < 16; i++) {
        const a = this.car.angle + Math.PI + i * .4;
        const p = { x: this.player.x + Math.cos(a) * 620, y: this.player.y + Math.sin(a) * 620 };
        if (this.world.drivable(p.x, p.y) && actors.every(o => Math.hypot(o.x - p.x, o.y - p.y) > 550)) { point = p; break; }
      }
      if (!point) return;
      Object.assign(hunter, point, { state: 'warning', timer: 8, targetX: this.player.x, targetY: this.player.y });
      this.events.push({ type: 'pulse', message: 'В радио низкий гул. Кто-то услышал двигатель. Сбавь ход.' });
      return;
    }
    if (hunter.state === 'warning') { if (!hunter.timer) { hunter.state = 'search'; hunter.timer = 50; } return; }
    if (hunter.state === 'retreat') { if (!hunter.timer) { hunter.state = 'dormant'; hunter.timer = 90; hunter.noise = 0; } return; }
    const distance = Math.hypot(hunter.x - this.player.x, hunter.y - this.player.y);
    const detected = !this.sheltered() && distance < 300 && (motion + light > .65 || this.pulseTime > 0) && this.world.sight(hunter, this.player);
    if (detected) { hunter.state = 'chase'; hunter.timer = 12; hunter.targetX = this.player.x; hunter.targetY = this.player.y; }
    if (this.sheltered() || !hunter.timer) { hunter.state = 'retreat'; hunter.timer = 12; return; }
    const dx = hunter.targetX - hunter.x, dy = hunter.targetY - hunter.y, d = Math.hypot(dx, dy), speed = hunter.state === 'chase' ? 48 : 32;
    if (d > 3) {
      if (this.world.walkable(hunter.x + dx / d * speed * dt, hunter.y)) hunter.x += dx / d * speed * dt;
      if (this.world.walkable(hunter.x, hunter.y + dy / d * speed * dt)) hunter.y += dy / d * speed * dt;
    }
    if (distance < 17 && this.impactCooldown === 0) {
      this.hull = Math.max(0, this.hull - 24); this.impactCooldown = 3;
      hunter.state = 'retreat'; hunter.timer = 16;
      this.events.push({ type: 'damage', message: 'Удар из тумана. К свету!' }); this.burst(this.player.x, this.player.y, '#9a8bad', 30);
    }
  }

  private drive(dt: number, ix: number, iy: number, controls: Controls): void {
    const c = this.car, p = this.player;
    const input = Math.hypot(ix, iy), terrain = this.world.at(c.x, c.y), upgrades = this.campaign.upgrades;
    const inWater = terrain === Terrain.Water;
    const mud = terrain === Terrain.Mud, ice = terrain === Terrain.Ice, sand = terrain === Terrain.Sand, ash = terrain === Terrain.Ash;
    if (p.energy < .035) this.boostLocked = true;
    if (p.energy > .3 || !controls.boost) this.boostLocked = false;
    c.boosting = controls.boost && !controls.brake && !this.boostLocked && input > .05;
    c.drifting = controls.brake && c.speed > 25;
    const baseSpeed = mud ? Math.min(110, 43 + upgrades.tires * 22) : sand || ash ? Math.min(112, 60 + upgrades.tires * 12) : inWater ? Math.min(110, 75 + upgrades.tires * 9) : terrain === Terrain.Stone ? 97 : 117;
    const weight = (1 + this.load * .085 / (1 + upgrades.engine * .4)) * (this.expedition.rule === 'convoy' ? 1.25 : 1) * (this.hasModule('rack') ? 1.1 : 1);
    const towLimit = this.towSpeed;
    const targetSpeed = Math.min(this.towing ? towLimit : Infinity, baseSpeed * (1 + upgrades.engine * .12) / weight * (this.hasModule('plow') && mud ? 1.25 : 1)) * (controls.brake ? .32 : c.boosting && !this.towing ? 1.72 : 1) * Math.min(1, input);
    let turning = 0;
    if (input > .05) {
      const difference = angleDifference(Math.atan2(iy, ix), c.angle);
      const turnRate = (controls.brake ? 7.5 : 4.9) * dt / (1 + Math.abs(cargoBalance(this.cargo)) * .14 + Number(this.hasModule('plow')) * .1);
      turning = difference;
      c.angle += clamp(difference, -turnRate, turnRate);
    }
    const roadKey = `${Math.floor(c.x / 24)}:${Math.floor(c.y / 24)}`;
    const worn = (this.memory.roads[roadKey] ?? 0) >= 3;
    if (c.speed > 4 && !inWater && this.memory.roadTrips[roadKey] !== this.world.day) { this.memory.roadTrips[roadKey] = this.world.day; this.memory.roads[roadKey] = Math.min(5, (this.memory.roads[roadKey] ?? 0) + 1); }
    const grip = (input > .05 ? (controls.brake ? 2.7 : c.boosting ? 4.8 : 8.2) : 5.4) * (ice ? Math.min(1, .19 + upgrades.tires * .18) : 1) / Math.sqrt(weight) * (worn ? 1.15 : 1);
    const blend = 1 - Math.exp(-grip * dt);
    const current = this.world.current(c.x, c.y);
    c.vx += (Math.cos(c.angle) * targetSpeed + current.x - c.vx) * blend;
    c.vy += (Math.sin(c.angle) * targetSpeed + current.y - c.vy) * blend;
    if (c.boosting) p.energy = Math.max(0, p.energy - dt * .25 / (1 + upgrades.battery * .14) * (this.hasModule('battery') ? .65 : 1));
    else if (this.expedition.rule !== 'battery' || this.sheltered()) p.energy = Math.min(1, p.energy + dt * .16 * (1 + upgrades.battery * .18));
    const oldX = c.x, oldY = c.y;
    let impact = 0;
    if (this.world.drivable(c.x + c.vx * dt, c.y)) c.x += c.vx * dt; else { impact = Math.abs(c.vx); c.vx *= -.12; this.route = []; }
    if (this.world.drivable(c.x, c.y + c.vy * dt)) c.y += c.vy * dt; else { impact = Math.max(impact, Math.abs(c.vy)); c.vy *= -.12; this.route = []; }
    if (impact > 45 && this.impactCooldown === 0) {
      this.impactCooldown = .8; this.hull = Math.max(0, this.hull - impact * .045 / (1 + upgrades.armor * .25));
      for (const item of this.cargo) if (item.kind === 'fragile') item.condition = Math.max(0, item.condition - 13 / (1 + upgrades.rack * .5) * (this.hasModule('padding') ? .5 : 1) * (this.expedition.rule === 'fragile' ? 1.6 : 1));
      this.burst(c.x, c.y, '#cdb39d', 12); this.events.push({ type: 'damage', message: 'УДАР · БЕРЕГИ КУЗОВ И ОПТИКУ' });
    }
    c.speed = Math.hypot(c.vx, c.vy);
    const rough = terrain === Terrain.Stone || mud || ash || terrain === Terrain.Crystal;
    if (c.speed > 65 && (rough || c.drifting)) for (const item of this.cargo) if (item.kind === 'fragile') {
      item.condition = Math.max(0, item.condition - dt * (rough ? 5 : 2.2) * (c.speed / 100) / (1 + upgrades.rack * .65 + upgrades.tires * .3) * (this.hasModule('padding') ? .5 : 1) * (this.hasModule('plow') ? .7 : 1) * (this.expedition.rule === 'fragile' ? 1.6 : 1));
    }
    Object.assign(p, { x: c.x, y: c.y, vx: c.vx, vy: c.vy });
    const moved = Math.hypot(c.x - oldX, c.y - oldY);
    p.distance += moved; this.trailDistance += moved;
    if (c.speed > 6 && this.trailDistance >= 1.8) {
      this.trailDistance = 0;
      const rearX = c.x - Math.cos(c.angle) * 3, rearY = c.y - Math.sin(c.angle) * 3;
      const wheels: [Point, Point] = [-1, 1].map(side => ({ x: rearX - Math.sin(c.angle) * 3.1 * side, y: rearY + Math.cos(c.angle) * 3.1 * side })) as [Point, Point];
      if (this.oldWheels) for (let i = 0; i < 2; i++) {
        const from = this.oldWheels[i], to = wheels[i];
        const lifetime = mud ? 18 : inWater ? 5 : ice ? 8 : 12;
        if (Math.hypot(to.x - from.x, to.y - from.y) < 12) this.tracks.push({ ax: from.x, ay: from.y, bx: to.x, by: to.y, life: lifetime, maxLife: lifetime, water: inWater || ice, mud: mud || sand || ash, strong: c.boosting || Math.abs(turning) > .55 || c.drifting });
      }
      this.oldWheels = wheels;
    }
    this.dustTimer -= dt;
    if (c.speed > 18 && this.dustTimer <= 0) {
      this.dustTimer = c.boosting ? .021 : .036;
      for (let n = 0; n < (c.boosting || c.drifting ? 4 : 2); n++) {
        const side = (Math.random() - .5) * 9;
        const life = .35 + Math.random() * .75;
        this.particles.push({ x: c.x - Math.cos(c.angle) * 6 - Math.sin(c.angle) * side, y: c.y - Math.sin(c.angle) * 6 + Math.cos(c.angle) * side,
          vx: -c.vx * .15 + (Math.random() - .5) * 24, vy: -c.vy * .15 + (Math.random() - .5) * 24,
          life, maxLife: life, color: mud ? '#9f8159' : sand ? '#c7ad7b' : ash ? '#b19a91' : inWater || ice ? '#abbcc0' : c.boosting ? '#e7d9c7' : '#c9beab', size: Math.random() > .6 ? 2 : 1 });
      }
      if (inWater && Math.random() < .2) this.ripples.push({ x: c.x, y: c.y, life: .65, maxLife: .65, radius: 12, color: '#9caeb8' });
    }
    if (c.speed < 3) this.oldWheels = undefined;
  }

  private walk(dt: number, ix: number, iy: number, controls: Controls): void {
    const p = this.player, water = this.world.at(p.x, p.y) === Terrain.Water;
    if (Math.abs(ix) > .05) p.facing = ix > 0 ? 1 : -1;
    if (controls.dash && !this.carried && p.dashCooldown === 0 && p.energy >= .2) {
      this.footDash = { x: this.lastDirection.x * 160, y: this.lastDirection.y * 160 };
      p.dashTime = .14; p.dashCooldown = .4; p.energy -= .2; this.events.push({ type: 'dash' });
      this.burst(p.x, p.y, '#dacdbc', 12, 24);
    }
    const speed = (water ? 31 : 54) * (this.carried ? this.carried.kind === 'heavy' ? .55 : .75 : 1), blend = 1 - Math.exp(-dt * 24);
    p.vx += (ix * speed - p.vx) * blend; p.vy += (iy * speed - p.vy) * blend;
    if (p.dashTime > 0) { p.dashTime -= dt; p.vx = this.footDash.x; p.vy = this.footDash.y; }
    else p.energy = Math.min(1, p.energy + dt * .22);
    const before = { x: p.x, y: p.y };
    const current = this.world.current(p.x, p.y);
    if (this.world.walkable(p.x + (p.vx + current.x * .4) * dt, p.y)) p.x += (p.vx + current.x * .4) * dt; else { p.vx = 0; this.route = []; }
    if (this.world.walkable(p.x, p.y + (p.vy + current.y * .4) * dt)) p.y += (p.vy + current.y * .4) * dt; else { p.vy = 0; this.route = []; }
    const moved = Math.hypot(p.x - before.x, p.y - before.y); p.distance += moved; p.stride += moved / 4;
    this.footstep += moved;
    if (this.footstep > 7) {
      this.footstep = 0; this.burst(p.x, p.y, water ? '#889da3' : '#c2b7a3', 3, 8);
      this.events.push({ type: water ? 'water' : 'step' });
    }
  }

  updateEffects(dt: number): void {
    for (const particle of this.particles) {
      particle.life -= dt; particle.x += particle.vx * dt; particle.y += particle.vy * dt;
      particle.vx *= Math.exp(-dt * 2); particle.vy *= Math.exp(-dt * 2);
    }
    for (const track of this.tracks) track.life -= dt;
    for (const ripple of this.ripples) ripple.life -= dt;
    this.particles = this.particles.filter(p => p.life > 0).slice(-420);
    this.ripples = this.ripples.filter(p => p.life > 0).slice(-18);
    this.tracks = this.tracks.filter(p => p.life > 0).slice(-6500);
  }
  predictMovement(dt: number, controls: Controls): void {
    if (this.docked) return;
    let { x, y } = controls; const magnitude = Math.max(1, Math.hypot(x, y)); x /= magnitude; y /= magnitude;
    if (this.driving) this.drive(dt, x, y, controls); else this.walk(dt, x, y, controls);
    this.time += dt; this.updateEffects(dt);
  }
}
