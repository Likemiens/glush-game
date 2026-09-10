import { Terrain, WORLD_SIZE } from './world';
import type { World, Point } from './world';
export const LIGHT_CELL = 4;
const WIDTH = WORLD_SIZE / LIGHT_CELL;
export const lightKey = (x: number, y: number): number => Math.floor(y / LIGHT_CELL) * WIDTH + Math.floor(x / LIGHT_CELL);
export type LightSource = Point & { angle: number; headlights: boolean; level: number; flood: boolean };
export function headlightField(world: World, sources: LightSource[]): Map<number, number> {
  const field = new Map<number, number>();
  for (const source of sources) {
    if (!source.headlights) continue;
    const ca = Math.cos(source.angle), sa = Math.sin(source.angle), range = 100 + source.level * 14 + Number(source.flood) * 30;
    const width = .26 + source.level * .02 + Number(source.flood) * .2;
    for (const side of [-1, 1]) {
      const origin = { x: source.x + ca * 8 - sa * side * 3, y: source.y + sa * 8 + ca * side * 3 };
      for (let ray = -18; ray <= 18; ray++) {
        const angle = source.angle + ray / 18 * width;
        const dx = Math.cos(angle), dy = Math.sin(angle);
        for (let d = 0; d < range; d += 3) {
          const x = origin.x + dx * d, y = origin.y + dy * d;
          if (x < 0 || y < 0 || x >= WORLD_SIZE || y >= WORLD_SIZE || world.at(x, y) === Terrain.Wall) break;
          const level = Math.ceil((1 - d / range) * (1 - Math.abs(ray) / 50) * 5) / 5, key = lightKey(x, y);
          field.set(key, Math.max(level, field.get(key) ?? 0));
        }
      }
    }
  }
  return field;
}
export function lightPoint(key: number): Point { return { x: key % WIDTH * LIGHT_CELL, y: Math.floor(key / WIDTH) * LIGHT_CELL }; }
