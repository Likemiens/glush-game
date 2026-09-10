import { Terrain, TILE, World } from './world';
import type { Cache, Point, Wreck } from './world';
import { CARGO, createCampaign, REGIONS, settleContracts } from './campaign';
import type { Campaign, CargoKind, Receipt } from './campaign';

export const ROUND_SECONDS = 150;
export interface Controls { x: number; y: number; boost: boolean; brake: boolean; dash: boolean; interact: boolean; pulse: boolean; home?: boolean }
export type CargoItem = { id: number; kind: CargoKind; condition: number; ttl: number };
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
    for (const cache of world.caches) if (memory.taken.includes(cache.id)) cache.collected = true;
    world.wrecks.forEach((wreck, i) => { if (memory.rescued.includes(i)) { wreck.rescued = true; wreck.progress = 100; } });
    world.wisps.forEach((wisp, i) => { wisp.collected = memory.wisps.includes(i); });
    if (campaign.relics[world.region]) for (const cache of world.caches) if (cache.kind === 'relic') cache.collected = true;
  }

  get recovered(): number { return this.cargo.length; }
  get maxHull(): number { return 100 + this.campaign.upgrades.armor * 20; }
  get full(): boolean { return this.usedSlots >= this.capacity; }
  get patrolComplete(): boolean { return this.checkedLamps.length >= 3; }
  get nearbyLamp(): number { return this.world.lamps.findIndex((lamp, i) => i > 0 && !this.checkedLamps.includes(i) && Math.hypot(lamp.x - this.player.x, lamp.y - this.player.y) < 18); }
  get capacity(): number { return 4 + this.campaign.upgrades.rack * 2; }
  get usedSlots(): number { return this.cargo.reduce((sum, item) => sum + CARGO[item.kind].slots, 0); }
  get load(): number { return this.cargo.reduce((sum, item) => sum + (item.kind === 'heavy' ? 3 : item.kind === 'relic' ? 1.5 : .5), 0); }
  get returnReady(): boolean { return this.cargo.length > 0 || this.rescued > 0 || this.patrolComplete; }
  get nearbyCache(): Cache | undefined { return this.world.caches.find(c => !c.collected && Math.hypot(c.x - this.player.x, c.y - this.player.y) < 20 && this.world.sight(this.player, c)); }
  get atCamp(): boolean { return Math.hypot(this.world.camp.x - this.player.x, this.world.camp.y - this.player.y) < 38; }
  get nearCar(): boolean { return Math.hypot(this.car.x - this.player.x, this.car.y - this.player.y) < 28; }
  get score(): number { return this.cargo.reduce((sum, item) => sum + this.itemValue(item), 0) + this.rescued * 80; }
  get night(): number { return clamp((this.elapsed - ROUND_SECONDS) / 75, 0, 1); }
  get nearbyWreck(): Wreck | undefined { return this.world.wrecks.find(w => !w.rescued && Math.hypot(w.x - this.player.x, w.y - this.player.y) < 29); }
  get towing(): Wreck | undefined { return this.world.wrecks.find(w => w.attached && !w.rescued); }
  sheltered(point: Point = this.player): boolean {
    return this.world.lamps.some(l => Math.hypot(l.x - point.x, l.y - point.y) < 57 + this.campaign.upgrades.lamps * 10) || !this.driving && Math.hypot(point.x - this.car.x, point.y - this.car.y) < 23;
  }
  stormAt(point: Point): number {
    if (this.elapsed < 25) return 0;
    const front = (((this.elapsed - 25 + this.world.day * 11) % 165) / 165 * 1.5 - .2) * 2304;
    return clamp(1 - Math.abs(point.x * .8 + point.y * .2 - front) / 210, 0, 1);
  }
  get storm(): number { return this.stormAt(this.player) * (this.sheltered() ? .12 : 1); }
  get visibilityRadius(): number {
    const lamps = this.campaign.upgrades.lamps;
    return this.sheltered() ? 9 + lamps : Math.max(3.2, (this.driving ? 8.6 : 6.7) + lamps * 1.2 - this.storm * 3.8 - this.night * Math.max(.5, 2.4 - lamps * .5));
  }
  get signal(): { strength: number; angle: number; target: Point; rescue: boolean } | undefined {
    const range = (250 + this.campaign.upgrades.scanner * 140) * (this.pulseTime > 0 ? 1.5 : 1);
    const targets = [...this.world.caches.filter(c => !c.collected).map(c => ({ target: c as Point, rescue: false })), ...this.world.wrecks.filter(w => !w.rescued).map(w => ({ target: w as Point, rescue: true }))];
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
    this.campaign.scouted[this.world.region] = Math.max(this.campaign.scouted[this.world.region], this.world.exploredCount);
  }
  launch(): void { this.docked = false; this.receipt = undefined; }

  finish(lost = false): void {
    if (this.docked) return;
    const receipt: Receipt = { credits: lost ? 0 : this.score, research: 0, delivered: lost ? 0 : this.cargo.length, rescued: lost ? 0 : this.rescued, lost, messages: [] };
    this.rememberWorld();
    if (lost) for (const item of this.cargo) if (item.kind === 'relic' && !this.campaign.relics[this.world.region]) {
      const cache = this.world.caches[item.id]; cache.collected = false;
      this.campaign.regions[this.world.region].taken = this.campaign.regions[this.world.region].taken.filter(id => id !== item.id);
      receipt.messages.push('Сигнал сердца не погас. Его можно найти снова.');
    }
    if (!lost && this.patrolComplete) {
      const reward = 90 + this.world.region * 40;
      receipt.credits += reward; receipt.research++; this.campaign.stats.patrols++;
      receipt.messages.push('Патруль завершён · +' + reward + ' деталей и схема');
    }
    if (!lost && this.cargo.length) {
      if (this.hull / this.maxHull >= .9) this.campaign.stats.cleanRuns++;
      if (this.night > 0) this.campaign.stats.nightRuns++;
    }
    if (!lost) for (const item of this.cargo) {
      if (item.kind === 'relic') {
        if (!this.campaign.relics[this.world.region]) receipt.messages.push(`СВЯЗЬ ВОССТАНОВЛЕНА: ${REGIONS[this.world.region].name}`);
        this.campaign.relics[this.world.region] = true; receipt.research += 2;
      } else if (item.kind === 'fragile' && item.condition >= 60) {
        receipt.research++; if (item.condition >= 80) this.campaign.stats.fragile++;
      }
      if (item.kind === 'heavy') this.campaign.stats.heavy++;
      if (item.kind === 'volatile' && item.ttl > 0) this.campaign.stats.volatile++;
    }
    this.campaign.credits += receipt.credits; this.campaign.earned += receipt.credits; this.campaign.research += receipt.research;
    this.campaign.delivered += receipt.delivered; this.campaign.rescued += receipt.rescued;
    if (receipt.delivered || receipt.rescued || this.patrolComplete || lost) { this.campaign.day++; this.campaign.expeditions++; }
    settleContracts(this.campaign, receipt);
    this.cargo = []; this.rescued = 0; this.receipt = receipt; this.docked = true; this.failed = lost;
    this.car.speed = this.car.vx = this.car.vy = 0; this.car.boosting = false;
    for (const wreck of this.world.wrecks) wreck.attached = false;
    this.events.push({ type: lost ? 'timeout' : 'complete' }); this.events.push({ type: 'dock' });
  }

  get interaction(): string {
    if (this.atCamp && this.elapsed > 3) return this.returnReady ? 'СДАТЬ ГРУЗ' : 'НА БАЗУ';
    if (this.driving) return 'Выйти';
    if (this.nearbyCache && !(this.nearCar && this.usedSlots + CARGO[this.nearbyCache.kind].slots > this.capacity)) return this.usedSlots + CARGO[this.nearbyCache.kind].slots > this.capacity ? 'Нет места' : 'Забрать';
    if (this.nearbyWreck && !this.nearbyWreck.attached) return 'ЗАЦЕПИТЬ ТРОС';
    if (this.nearbyLamp > 0) return 'Проверить фонарь';
    if (this.nearCar) return 'СЕСТЬ';
    return this.nearbyWreck?.attached ? 'ОТЦЕПИТЬ' : '';
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
    } else if (this.nearbyCache && !(this.nearCar && this.usedSlots + CARGO[this.nearbyCache.kind].slots > this.capacity)) {
      const cache = this.nearbyCache;
      if (this.usedSlots + CARGO[cache.kind].slots > this.capacity) { this.returning = true; this.events.push({ type: 'full', message: 'Груз не помещается. Вернись на базу' }); return; }
      cache.collected = true;
      this.cargo.push({ id: cache.id, kind: cache.kind, condition: 100, ttl: cache.kind === 'volatile' ? 75 + this.campaign.upgrades.battery * 12 : 0 });
      this.rememberWorld();
      this.burst(cache.x, cache.y, '#d3c877', 35, 45);
      this.events.push({ type: 'pickup', message: `${CARGO[cache.kind].name}${cache.kind === 'volatile' ? ' · ' + (75 + this.campaign.upgrades.battery * 12) + ' сек до разряда' : cache.kind === 'heavy' ? ' · тяжёлый груз' : ''}` });
      if (this.full) { this.returning = true; this.events.push({ type: 'full', message: 'Багажник полон. Возвращайся на базу' }); }
      this.pulseTime = 2;
    } else if (this.nearbyWreck && !this.nearbyWreck.attached) {
      if (Math.hypot(this.car.x - this.nearbyWreck.x, this.car.y - this.nearbyWreck.y) > 60 + this.campaign.upgrades.winch * 15) { this.events.push({ type: 'pickup', message: 'ПОДГОНИ МАШИНУ БЛИЖЕ' }); return; }
      for (const wreck of this.world.wrecks) wreck.attached = false;
      this.nearbyWreck.attached = true; this.events.push({ type: 'pickup', message: 'ТРОС ЗАЦЕПЛЕН · СЯДЬ И ТЯНИ ОТ БОЛОТА' });
    } else if (this.nearbyLamp > 0) {
      this.checkedLamps.push(this.nearbyLamp);
      this.events.push({ type: 'beacon', message: this.patrolComplete ? 'Линия проверена. Награда на базе' : 'Фонарь проверен · ' + this.checkedLamps.length + '/3' });
    } else if (this.nearCar) {
      this.driving = true; Object.assign(this.player, { x: this.car.x, y: this.car.y, vx: 0, vy: 0 });
      this.route = []; this.events.push({ type: 'enter' });
    } else if (this.nearbyWreck?.attached) { this.nearbyWreck.attached = false;
    }
  }

  update(dt: number, controls: Controls): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (this.docked) { this.time += dt; this.updateEffects(dt); return; }
    this.time += dt; this.elapsed += dt;
    this.remaining = Math.max(0, ROUND_SECONDS - this.elapsed);
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
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
    if (controls.pulse && this.pulseCooldown === 0) {
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
    for (const item of this.cargo) if (item.kind === 'volatile' && item.ttl > 0) {
      item.ttl = Math.max(0, item.ttl - dt);
      if (item.ttl === 0) { item.condition = 0; this.hull = Math.max(0, this.hull - 14); this.burst(this.car.x, this.car.y, '#e89664', 35, 50); this.events.push({ type: 'damage', message: 'ЯЧЕЙКА РАЗРЯДИЛАСЬ · ЦЕННОСТЬ ПОТЕРЯНА' }); }
    }
    const wreck = this.towing;
    if (wreck && this.driving) {
      const dx = this.car.x - wreck.x, dy = this.car.y - wreck.y, length = Math.hypot(dx, dy);
      if (length > 105 + this.campaign.upgrades.winch * 25) { wreck.attached = false; this.events.push({ type: 'damage', message: 'ТРОС СОСКОЧИЛ · ПОДЪЕДЬ БЛИЖЕ' }); }
      else if (length > 19 && this.car.speed > 8) {
        const pull = Math.min(length - 18, dt * this.car.speed * (.45 + this.campaign.upgrades.winch * .13));
        const x = wreck.x + dx / length * pull, y = wreck.y + dy / length * pull;
        if (this.world.drivable(x, y, 4)) { wreck.x = x; wreck.y = y; wreck.progress = Math.min(100, wreck.progress + pull * 2.8); }
        if (wreck.progress >= 100) { wreck.rescued = true; wreck.attached = false; this.rescued++; this.burst(wreck.x, wreck.y, '#b8cba4', 40); this.events.push({ type: 'rescue', message: 'МАШИНА СПАСЕНА · +80 НА БАЗЕ' }); }
      }
    }
    this.pingTimer -= dt; const signal = this.signal;
    if (signal && this.pingTimer <= 0) { this.pingTimer = 1.5 - signal.strength * 1.25; this.events.push({ type: 'signal', strength: signal.strength, pan: Math.cos(signal.angle) }); }
    if (this.hull / this.maxHull < .3 && !this.warnedDamage) { this.warnedDamage = true; this.returning = true; this.events.push({ type: 'damage', message: 'КУЗОВ ПОВРЕЖДЁН · ВОЗВРАЩАЙСЯ' }); }
    if (this.hull <= 0) this.finish(true);
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
    const weight = 1 + this.load * .085 / (1 + upgrades.engine * .4);
    const targetSpeed = baseSpeed * (1 + upgrades.engine * .12) / weight * (this.towing ? .58 + upgrades.winch * .07 : 1) * (controls.brake ? .32 : c.boosting ? 1.72 : 1) * Math.min(1, input);
    let turning = 0;
    if (input > .05) {
      const difference = angleDifference(Math.atan2(iy, ix), c.angle);
      const turnRate = (controls.brake ? 7.5 : 4.9) * dt;
      turning = difference;
      c.angle += clamp(difference, -turnRate, turnRate);
    }
    const grip = (input > .05 ? (controls.brake ? 2.7 : c.boosting ? 4.8 : 8.2) : 5.4) * (ice ? Math.min(1, .19 + upgrades.tires * .18) : 1) / Math.sqrt(weight);
    const blend = 1 - Math.exp(-grip * dt);
    const current = this.world.current(c.x, c.y);
    c.vx += (Math.cos(c.angle) * targetSpeed + current.x - c.vx) * blend;
    c.vy += (Math.sin(c.angle) * targetSpeed + current.y - c.vy) * blend;
    if (c.boosting) p.energy = Math.max(0, p.energy - dt * .25 / (1 + upgrades.battery * .14));
    else p.energy = Math.min(1, p.energy + dt * .16 * (1 + upgrades.battery * .18));
    const oldX = c.x, oldY = c.y;
    let impact = 0;
    if (this.world.drivable(c.x + c.vx * dt, c.y)) c.x += c.vx * dt; else { impact = Math.abs(c.vx); c.vx *= -.12; this.route = []; }
    if (this.world.drivable(c.x, c.y + c.vy * dt)) c.y += c.vy * dt; else { impact = Math.max(impact, Math.abs(c.vy)); c.vy *= -.12; this.route = []; }
    if (impact > 45 && this.impactCooldown === 0) {
      this.impactCooldown = .8; this.hull = Math.max(0, this.hull - impact * .045 / (1 + upgrades.armor * .25));
      for (const item of this.cargo) if (item.kind === 'fragile') item.condition = Math.max(0, item.condition - 13 / (1 + upgrades.rack * .5));
      this.burst(c.x, c.y, '#cdb39d', 12); this.events.push({ type: 'damage', message: 'УДАР · БЕРЕГИ КУЗОВ И ОПТИКУ' });
    }
    c.speed = Math.hypot(c.vx, c.vy);
    const rough = terrain === Terrain.Stone || mud || ash || terrain === Terrain.Crystal;
    if (c.speed > 65 && (rough || c.drifting)) for (const item of this.cargo) if (item.kind === 'fragile') {
      item.condition = Math.max(0, item.condition - dt * (rough ? 5 : 2.2) * (c.speed / 100) / (1 + upgrades.rack * .65 + upgrades.tires * .3));
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
    if (controls.dash && p.dashCooldown === 0 && p.energy >= .2) {
      this.footDash = { x: this.lastDirection.x * 160, y: this.lastDirection.y * 160 };
      p.dashTime = .14; p.dashCooldown = .4; p.energy -= .2; this.events.push({ type: 'dash' });
      this.burst(p.x, p.y, '#dacdbc', 12, 24);
    }
    const speed = water ? 31 : 54, blend = 1 - Math.exp(-dt * 24);
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
}
