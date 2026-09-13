import { t } from '../i18n';
import { SIZE, Terrain, TILE, WORLD_SIZE } from './world';
import type { Point } from './world';
import type { Simulation, Track } from './simulation';
import { CARGO, REGIONS } from './campaign';
import { headlightField, lightKey, lightPoint } from './lighting';
import { RARE_PLACES } from './features';

const BG = '#17120f';
const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
export const trackOpacity = (track: Track): number => Math.pow(clamp(track.life / track.maxLife, 0, 1), 1.25) * (track.strong ? .95 : .72);
function surface(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D недоступен');
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

export function pixelLine(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number): void {
  let x = Math.round(ax), y = Math.round(ay);
  const ex = Math.round(bx), ey = Math.round(by), dx = Math.abs(ex - x), dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1, sy = y < ey ? 1 : -1;
  let error = dx + dy;
  for (let n = 0; n < 2048; n++) {
    ctx.fillRect(x, y, 1, 1); if (x === ex && y === ey) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  scale = 4;
  zoom = 4;
  peers: Simulation[] = [];
  carTows: { id: string; target: string }[] = [];
  pings: (Point & { label: string; ttl: number })[] = [];
  reducedMotion = false;
  camera: Point = { x: 0, y: 0 };
  private ground: HTMLCanvasElement[][] = [];
  private trees: HTMLCanvasElement[] = [];
  private cars: HTMLCanvasElement[] = [];
  private visibility = new Float32Array(SIZE * SIZE);
  private levels = new Float32Array(SIZE * SIZE);
  private shake = 0;
  private oldBoost = false;
  private spriteRegion = -1;
  private lightSignature = '';
  private lights = new Map<number, number>();
  private labels = new Map<string, HTMLCanvasElement>();

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D недоступен');
    this.ctx = ctx; this.buildSprites(); this.resize();
    void document.fonts.ready.then(() => this.labels.clear());
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.scale = Math.max(this.zoom, Math.ceil(rect.width / 960));
    this.width = this.canvas.width = Math.ceil(rect.width / this.scale);
    this.height = this.canvas.height = Math.ceil(rect.height / this.scale);
    this.ctx.imageSmoothingEnabled = false;
  }

  reset(sim: Simulation): void {
    this.lightSignature = '';
    if (this.spriteRegion !== sim.world.region) this.buildSprites(sim.world.region);
    this.camera.x = sim.player.x; this.camera.y = sim.player.y;
    this.visibility.fill(0); this.levels.fill(0); this.shake = 0;
    for (let i = 0; i < this.visibility.length; i++) {
      if (sim.world.explored[i]) this.visibility[i] = .2;
    }
  }

  private buildSprites(region = 0): void {
    this.spriteRegion = region; this.ground = []; this.trees = []; this.cars = [];
    for (let type = 0; type < 15; type++) {
      const variants: HTMLCanvasElement[] = [];
      for (let v = 0; v < 16; v++) {
        const { canvas, ctx: c } = surface(TILE, TILE);
        if (type === Terrain.Sand) {
          c.fillStyle = '#aa9161'; pixelLine(c, 0, 4 + v % 3, 5, 3 + v % 3); pixelLine(c, 5, 3 + v % 3, 11, 5 + v % 3);
          c.fillStyle = '#d7be82'; c.fillRect(3 + v % 5, 9, 1, 1);
        } else if (type === Terrain.Ash) {
          c.fillStyle = '#82716c'; c.fillRect(v % 6, 3, 2, 1); c.fillRect(8, 7, 1, 2);
          if (v % 4 === 0) { c.fillStyle = '#b96d4f'; c.fillRect(5, 9, 1, 1); }
        } else if (type === Terrain.Crystal) {
          c.fillStyle = '#9b88b2'; pixelLine(c, 3, 8, 5, 4); pixelLine(c, 5, 4, 7, 8); c.fillRect(3, 8, 5, 1);
          c.fillStyle = '#bcd9dd'; c.fillRect(5, 5, 1, 2); c.fillRect(10, 2 + v % 3, 1, 1);
        } else if (type === Terrain.Leaves) {
          c.fillStyle = '#aa8052'; c.fillRect(2, 4, 2, 1); c.fillRect(8, 9, 2, 1); c.fillStyle = '#ca9c62'; c.fillRect(v % 8, 8, 1, 1);
        } else if (type === Terrain.Wall) {
          c.fillStyle = '#645947'; c.fillRect(0, 0, TILE, TILE); c.fillStyle = '#a59980';
          c.fillRect(0, 0, TILE, 1); c.fillRect(0, 6, TILE, 1); c.fillRect(5, 0, 1, 6); c.fillRect(10, 6, 1, 6);
        } else if (type === Terrain.Narrow) {
          c.fillStyle = '#665039'; c.fillRect(3, 0, 6, TILE); c.fillStyle = '#c2a275';
          for (let y = 1; y < TILE; y += 3) c.fillRect(3, y, 6, 1);
        } else if (type === Terrain.Mud) {
          c.fillStyle = '#675236';
          c.fillRect(1 + v % 3, 3, 4, 1); c.fillRect(6, 8, 4, 1); c.fillRect(5, 4, 1, 2); c.fillRect(1, 9, 1, 1);
        } else if (type === Terrain.Ice) {
          c.fillStyle = '#688a98'; pixelLine(c, 0, 4, 7, 7); pixelLine(c, 7, 7, 9, 11); c.fillStyle = '#bbd2d0'; c.fillRect(3 + v % 3, 2, 2, 1);
        } else if (type === Terrain.Deep) {
          c.fillStyle = '#243840'; c.fillRect(0, 0, TILE, TILE); c.fillStyle = '#547787'; c.fillRect(1, 4, 5, 1); c.fillRect(7, 9, 4, 1);
        } else if (type === Terrain.Stone) {
          c.fillStyle = '#423b31'; c.fillRect(0,0,TILE,TILE);
          c.fillStyle = '#8f8270'; c.fillRect(1+v%3,3,3,1); c.fillRect(7,7+v%3,2,1); c.fillStyle='#655a49'; c.fillRect(5,1,1,2);
        } else if (type === Terrain.Water) {
          c.fillStyle = v % 3 ? '#6d8795' : '#8294a0';
          const phase = v % 4;
          for (let y = 2; y < TILE; y += 6) for (let x = -6; x < TILE; x += 7) {
            const off = phase + (y === 2 ? 0 : 3);
            c.fillRect(x + off, y, 2, 1); c.fillRect(x + off + 2, y + 1, 2, 1); c.fillRect(x + off + 4, y, 3, 1);
          }
        } else if (type === Terrain.Flowers) {
          c.fillStyle = '#b7b26d';
          if (v % 4 === 0) { c.fillRect(5, 5, 1, 3); c.fillRect(4, 6, 3, 1); c.fillRect(3, 9, 5, 1); }
          else { c.fillRect(6, 6, 1, 3); c.fillRect(4, 8, 5, 1); }
        } else {
          c.fillStyle = type === Terrain.Forest ? '#9c985c' : '#d4c8b9';
          if (v % 5 !== 0) c.fillRect(6, 6, 1, 1);
          if (v === 7) { c.fillStyle = '#b0a96a'; c.fillRect(4, 7, 4, 1); }
        }
        variants.push(canvas);
      }
      this.ground.push(variants);
    }
    for (let kind = 0; kind < 3; kind++) for (let pose = 0; pose < 3; pose++) {
      const { canvas, ctx: c } = surface(16, 25);
      c.fillStyle = REGIONS[region].trees[kind];
      const sway = pose - 1;
      if (region === 4) {
        c.fillRect(7, 6, 2, 18); c.fillRect(3, 12, 1, 7); c.fillRect(3, 18, 5, 1); c.fillRect(12, 9, 1, 6); c.fillRect(9, 14, 4, 1);
      } else if (region === 6) {
        pixelLine(c, 2, 23, 7, 5 + kind * 2); pixelLine(c, 7, 5 + kind * 2, 12, 23); pixelLine(c, 7, 7, 7, 23); c.fillRect(2, 23, 11, 1);
        c.fillStyle = '#d7e4ec'; c.fillRect(6 + sway, 12, 2, 1);
      } else if (region === 3 && kind < 2) {
        c.fillRect(7, 14, 1, 10); pixelLine(c, 3, 14, 1 + sway, 7); pixelLine(c, 1 + sway, 7, 7, 2); pixelLine(c, 7, 2, 13 + sway, 8); pixelLine(c, 13 + sway, 8, 11, 15); c.fillRect(3, 15, 9, 1);
      } else if (kind < 2) {
        const top = kind === 0 ? 2 : 8;
        c.fillRect(7, top + 3, 1, 21 - top);
        c.fillRect(6, top + 2, 3, 1); c.fillRect(7 + sway, top, 1, 2);
        for (let layer = 0; layer < (kind === 0 ? 4 : 3); layer++) {
          const y = top + 5 + layer * 4, reach = 2 + (layer > 1 ? 1 : 0);
          for (let n = 1; n <= reach; n++) { c.fillRect(7 - n + (layer === 0 ? sway : 0), y + n - 1, 1, 1); c.fillRect(7 + n + (layer === 0 ? sway : 0), y + n - 1, 1, 1); }
        }
        c.fillRect(5, 23, 5, 1);
      } else {
        c.fillRect(7, 16, 1, 7); c.fillRect(5, 23, 5, 1);
        for (let lobe = 0; lobe < 3; lobe++) {
          const x = lobe * 4 + 2, y = lobe === 1 ? 9 : 12;
          c.fillRect(x + sway, y + 1, 1, 8); c.fillRect(x + 3 + sway, y + 1, 1, 8); c.fillRect(x + 1 + sway, y, 2, 1);
        }
      }
      this.trees.push(canvas);
    }
    const car = [
      '  rrr  ',
      ' rrrrr ',
      'rrrrrrr',
      'rrddrrr',
      'rrddrrr',
      ' rrrrr ',
      'rrrrrrr',
      'rrrrrrr',
      ' rr rr ',
      ' rr rr ',
    ];
    for (let direction = 0; direction < 32; direction++) {
      const { canvas, ctx: c } = surface(21, 21);
      const angle = direction * Math.PI * 2 / 32 + Math.PI / 2;
      for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) {
        const dx = x - 10, dy = y - 10;
        const px = Math.round(dx * Math.cos(angle) + dy * Math.sin(angle) + 3);
        const py = Math.round(-dx * Math.sin(angle) + dy * Math.cos(angle) + 4.5);
        const pixel = car[py]?.[px];
        if (pixel === 'r' || pixel === 'd') { c.fillStyle = pixel === 'r' ? '#ef4547' : '#752c31'; c.fillRect(x, y, 1, 1); }
      }
      this.cars.push(canvas);
    }
  }

  screenToWorld(clientX: number, clientY: number): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left) / this.scale + this.camera.x - this.width / 2, y: (clientY - rect.top) / this.scale + this.camera.y - this.height / 2 };
  }

  render(sim: Simulation, dt: number): void {
    const c = this.ctx, w = this.width, h = this.height, p = sim.player, world = sim.world;
    const lookAhead = this.reducedMotion ? .1 : .36;
    const smooth = 1 - Math.exp(-dt * 7);
    this.camera.x += (clamp(p.x + p.vx * lookAhead, w / 2, WORLD_SIZE - w / 2) - this.camera.x) * smooth;
    this.camera.y += (clamp(p.y + p.vy * lookAhead, h / 2, WORLD_SIZE - h / 2) - this.camera.y) * smooth;
    if (sim.car.boosting && !this.oldBoost && !this.reducedMotion) this.shake = 1.3;
    this.oldBoost = sim.car.boosting;
    this.shake = Math.max(0, this.shake - dt * 6);
    const ox = Math.round(w / 2 - this.camera.x + Math.sin(sim.time * 60) * this.shake), oy = Math.round(h / 2 - this.camera.y);
    c.globalAlpha = 1; c.fillStyle = BG; c.fillRect(0, 0, w, h);
    if (world.region === 6 && sim.night > 0) {
      const phase = this.reducedMotion ? 0 : sim.time * .12;
      for (let x = 0; x < w; x += 6) {
        const y = Math.round(h * .2 + Math.sin(x / 95 + phase) * 17 + Math.sin(x / 41 - phase * .6) * 8);
        c.globalAlpha = sim.night * .1; c.fillStyle = '#87bfa8'; c.fillRect(x, y, 6, 10);
        c.globalAlpha = sim.night * .05; c.fillStyle = '#bda1d3'; c.fillRect(x, y + 10, 6, 15);
      }
      c.globalAlpha = 1;
    }
    c.save(); c.translate(ox, oy);
    const x0 = Math.max(0, Math.floor(-ox / TILE) - 2), x1 = Math.min(SIZE - 1, Math.ceil((w - ox) / TILE) + 2);
    const y0 = Math.max(0, Math.floor(-oy / TILE) - 2), y1 = Math.min(SIZE - 1, Math.ceil((h - oy) / TILE) + 3);
    const px = Math.floor(p.x / TILE), py = Math.floor(p.y / TILE), radius = sim.visibilityRadius;
    const crew = [sim, ...this.peers];
    const sources = crew.filter(s => Math.abs(s.car.x - this.camera.x) < w / 2 + 200 && Math.abs(s.car.y - this.camera.y) < h / 2 + 200).map(s => ({ x: Math.round(s.car.x / 2) * 2, y: Math.round(s.car.y / 2) * 2, angle: Math.round(s.car.angle * 50) / 50, headlights: s.headlights, level: s.campaign.upgrades.lamps, flood: s.hasModule('light') }));
    const signature = JSON.stringify(sources);
    if (signature !== this.lightSignature) { this.lights = headlightField(world, sources); this.lightSignature = signature; }
    const lights = this.lights;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * SIZE + x, d = Math.hypot(x - px, y - py);
      const jitter = (world.variants[i] - .5) * .75;
      const lampLight = world.lamps.some((l, index) => (index === 0 || sim.memory.lamps.includes(index)) && Math.hypot(l.x / TILE - x, l.y / TILE - y) < 4.5 && Math.hypot(l.x - p.x, l.y - p.y) < 230);
      const beam = (lights.get(lightKey(x * TILE + 6, y * TILE + 6)) ?? 0) > .15;
      const light = lampLight || d + jitter < radius - 2 ? 1 : d + jitter < radius - .8 || beam ? .65 : d + jitter < radius ? .4 : 0;
      const memory = world.explored[i] ? .18 : 0;
      const target = Math.max(memory, light);
      this.visibility[i] += (target - this.visibility[i]) * (this.reducedMotion ? 1 : 1 - Math.exp(-dt * 12));
      this.levels[i] = Math.round(this.visibility[i] * 8) / 8;
      if (this.levels[i] < .01) continue;
      const type = world.tiles[i], v = Math.floor(world.variants[i] * 16);
      const variant = type === Terrain.Water && !this.reducedMotion ? (v + Math.floor(sim.time * 4)) % 16 : v;
      c.drawImage(this.ground[type][variant], x * TILE, y * TILE);
      const road = sim.memory.roads[`${Math.floor(x / 2)}:${Math.floor(y / 2)}`] ?? 0;
      if (road >= 3) { c.fillStyle = '#a79264'; c.globalAlpha = .12 + road * .02; c.fillRect(x * TILE + 3, y * TILE, 2, TILE); c.fillRect(x * TILE + 8, y * TILE, 2, TILE); c.globalAlpha = 1; }
    }
    for (const wreck of world.wrecks) {
      c.fillStyle = '#88755d'; c.globalAlpha = .6;
      for (let i = 1; i < wreck.trail.length; i++) for (const side of [-3, 3]) pixelLine(c, wreck.trail[i - 1].x, wreck.trail[i - 1].y + side, wreck.trail[i].x, wreck.trail[i].y + side);
    }
    for (const driver of crew) for (const track of driver.tracks) {
      if (track.bx < -ox - 15 || track.by < -oy - 15 || track.bx > w - ox + 15 || track.by > h - oy + 15) continue;
      c.globalAlpha = trackOpacity(track);
      c.fillStyle = track.mud ? '#a48a62' : track.water ? '#a8b3ba' : track.strong ? '#e4d8cf' : '#bdb3a8';
      pixelLine(c, track.ax, track.ay, track.bx, track.by);
    }
    c.globalAlpha = 1;
    for (const tow of this.carTows) {
      const a = crew.find(s => s.actorId === tow.id), b = crew.find(s => s.actorId === tow.target);
      if (a && b && !a.docked && !b.docked) { c.fillStyle = '#b6c7b0'; pixelLine(c, a.car.x, a.car.y, b.car.x, b.car.y); }
    }
    const objects: { y: number; draw: () => void }[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * SIZE + x, type = world.tiles[i], v = world.variants[i];
      if (!(type === Terrain.Forest && v > .08 || type === Terrain.Meadow && v > .92 || [Terrain.Sand, Terrain.Ash, Terrain.Crystal, Terrain.Leaves].some(t => t === type) && v > .83)) continue;
      if (this.levels[i] < .01 && (this.levels[Math.max(0, i - SIZE)] ?? 0) < .01) continue;
      const wx = x * TILE + 6, wy = y * TILE + 11;
      const phase = this.reducedMotion ? 1 : Math.floor(sim.time * 3 + v * 9) % 3;
      const kind = v < .5 ? 0 : v < .75 ? 1 : 2;
      const dist = Math.hypot(wx - p.x, wy - p.y);
      const bend = !this.reducedMotion && dist < 19 ? Math.sign(p.vx) : 0;
      objects.push({ y: wy, draw: () => {
        c.globalAlpha = Math.abs(wx - p.x) < 8 && wy - p.y > 0 && wy - p.y < 18 ? .38 : 1;
        c.drawImage(this.trees[kind * 3 + phase], wx - 7 + bend, wy - 23);
      } });
    }
    objects.push({ y: world.camp.y, draw: () => this.drawBase(world.camp, sim.returnReady, sim.time) });
    objects.push({ y: world.rescueZone.y, draw: () => { this.drawBase(world.rescueZone, true, sim.time); this.label(world.rescueZone.x, world.rescueZone.y - 32, 'SOS', '#a7c4a3'); } });
    objects.push({ y: world.rare.y, draw: () => this.drawRare(sim) });
    const extra = sim.memory.drops.map(d => ({ ...d, ...d.item, collected: false }));
    const job = sim.memory.job;
    for (const cache of [...world.caches, ...extra, ...(job && !job.taken ? [{ ...job, collected: false }] : [])]) {
      if (cache.collected) continue;
      objects.push({ y: cache.y, draw: () => {
        c.globalAlpha = 1; const x = Math.round(cache.x), y = Math.round(cache.y);
        const bob = this.reducedMotion ? 0 : Math.round(Math.sin(sim.time * 3) * 1);
        c.fillStyle = CARGO[cache.kind].color; c.fillRect(x - 4, y - 8 + bob, 8, 8);
        c.fillStyle = '#f0e2a5'; c.fillRect(x - 3, y - 8 + bob, 6, 1);
        c.fillStyle = '#8e8545'; c.fillRect(x - 2, y - 5 + bob, 4, 1);
        if (cache.kind === 'volatile') { c.fillStyle = '#17120f'; c.fillRect(x, y - 7 + bob, 1, 3); c.fillRect(x, y - 3 + bob, 1, 1); }
        if (cache.kind === 'relic') { c.fillStyle = '#fff0b9'; c.fillRect(x - 1, y - 7 + bob, 2, 5); c.fillRect(x - 3, y - 5 + bob, 6, 1); }
      } });
    }
    for (const [index, lamp] of world.lamps.entries()) objects.push({ y: lamp.y, draw: () => {
      c.globalAlpha = 1; c.fillStyle = '#8c8154'; c.fillRect(Math.round(lamp.x), Math.round(lamp.y) - 15, 1, 16);
      c.fillStyle = index === 0 || sim.memory.lamps.includes(index) ? '#f1dfa2' : '#66604c'; c.fillRect(Math.round(lamp.x) - 2, Math.round(lamp.y) - 16, 5, 4);
      c.fillStyle = '#baaa69'; c.fillRect(Math.round(lamp.x) - 3, Math.round(lamp.y) - 13, 7, 1);
    } });
    for (const wreck of world.wrecks.filter(wreck => !wreck.rescued)) objects.push({ y: wreck.y, draw: () => {
      c.globalAlpha = 1; const x = Math.round(wreck.x), y = Math.round(wreck.y);
      c.fillStyle = wreck.rescued ? '#a2ba87' : '#aaa6a0'; c.fillRect(x - 5, y - 7, 10, 13); c.fillRect(x - 6, y - 4, 12, 2); c.fillRect(x - 6, y + 3, 12, 2);
      c.fillStyle = '#373330'; c.fillRect(x - 3, y - 4, 6, 3);
      if (!wreck.rescued && Math.floor(sim.time * 3) % 2 === 0) { c.fillStyle = '#e3a967'; c.fillRect(x - 5, y - 8, 2, 1); c.fillRect(x + 3, y - 8, 2, 1); }
      for (const id of wreck.helpers ?? []) { const helper = crew.find(s => s.actorId === id); if (helper) { c.fillStyle = '#98b9b1'; pixelLine(c, x, y, helper.car.x, helper.car.y); } }
      if (wreck.attached) { const owner = crew.find(s => s.actorId === wreck.attachedTo) ?? sim; c.fillStyle = wreck.tension > .8 ? '#d58063' : '#d4bd8c'; pixelLine(c, x, y, owner.car.x, owner.car.y); c.fillRect(x - 7, y - 13, 14, 1); c.fillRect(x - 7, y - 14, Math.round(wreck.progress / 100 * 14), 2); }
    } });
    for (const driver of crew) objects.push({ y: driver.car.y, draw: () => {
      c.globalAlpha = 1;
      const frame = ((Math.round(driver.car.angle / (Math.PI * 2) * 32) % 32) + 32) % 32;
      c.drawImage(this.cars[frame], Math.round(driver.car.x) - 10, Math.round(driver.car.y) - 10);
      driver.cargo.slice(0, 3).forEach((item, i) => { c.fillStyle = CARGO[item.kind].color; c.fillRect(Math.round(driver.car.x) - 2 + i * 2, Math.round(driver.car.y) - 2, 1, 2); });
      const ca = Math.cos(driver.car.angle), sa = Math.sin(driver.car.angle);
      for (const side of [-1, 1]) { c.fillStyle = driver.headlights ? '#fff0bc' : '#aa9682'; c.fillRect(Math.round(driver.car.x + ca * 7 - sa * side * 3), Math.round(driver.car.y + sa * 7 + ca * side * 3), 2, 2); }
      Object.entries(driver.campaign.progression.modules).forEach(([slot, id]) => {
        const offset = slot === 'front' ? 10 : slot === 'rear' ? -9 : 0;
        c.fillStyle = id === 'light' ? '#eadb9b' : id === 'scanner' ? '#a7c8c3' : '#ab9d83';
        const mx = Math.round(driver.car.x + ca * offset), my = Math.round(driver.car.y + sa * offset);
        c.fillRect(mx - 2, my - 2, slot === 'cargo' ? 5 : 3, slot === 'roof' ? 4 : 2);
      });
    } });
    for (const driver of crew) if (!driver.driving) objects.push({ y: driver.player.y, draw: () => this.drawPerson(driver) });
    const hunter = sim.expedition.hunter;
    if (hunter.state !== 'dormant' && hunter.state !== 'warning') objects.push({ y: hunter.y, draw: () => {
      c.globalAlpha = hunter.state === 'retreat' ? .25 : .75; c.fillStyle = '#3a303e';
      const hx = Math.round(hunter.x), hy = Math.round(hunter.y), step = Math.floor(sim.time * 5) % 2;
      c.fillRect(hx - 5, hy - 14, 11, 14); c.fillRect(hx - 7, hy - 8, 2, 11 + step * 3); c.fillRect(hx + 6, hy - 8, 2, 14 - step * 3);
      c.fillStyle = '#cf987b'; c.fillRect(hx - 3, hy - 12, 2, 1); c.fillRect(hx + 2, hy - 12, 2, 1);
    } });
    objects.sort((a, b) => a.y - b.y);
    for (const object of objects) object.draw();
    c.globalAlpha = 1;
    if (sim.nearbyWreck && !sim.driving) this.label(sim.nearbyWreck.x, sim.nearbyWreck.y - 21, '[E]', '#d7cb81');
    for (const wisp of world.wisps) {
      if (wisp.collected) continue;
      const x = Math.round(wisp.x), y = Math.round(wisp.y + (this.reducedMotion ? 0 : Math.sin(sim.time * 2 + wisp.phase) * 2));
      c.fillStyle = '#a5bb82'; c.fillRect(x, y - 3, 2, 6); c.fillRect(x - 2, y - 1, 6, 2);
    }
    for (const driver of crew) for (const ripple of driver.ripples) {
      const progress = 1 - ripple.life / ripple.maxLife;
      const radius = ripple.radius * (1 - (1 - progress) ** 2), aspect = ripple.radius < 20 ? .5 : 1;
      c.fillStyle = ripple.color; c.globalAlpha = (1 - progress) * .7;
      const segments = Math.max(12, Math.round(radius * 2));
      for (let j = 0; j < segments; j++) {
        if (j % 4 === 0) continue;
        const a = j / segments * Math.PI * 2;
        c.fillRect(Math.round(ripple.x + Math.cos(a) * radius), Math.round(ripple.y + Math.sin(a) * radius * aspect), 1, 1);
      }
    }
    for (const driver of crew) for (const particle of driver.particles) {
      c.globalAlpha = Math.ceil(particle.life / particle.maxLife * 4) / 4; c.fillStyle = particle.color;
      c.fillRect(Math.round(particle.x), Math.round(particle.y), particle.size, particle.size);
    }
    if (sim.route.length) {
      const to = sim.route[sim.route.length - 1]; c.globalAlpha = .6; c.fillStyle = '#c9c27d';
      c.fillRect(Math.round(to.x) - 3, Math.round(to.y), 7, 1); c.fillRect(Math.round(to.x), Math.round(to.y) - 3, 1, 7);
    }
    c.fillStyle = '#f4dda1';
    for (const [key, value] of lights) { const lp = lightPoint(key); if (lp.x < -ox || lp.y < -oy || lp.x > w - ox || lp.y > h - oy) continue; c.globalAlpha = value * (.14 + sim.night * .08); c.fillRect(lp.x, lp.y, 4, 4); }
    // The mask covers sprites and tracks too: every reveal edge stays on the tile grid.
    c.fillStyle = BG;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const level = this.levels[y * SIZE + x];
      if (level >= 1) continue;
      c.globalAlpha = 1 - level; c.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
    c.globalAlpha = 1;
    for (const driver of this.peers) if (!driver.docked && Math.hypot(driver.car.x - p.x, driver.car.y - p.y) < radius * TILE + 36) this.label(driver.car.x, driver.car.y - 16, driver.displayName.slice(0, 10), '#a9d0c8');
    for (const ping of this.pings) if (ping.ttl > 0) this.label(ping.x, ping.y - 12, t(ping.label), '#a9d0c8');
    if (sim.nearRare) this.label(world.rare.x, world.rare.y - 40, '[E]', '#c5acd0');
    if (sim.nearbyCache && sim.driving) this.label(sim.nearbyCache.x, sim.nearbyCache.y - 20, '[E]', '#d7cb81');
    else if (!sim.driving && sim.nearbyCache) this.label(sim.nearbyCache.x, sim.nearbyCache.y - 20, '[E]', '#d7cb81');
    else if (!sim.driving && sim.nearCar) this.label(sim.car.x, sim.car.y - 19, '[E]', '#d7b1a7');
    if (!sim.driving && sim.nearbyLamp > 0) this.label(world.lamps[sim.nearbyLamp].x, world.lamps[sim.nearbyLamp].y - 27, '[E]', '#e5dca9');
    if (sim.returnReady && sim.atCamp && !sim.docked) this.label(world.camp.x, world.camp.y - 25, '[E]', '#d7cb81');
    c.restore(); c.globalAlpha = 1;
    if (['warning','search','chase'].includes(hunter.state) && !sim.docked && !this.reducedMotion) { c.fillStyle='#a695aa'; c.globalAlpha=.08; for(let i=0;i<5;i++) { const y=(Math.floor(sim.time*13)+i*37)%h; c.fillRect((i*79+Math.floor(sim.time*7))%w,y,10+i*3,1); } c.globalAlpha=1; }
    this.drawBearing(sim, ox, oy);
    if (!this.reducedMotion && sim.storm > .1 && !sim.docked) {
      c.fillStyle = '#b5b3a2'; c.globalAlpha = sim.storm * .3;
      for (let i = 0; i < 80; i++) {
        const x = ((i * 47 + Math.floor(sim.time * 88)) % w + w) % w, y = (i * 71 + Math.floor(sim.time * 21)) % h;
        c.fillRect(x, y, 2 + i % 4, 1);
      }
      c.globalAlpha = 1;
    }
  }

  private label(x: number, y: number, text: string, color: string): void {
    const key = color + text;
    let sprite = this.labels.get(key);
    if (!sprite) {
      const { canvas, ctx } = surface(1, 12); ctx.font = '10px Tiny5';
      canvas.width = Math.ceil(ctx.measureText(text).width) + 4; ctx.font = '10px Tiny5'; ctx.fillStyle = color; ctx.fillText(text, 2, 10);
      sprite = canvas; if (this.labels.size > 100) this.labels.clear(); this.labels.set(key, sprite);
    }
    const left = Math.round(x) - Math.floor(sprite.width / 2), top = Math.round(y) - 10;
    this.ctx.fillStyle = BG; this.ctx.fillRect(left, top, sprite.width, 12); this.ctx.drawImage(sprite, left, top);
  }

  private drawRare(sim: Simulation): void {
    const c = this.ctx, x = Math.round(sim.world.rare.x), y = Math.round(sim.world.rare.y), region = sim.world.region;
    c.globalAlpha = 1; c.fillStyle = '#51473c'; c.fillRect(x - 18, y - 15, 37, 22);
    c.fillStyle = REGIONS[region].color;
    if (region === 0) { pixelLine(c, x - 24, y - 25, x + 24, y - 25); pixelLine(c, x, y, x, y - 45); c.fillRect(x - 15, y - 13, 8, 7); }
    else if (region === 1) { c.fillRect(x - 22, y - 20, 45, 3); c.fillStyle = '#6e9898'; for (let i = 0; i < 5; i++) c.fillRect(x - 24 + i * 10, y + 3 + Math.floor(sim.time * 2 + i) % 2, 7, 1); }
    else if (region === 2) { pixelLine(c, x - 34, y - 35, x + 34, y - 27); c.fillRect(x - 10, y - 25, 20, 14); c.fillStyle = '#343b44'; c.fillRect(x - 7, y - 22, 14, 7); }
    else if (region === 3) { for (const s of [-1, 1]) { c.fillRect(x + s * 18 - 5, y - 28, 11, 17); pixelLine(c, x + s * 18 - 8, y - 28, x + s * 18, y - 35); } }
    else if (region === 4) { for (let i = -15; i < 16; i++) c.fillRect(x + i, y - 15 - Math.round(Math.sqrt(225 - i * i)), 1, 3); pixelLine(c, x, y - 23, x + 25, y - 37); }
    else if (region === 5) { for (const s of [-1, 1]) pixelLine(c, x + s * 19, y + 5, x + s * 12, y - 38); for (let i = 0; i < 4; i++) c.fillRect(x - 12, y - 38 + i * 9, 25, 2); }
    else { for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2; pixelLine(c, x + Math.cos(a) * 22, y + Math.sin(a) * 12, x + Math.cos(a) * 10, y - 27); } }
    c.fillStyle = sim.memory.rare ? '#acd19a' : '#e1c885'; c.fillRect(x - 2, y - 9, 5, 7);
    if (sim.nearRare || sim.memory.rare && Math.hypot(sim.player.x - x, sim.player.y - y) < 60) { c.font = '8px Tiny5'; c.textAlign = 'center'; c.fillText(t(RARE_PLACES[region][0]), x, y + 18); }
  }

  private drawPerson(sim: Simulation): void {
    const c = this.ctx, p = sim.player;
    const x = Math.round(p.x), y = Math.round(p.y), stride = Math.hypot(p.vx, p.vy) > 2 ? Math.floor(p.stride) % 2 : 0;
    c.globalAlpha = 1; c.fillStyle = '#e8cdbd'; c.fillRect(x - 1, y - 7, 3, 2);
    c.fillStyle = '#e45f50'; c.fillRect(x - 2, y - 5, 5, 3);
    c.fillRect(x - 3 + stride, y - 4, 1, 2); c.fillRect(x + 3 - stride, y - 4, 1, 2);
    c.fillStyle = '#ddbaa2'; c.fillRect(x - 1 - stride, y - 2, 1, 2); c.fillRect(x + 1 + stride, y - 2, 1, 2);
    if (sim.carried) { c.fillStyle = CARGO[sim.carried.kind].color; c.fillRect(x - 3, y - 5, 7, 5); c.fillStyle = '#eadcb6'; c.fillRect(x, y - 5, 1, 5); }
  }

  private drawBase(point: Point, ready: boolean, time: number): void {
    const c = this.ctx, x = Math.round(point.x), y = Math.round(point.y);
    c.globalAlpha = 1; c.fillStyle = ready ? '#d1c574' : '#a9a15e';
    pixelLine(c, x - 8, y - 13, x, y - 21); pixelLine(c, x, y - 21, x + 8, y - 13);
    c.fillRect(x - 8, y - 13, 1, 14); c.fillRect(x + 8, y - 13, 1, 14); c.fillRect(x - 8, y, 17, 1);
    c.fillRect(x - 3, y - 7, 1, 7); c.fillRect(x + 3, y - 7, 1, 7); c.fillRect(x - 3, y - 7, 7, 1);
    c.fillRect(x + 12, y - 25, 1, 25);
    c.fillRect(x + 13, y - 25, 5 + (Math.floor(time * 3) % 2), 3);
    if (ready) { c.fillStyle = '#e9db97'; c.fillRect(x - 1, y - 13, 3, 3); }
  }

  private drawBearing(sim: Simulation, ox: number, oy: number): void {
    const c = this.ctx;
    if (sim.docked) return;
    const targets: (Point & {car: boolean})[] = [];
    if (sim.returning || sim.full || sim.hull / sim.maxHull < .3) targets.push({ ...sim.world.camp, car: false });
    if (!sim.driving && !sim.nearCar) targets.push({ x: sim.car.x, y: sim.car.y, car: true });
    if (sim.towing) targets.push({ ...sim.world.rescueZone, car: false });
    if (sim.expedition.last.phase === 'accepted') targets.push({ ...sim.expedition.last, car: false });
    for (const target of targets) {
      const dx = target.x - sim.player.x, dy = target.y - sim.player.y, distance = Math.hypot(dx, dy);
      if (distance < 35) continue;
      const angle = Math.atan2(dy, dx);
      const radius = Math.min(sim.driving ? 125 : 100, this.width * .37, this.height * .36);
      const x = clamp(sim.player.x + ox + Math.cos(angle) * radius, 13, this.width - 13);
      const y = clamp(sim.player.y + oy + Math.sin(angle) * radius, 22, this.height - 30);
      c.fillStyle = target.car ? '#e96556' : '#bbb062';
      c.globalAlpha = sim.pulseTime > 0 ? 1 : .7;
      const tipX = x + Math.cos(angle) * 4, tipY = y + Math.sin(angle) * 4;
      pixelLine(c, x + Math.cos(angle + 2.4) * 3, y + Math.sin(angle + 2.4) * 3, tipX, tipY);
      pixelLine(c, x + Math.cos(angle - 2.4) * 3, y + Math.sin(angle - 2.4) * 3, tipX, tipY);
      if (sim.returning || sim.pulseTime > 0) {
        c.font = '9px Tiny5'; c.textAlign = 'center'; c.fillText(t(target.car ? 'АВТО' : target.x === sim.world.rescueZone.x ? 'ПОСТ' : target.x === sim.expedition.last.x ? 'СИГНАЛ' : 'БАЗА'), Math.round(x), Math.round(y + 13));
      }
    }
    const signal = sim.signal;
    if (signal && !sim.returning) {
      const x = Math.round(sim.player.x + ox), y = Math.round(sim.player.y + oy);
      const phase = (sim.time / (1.5 - signal.strength * 1.25)) % 1;
      c.fillStyle = signal.rescue ? '#d1a270' : '#c8c68b';
      if (phase < .35 || sim.pulseTime > 0) {
        c.globalAlpha = .35 + signal.strength * .6;
        const radius = 17 + Math.round(phase * 8);
        for (let i = -3; i <= 3; i++) {
          const angle = signal.angle + i * (sim.driving ? .12 : .06);
          c.fillRect(Math.round(x + Math.cos(angle) * radius), Math.round(y + Math.sin(angle) * radius), 1, 1);
        }
      }
    }
    c.globalAlpha = 1;
  }

  drawMap(sim: Simulation, canvas: HTMLCanvasElement): void {
    const c = canvas.getContext('2d'); if (!c) return;
    c.imageSmoothingEnabled = false; const size = canvas.width, scale = size / WORLD_SIZE;
    c.fillStyle = BG; c.fillRect(0, 0, size, size);
    const colors = ['#6e6553', '#8c854c', '#607282', '#a49891', '#a39860', '#7c6f4d', '#725b3b', '#829ca5', '#b6a78e', '#b69568', '#29414c', '#b79f6b', '#89716b', '#9b8bad', '#a67c50'];
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x; if (!sim.world.explored[i]) continue;
      c.fillStyle = colors[sim.world.tiles[i]]; c.fillRect(x * TILE * scale, y * TILE * scale, Math.ceil(TILE * scale), Math.ceil(TILE * scale));
    }
    c.fillStyle = '#c6ba68';
    for (const cache of sim.world.caches) if (!cache.collected && cache.discovered) c.fillRect(Math.round(cache.x * scale) - 2, Math.round(cache.y * scale) - 2, 4, 4);
    sim.world.lamps.forEach((lamp, i) => {
      const x = Math.round(lamp.x * scale), y = Math.round(lamp.y * scale);
      c.fillStyle = sim.checkedLamps.includes(i) ? '#8cbe8b' : '#e7d694';
      c.fillRect(x - 2, y, 5, 1); c.fillRect(x, y - 2, 1, 5);
      if (i) { c.font = '16px Tiny5'; c.textAlign = 'left'; c.fillText(sim.checkedLamps.includes(i) ? '✓' : String(i), x + 5, y - 4); }
    });
    c.strokeStyle = '#d3c786'; c.strokeRect(Math.round(sim.world.camp.x * scale) - 3, Math.round(sim.world.camp.y * scale) - 3, 6, 6);
    c.fillStyle = '#e74344'; c.fillRect(Math.round(sim.car.x * scale) - 2, Math.round(sim.car.y * scale) - 2, 4, 4);
    const markers = [...sim.memory.drops.map(d => ({ ...d, label: '■', color: '#dfa878' })), ...(sim.memory.job && !sim.memory.job.taken ? [{ ...sim.memory.job, label: '■', color: '#8ac5bc' }] : []), { ...sim.world.rescueZone, label: '◆', color: '#b5cc96' }, ...(sim.memory.rareSeen ? [{ ...sim.world.rare, label: sim.memory.rare ? '✓' : '?', color: '#c5acd0' }] : []), ...this.peers.map(s => ({ ...s.player, label: '●', color: '#a9d0c8' }))];
    c.font = '14px Tiny5'; c.textAlign = 'center';
    for (const marker of markers) { c.fillStyle = marker.color; c.fillText(marker.label, Math.round(marker.x * scale), Math.round(marker.y * scale)); }
    if (!sim.driving) { c.fillStyle = '#e8cdbd'; c.fillRect(Math.round(sim.player.x * scale) - 1, Math.round(sim.player.y * scale) - 1, 3, 3); }
  }
}
