export const TILE = 12;
export const SIZE = 192;
export const WORLD_SIZE = SIZE * TILE;
import type { CargoKind } from './campaign';
export const Terrain = { Meadow: 0, Forest: 1, Water: 2, Stone: 3, Flowers: 4, Path: 5, Mud: 6, Ice: 7, Wall: 8, Narrow: 9, Deep: 10, Sand: 11, Ash: 12, Crystal: 13, Leaves: 14 } as const;
export type Point = { x: number; y: number };
export type Cache = Point & { id: number; kind: CargoKind; collected: boolean; discovered: boolean; site: boolean };
export type Wisp = Point & { collected: boolean; phase: number };
export type Site = Point & { entrance: Point; kind: 'ruin' | 'island' };
export type Wreck = Point & { origin: Point; rescued: boolean; attached: boolean; attachedTo?: string; helpers?: string[]; progress: number; trail: Point[]; vx: number; vy: number; tension: number };

export function hashSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function random(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, seed: number): number {
  return noise(x, y, seed) * .62 + noise(x * 2.1, y * 2.1, seed + 7) * .26 + noise(x * 4.3, y * 4.3, seed + 19) * .12;
}

export class World {
  readonly tiles = new Uint8Array(SIZE * SIZE);
  readonly variants = new Float32Array(SIZE * SIZE);
  readonly explored = new Uint8Array(SIZE * SIZE);
  readonly camp: Point = { x: (SIZE / 2 + .5) * TILE, y: (SIZE / 2 + .5) * TILE };
  readonly caches: Cache[] = [];
  readonly wisps: Wisp[] = [];
  readonly sites: Site[] = [];
  readonly lamps: Point[] = [];
  readonly wrecks: Wreck[] = [];
  readonly rare: Point;
  readonly rescueZone: Point;
  exploredCount = 0;
  readonly seedNumber: number;

  constructor(readonly seed: string, readonly region = 0, readonly day = 1) {
    this.seedNumber = hashSeed(`${seed}:${region}`);
    const rng = random(this.seedNumber);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = y * SIZE + x;
        const height = fbm(x / 15, y / 15, this.seedNumber);
        const moisture = fbm(x / 9 + 70, y / 9 - 40, this.seedNumber + 129);
        const river = Math.abs(noise(x / 27, y / 27, this.seedNumber + 321) - .5);
        let tile: number = Terrain.Meadow;
        if (moisture > .48) tile = Terrain.Forest;
        if (moisture < .31) tile = Terrain.Flowers;
        if (height > .67) tile = Terrain.Stone;
        if ((height < .34 || river < .055) && height < .63) tile = Terrain.Water;
        if (moisture > (region === 1 ? .48 : .66) && height > .36 && height < .63) tile = Terrain.Mud;
        if (region === 2 && (height < .43 || river < .075)) tile = Terrain.Ice;
        if (region === 3 && tile !== Terrain.Water && tile !== Terrain.Stone) tile = moisture > .45 ? Terrain.Forest : Terrain.Leaves;
        if (region === 4) tile = height > .7 ? Terrain.Stone : height < .29 && moisture > .5 ? Terrain.Water : Terrain.Sand;
        if (region === 5) tile = height > .68 ? Terrain.Stone : moisture > .6 ? Terrain.Forest : Terrain.Ash;
        if (region === 6) tile = river < .08 ? Terrain.Ice : moisture > .42 ? Terrain.Crystal : Terrain.Meadow;
        if (x < 2 || y < 2 || x > SIZE - 3 || y > SIZE - 3) tile = Terrain.Stone;
        this.tiles[i] = tile;
        this.variants[i] = rng();
      }
    }
    const rotation = rng() * Math.PI * 2;
    const kinds: CargoKind[] = ['scrap', 'fragile', 'heavy', 'volatile', 'scrap', 'relic', 'heavy', 'fragile'];
    for (let i = 0; i < kinds.length; i++) {
      const angle = rotation + i * Math.PI * 2 / kinds.length + (rng() - .5) * .15;
      const radius = (i === 0 ? 17 : i === 1 ? 26 : i === 2 ? 35 : 44 + rng() * 27) * TILE;
      const x = Math.floor((this.camp.x + Math.cos(angle) * radius) / TILE) * TILE + TILE / 2;
      const y = Math.floor((this.camp.y + Math.sin(angle) * radius) / TILE) * TILE + TILE / 2;
      this.caches.push({ id: i, x, y, kind: kinds[i], collected: false, discovered: false, site: i === 2 || i === 5 || i === 7 });
      this.carveTrail(this.camp, { x, y });
      this.clearCircle(x, y, 2.1, Terrain.Meadow);
    }
    this.clearCircle(this.camp.x, this.camp.y, 2.8, Terrain.Meadow);
    this.lamps.push({ x: this.camp.x, y: this.camp.y });
    for (const i of [1, 3, 5]) {
      const cache = this.caches[i];
      this.lamps.push({ x: this.camp.x + (cache.x - this.camp.x) * .57, y: this.camp.y + (cache.y - this.camp.y) * .57 });
    }
    for (let i = 0; i < 2; i++) {
      let angle = rotation + (i === 0 ? .5 : 3.4);
      const radius = i === 0 ? 300 : 590;
      let origin = { x: this.camp.x + Math.cos(angle) * radius, y: this.camp.y + Math.sin(angle) * radius };
      while (this.caches.some(c => Math.hypot(c.x - origin.x, c.y - origin.y) < 130)) {
        angle += .12;
        origin = { x: this.camp.x + Math.cos(angle) * radius, y: this.camp.y + Math.sin(angle) * radius };
      }
      this.clearCircle(origin.x, origin.y, 4, region === 4 ? Terrain.Sand : region === 5 ? Terrain.Ash : Terrain.Mud);
      const trail = Array.from({ length: 30 }, (_, n) => ({ x: origin.x - Math.cos(angle) * n * 4, y: origin.y - Math.sin(angle) * n * 4 + Math.sin(n * .2) * 8 }));
      this.wrecks.push({ ...origin, origin: { ...origin }, rescued: false, attached: false, progress: 0, trail, vx: 0, vy: 0, tension: 0 });
    }
    for (const cache of this.caches.filter(c => c.site)) this.buildSite(cache, cache.id === 7 ? 'island' : 'ruin');
    for (let i = 0; i < 14; i++) {
      const x = (12 + rng() * (SIZE - 24)) * TILE;
      const y = (12 + rng() * (SIZE - 24)) * TILE;
      if (this.drivable(x, y)) this.wisps.push({ x, y, collected: false, phase: rng() * Math.PI * 2 });
    }
    for (const cache of this.caches) {
      const x = this.camp.x + (cache.x - this.camp.x) * .6;
      const y = this.camp.y + (cache.y - this.camp.y) * .6;
      if (this.drivable(x, y)) this.wisps.push({ x, y, collected: false, phase: rng() * Math.PI * 2 });
    }
    this.rare = this.findClearing('rare', 850);
    const posts = Array.from({ length: 24 }, (_, i) => this.findClearing(`rescue:${i}`, 1100));
    posts.sort((a, b) => Math.min(...this.wrecks.map(w => Math.hypot(w.x - b.x, w.y - b.y))) - Math.min(...this.wrecks.map(w => Math.hypot(w.x - a.x, w.y - a.y))));
    this.rescueZone = posts[0];
  }

  findClearing(key: string, distance = 600): Point {
    const rng = random(hashSeed(`${this.seed}:${this.region}:${key}`));
    for (let i = 0; i < 1000; i++) {
      const a = rng() * Math.PI * 2, r = distance * (.85 + rng() * .15);
      const p = { x: this.camp.x + Math.cos(a) * r, y: this.camp.y + Math.sin(a) * r };
      if (this.drivable(p.x, p.y, 28) && this.sites.every(s => Math.hypot(s.x - p.x, s.y - p.y) > 120)) return p;
    }
    return { x: this.camp.x + 60, y: this.camp.y };
  }

  private buildSite(cache: Cache, kind: Site['kind']): void {
    const cx = Math.floor(cache.x / TILE), cy = Math.floor(cache.y / TILE), radius = 4;
    for (let y = cy - radius; y <= cy + radius; y++) for (let x = cx - radius; x <= cx + radius; x++) {
      const edge = Math.abs(x - cx) === radius || Math.abs(y - cy) === radius;
      this.tiles[y * SIZE + x] = edge ? (kind === 'island' ? Terrain.Deep : Terrain.Wall) : Terrain.Meadow;
    }
    this.tiles[(cy + radius) * SIZE + cx] = Terrain.Narrow;
    this.clearCircle(cache.x, (cy + radius + 3) * TILE + 6, 2, Terrain.Path);
    this.sites.push({ x: cache.x, y: cache.y, kind, entrance: { x: cache.x, y: (cy + radius + 2) * TILE + 6 } });
  }

  private clearCircle(wx: number, wy: number, radius: number, tile: number): void {
    const cx = Math.floor(wx / TILE), cy = Math.floor(wy / TILE);
    for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
      for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
        if (x > 1 && y > 1 && x < SIZE - 2 && y < SIZE - 2 && Math.hypot(x - cx, y - cy) < radius) {
          this.tiles[y * SIZE + x] = tile;
        }
      }
    }
  }

  private carveTrail(from: Point, to: Point): void {
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (TILE / 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const bend = Math.sin(t * Math.PI * 3) * 18 * Math.sin(t * Math.PI);
      this.clearCircle(from.x + (to.x - from.x) * t + bend, from.y + (to.y - from.y) * t, 1.6, Terrain.Path);
    }
  }

  at(x: number, y: number): number {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return Terrain.Stone;
    return this.tiles[ty * SIZE + tx];
  }

  walkable(x: number, y: number, radius = 3): boolean {
    return this.passable(x, y, radius, false);
  }

  drivable(x: number, y: number, radius = 6): boolean { return this.passable(x, y, radius, true); }

  private passable(x: number, y: number, radius: number, driving: boolean): boolean {
    if (x - radius < TILE * 2 || y - radius < TILE * 2 || x + radius >= WORLD_SIZE - TILE * 2 || y + radius >= WORLD_SIZE - TILE * 2) return false;
    for (const [dx, dy] of [[-radius, -radius], [radius, -radius], [-radius, radius], [radius, radius], [0, 0]]) {
      const type = this.at(x + dx, y + dy);
      if (type === Terrain.Wall || type === Terrain.Deep || driving && type === Terrain.Narrow) return false;
    }
    return true;
  }

  current(x: number, y: number): Point {
    if (this.at(x, y) !== Terrain.Water) return { x: 0, y: 0 };
    const angle = Math.sin(y / 130 + this.seedNumber % 10) * .7;
    const force = this.region === 1 ? 21 : 11;
    return { x: Math.cos(angle) * force, y: Math.sin(angle) * force };
  }

  sight(from: Point, to: Point): boolean {
    const steps = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 3);
    for (let i = 1; i < steps; i++) if (this.at(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps) === Terrain.Wall) return false;
    return true;
  }

  reveal(wx: number, wy: number, radius: number): void {
    const cx = Math.floor(wx / TILE), cy = Math.floor(wy / TILE);
    for (let y = Math.max(0, cy - radius); y <= Math.min(SIZE - 1, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(SIZE - 1, cx + radius); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) continue;
        const i = y * SIZE + x;
        if (!this.explored[i]) { this.explored[i] = 1; this.exploredCount++; }
      }
    }
  }

}
