import type { CargoKind } from './campaign';

export type CargoPlacement = { x: number; y: number; rotation: number };
export type CargoItem = { id: number; uid?: string; region?: number; kind: CargoKind; condition: number; ttl: number; placement?: CargoPlacement };
export type GroundCargo = { x: number; y: number; item: CargoItem };
const SHAPES: Record<CargoKind, number[][]> = { scrap: [[0, 0], [0, 1]], fragile: [[0, 0], [1, 0]], volatile: [[0, 0], [0, 1]], heavy: [[0, 0], [1, 0], [0, 1], [1, 1]], relic: [[0, 0], [0, 1], [1, 1]] };
export function cells(kind: CargoKind, rotation = 0): number[][] {
  let points = SHAPES[kind].map(p => [...p]);
  for (let r = 0; r < ((rotation % 4) + 4) % 4; r++) points = points.map(([x, y]) => [-y, x]);
  const minX = Math.min(...points.map(p => p[0])), minY = Math.min(...points.map(p => p[1]));
  return points.map(([x, y]) => [x - minX, y - minY]);
}
export function fits(items: CargoItem[], item: CargoItem, at: CargoPlacement, rows: number): boolean {
  if (![at.x, at.y, at.rotation].every(Number.isInteger) || at.rotation < 0 || at.rotation > 3) return false;
  const occupied = new Set(items.filter(i => i !== item).flatMap(i => i.placement ? cells(i.kind, i.placement.rotation).map(([x, y]) => `${x + i.placement!.x}:${y + i.placement!.y}`) : []));
  return cells(item.kind, at.rotation).every(([dx, dy]) => {
    const x = at.x + dx, y = at.y + dy;
    return x >= 0 && x < 4 && y >= 0 && y < rows && !occupied.has(`${x}:${y}`);
  });
}
export function findPlacement(items: CargoItem[], item: CargoItem, rows: number): CargoPlacement | undefined {
  for (let y = 0; y < rows; y++) for (let x = 0; x < 4; x++) for (let rotation = 0; rotation < 4; rotation++) {
    const at = { x, y, rotation }; if (fits(items, item, at, rows)) return at;
  }
}
export function pack(items: CargoItem[], rows: number): boolean {
  const packed: CargoItem[] = [];
  const placements = new Map<CargoItem, CargoPlacement>();
  for (const item of [...items].sort((a, b) => cells(b.kind).length - cells(a.kind).length)) {
    const placement = findPlacement(packed, item, rows); if (!placement) return false;
    packed.push({ ...item, placement });
    placements.set(item, placement);
  }
  for (const item of items) item.placement = placements.get(item);
  return true;
}
export function cargoBalance(items: CargoItem[]): number {
  let moment = 0, mass = 0;
  for (const item of items) {
    const weight = item.kind === 'heavy' ? 3 : 1, shape = cells(item.kind, item.placement?.rotation);
    moment += shape.reduce((n, [x]) => n + x + (item.placement?.x ?? 0) - 1.5, 0) / shape.length * weight;
    mass += weight;
  }
  return mass ? moment / mass : 0;
}
