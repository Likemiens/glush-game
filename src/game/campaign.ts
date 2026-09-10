import { createProgression, createRegionMemory } from './features';
import type { Progression, RegionMemory } from './features';
export type { RegionMemory } from './features';
export type UpgradeId = 'engine' | 'tires' | 'lamps' | 'rack' | 'scanner' | 'winch' | 'armor' | 'battery';
export type CargoKind = 'scrap' | 'heavy' | 'fragile' | 'volatile' | 'relic';
export const CARGO: Record<CargoKind, { name: string; short: string; slots: number; value: number; color: string; hint: string }> = {
  scrap: { name: 'Детали', short: 'Д', slots: 1, value: 40, color: '#c6b57e', hint: 'Материалы для мастерской' },
  heavy: { name: 'Двигатель', short: 'Т', slots: 2, value: 85, color: '#bba99b', hint: '2 места. Замедляет машину' },
  fragile: { name: 'Оптика', short: 'Х', slots: 1, value: 95, color: '#88c6c6', hint: 'Вези аккуратно. Целая оптика даёт схему' },
  volatile: { name: 'Ячейка', short: '!', slots: 1, value: 120, color: '#e89664', hint: 'Доставь до разряда' },
  relic: { name: 'Сердце ретранслятора', short: '◆', slots: 2, value: 180, color: '#d8d28a', hint: '2 места. Возвращает связь в районе' },
};
export const MAX_LEVEL = 5;
type Upgrade = { name: string; icon: string; prices: number[]; research: number[]; effects: string[] };
const costs = (base: number): number[] => [1, 1.9, 3.2, 4.9, 7.1].map(n => Math.round(base * n / 5) * 5);
const upgrade = (name: string, icon: string, base: number, effects: string[]): Upgrade => ({ name, icon, prices: costs(base), research: [0, 1, 1, 2, 3], effects });
export const UPGRADES: Record<UpgradeId, Upgrade> = {
  engine: upgrade('Двигатель', '↗', 80, Array.from({ length: 5 }, (_, i) => '+' + (i + 1) * 12 + '% скорости. Больше тяги с грузом')),
  tires: upgrade('Шины', '◉', 65, ['Лучше едут по грязи. Открывают топи', 'Сцепление на льду и защита от тряски', 'Уверенный ход по песку и пеплу', 'Почти не скользят на льду', 'Максимальная проходимость']),
  lamps: upgrade('Фары', '☀', 65, ['Больше обзор, меньше воздействия тумана', 'Широкий свет, надёжнее ночью', 'Проникают сквозь пепельную бурю', 'Освещают хрустальную долину', 'Максимальная защита от тумана']),
  rack: upgrade('Багажник', '▦', 70, Array.from({ length: 5 }, (_, i) => 'Сетка 4 × ' + (4 + i) + '. Лучше крепления для оптики')),
  scanner: upgrade('Сканер', '◎', 70, Array.from({ length: 5 }, (_, i) => 'Сигнал с ' + (390 + i * 140) + ' м. Точнее направление')),
  winch: upgrade('Лебёдка', '↔', 60, ['Быстрее вытаскивает машины', 'Длиннее трос, больше тяги', 'Усиленный трос для тяжёлых спасений', 'Быстрая буксировка', 'Максимальная тяга и длина троса']),
  armor: upgrade('Защита кузова', '◇', 75, Array.from({ length: 5 }, (_, i) => (120 + i * 20) + ' прочности. Меньше урон от ударов')),
  battery: upgrade('Аккумулятор', 'ϟ', 70, Array.from({ length: 5 }, (_, i) => 'Быстрее зарядка. Ячейки живут ' + (87 + i * 12) + ' сек')),
};
export const REGIONS = [
  { name: 'Опушка', subtitle: 'Лесные дороги и первые сигналы', risk: 1, color: '#b4ae68', trees: ['#b5ad61', '#aaa464', '#c0b96c'], value: 1 },
  { name: 'Топи', subtitle: 'Глубокая грязь и сильное течение', risk: 1.35, color: '#92b19b', trees: ['#7d9d7b', '#90a57a', '#aaba85'], value: 1.3 },
  { name: 'Белый перевал', subtitle: 'Лёд, инерция и холодные ночи', risk: 1.6, color: '#a9bdce', trees: ['#9bacbb', '#8aa1b5', '#c0ced0'], value: 1.65 },
  { name: 'Янтарный лес', subtitle: 'Осенние кроны и заросшие руины', risk: 1.8, color: '#d5a46b', trees: ['#cc915a', '#bc7354', '#e0b176'], value: 2 },
  { name: 'Поющие дюны', subtitle: 'Песок, сухие русла и древние маяки', risk: 2.1, color: '#d4bc85', trees: ['#b6a277', '#c8b482', '#d3bd8b'], value: 2.4 },
  { name: 'Пепельный край', subtitle: 'Вулканический пепел и опасные бури', risk: 2.5, color: '#bb877b', trees: ['#9b8178', '#857373', '#b09a89'], value: 2.85 },
  { name: 'Хрустальная долина', subtitle: 'Кристаллы, северное сияние и последний сигнал', risk: 2.9, color: '#bca7d3', trees: ['#9da5cc', '#b7a2cb', '#a9c6d5'], value: 3.3 },
] as const;
export interface Campaign {
  seed: string; day: number; credits: number; research: number;
  delivered: number; rescued: number; expeditions: number; earned: number;
  upgrades: Record<UpgradeId, number>; relics: boolean[]; claimed: boolean[]; survey: string[];
  regions: RegionMemory[]; scouted: number[];
  progression: Progression;
  stats: { fragile: number; volatile: number; heavy: number; patrols: number; cleanRuns: number; nightRuns: number };
}
export type Receipt = { credits: number; research: number; delivered: number; rescued: number; lost: boolean; messages: string[] };
type Contract = { name: string; description: string; credits: number; research: number; total: number; progress: (c: Campaign) => number; available: (c: Campaign) => boolean };
const relays = (c: Campaign): number => c.relics.filter(Boolean).length;
const contract = (name: string, description: string, total: number, credits: number, research: number, progress: (c: Campaign) => number, available: (c: Campaign) => boolean = () => true): Contract =>
  ({ name, description, total, credits, research, progress: c => Math.min(total, progress(c)), available });
export const CONTRACTS: Contract[] = [
  contract('Первый рейс', 'Доставь 3 находки', 3, 80, 1, c => c.delivered),
  contract('Своих не бросаем', 'Спаси одну машину', 1, 100, 1, c => c.rescued),
  contract('Голос в тумане', 'Верни первое сердце ретранслятора', 1, 140, 2, relays),
  contract('Ближний круг', 'Восстанови связь в трёх районах', 3, 300, 3, relays, c => relays(c) > 0),
  contract('Тонкая работа', 'Доставь 2 оптики с целостностью от 80%', 2, 150, 2, c => c.stats.fragile, c => c.delivered >= 3),
  contract('Проверка линии', 'Проверь три полевых фонаря за выезд и вернись', 1, 100, 1, c => c.stats.patrols, c => c.delivered >= 1),
  contract('Тяжёлая смена', 'Доставь 3 двигателя', 3, 220, 2, c => c.stats.heavy, c => relays(c) >= 1),
  contract('До последней искры', 'Доставь 2 ячейки до разряда', 2, 220, 2, c => c.stats.volatile, c => relays(c) >= 1),
  contract('Бережный водитель', 'Заверши 3 доставки с кузовом от 90%', 3, 180, 2, c => c.stats.cleanRuns, c => c.delivered >= 3),
  contract('Ночная смена', 'Вернись с грузом после наступления ночи', 1, 200, 2, c => c.stats.nightRuns, c => relays(c) >= 2),
  contract('Служба спасения', 'Спаси 5 машин', 5, 380, 3, c => c.rescued, c => c.rescued >= 1),
  contract('Дальняя дорога', 'Доставь 15 находок', 15, 400, 3, c => c.delivered, c => relays(c) >= 2),
  contract('Янтарный голос', 'Верни сердце Янтарного леса', 1, 350, 3, c => Number(c.relics[3]), c => c.relics[2]),
  contract('Песни песка', 'Верни сердце Поющих дюн', 1, 450, 3, c => Number(c.relics[4]), c => c.relics[3]),
  contract('Сквозь пепел', 'Верни сердце Пепельного края', 1, 550, 4, c => Number(c.relics[5]), c => c.relics[4]),
  contract('Исследователь', 'Разведай 12000 клеток мира', 12000, 500, 3, c => c.scouted.reduce((a, b) => a + b, 0), c => relays(c) >= 2),
  contract('Опытная рука', 'Доставь 8 целых оптик', 8, 500, 4, c => c.stats.fragile, c => c.stats.fragile >= 2),
  contract('Держать связь', 'Заверши 5 патрулей фонарей', 5, 350, 3, c => c.stats.patrols, c => c.stats.patrols >= 1),
  contract('Большой караван', 'Доставь 35 находок', 35, 700, 4, c => c.delivered, c => c.delivered >= 15),
  contract('Свет возвращается', 'Восстанови все семь ретрансляторов', 7, 1200, 6, relays, c => relays(c) >= 3),
  contract('Мастер спасения', 'Спаси 12 машин', 12, 800, 4, c => c.rescued, c => c.rescued >= 5),
  contract('Своя мастерская', 'Купи 24 уровня улучшений', 24, 700, 4, c => Object.values(c.upgrades).reduce((a, b) => a + b, 0), c => relays(c) >= 3),
];
export function createCampaign(seed = 'MOSS-0842'): Campaign {
  return { seed, day: 1, credits: 0, research: 0, delivered: 0, rescued: 0, expeditions: 0, earned: 0,
    upgrades: { engine: 0, tires: 0, lamps: 0, rack: 0, scanner: 0, winch: 0, armor: 0, battery: 0 },
    relics: REGIONS.map(() => false), claimed: CONTRACTS.map(() => false), survey: REGIONS.map(() => ''),
    regions: REGIONS.map(createRegionMemory), scouted: REGIONS.map(() => 0), progression: createProgression(),
    stats: { fragile: 0, volatile: 0, heavy: 0, patrols: 0, cleanRuns: 0, nightRuns: 0 } };
}
export function levelLimit(c: Campaign): number { return Math.min(MAX_LEVEL, 2 + Math.floor(relays(c) / 2)); }
export function regionLock(c: Campaign, region: number, shared = false): string {
  if (shared) return regionLock({ ...c, upgrades: { engine: 5, tires: 5, lamps: 5, rack: 5, scanner: 5, winch: 5, armor: 5, battery: 5 } }, region);
  if (region === 0) return '';
  if (region === 1) return c.delivered < 3 && c.stats.patrols < 1 ? 'Доставь 3 находки или заверши патруль' : c.upgrades.tires < 1 ? 'Нужны шины I' : '';
  if (region === 2) return !c.relics[1] ? 'Верни сердце топей' : c.upgrades.lamps < 1 ? 'Нужны фары I' : c.upgrades.scanner < 1 ? 'Нужен сканер I' : '';
  const gates: Record<number, [UpgradeId, number][]> = { 3: [['engine', 2], ['tires', 2]], 4: [['engine', 3], ['battery', 2]], 5: [['armor', 3], ['lamps', 3]], 6: [['scanner', 4], ['lamps', 4]] };
  if (!gates[region]) return 'Район недоступен';
  if (!c.relics[region - 1]) return 'Верни сердце: ' + REGIONS[region - 1].name;
  const missing = gates[region].find(([id, level]) => c.upgrades[id] < level);
  return missing ? UPGRADES[missing[0]].name + ' ' + ['','I','II','III','IV','V'][missing[1]] : '';
}
export function upgradeLock(c: Campaign, id: UpgradeId): string {
  if (c.upgrades[id] >= MAX_LEVEL) return 'Максимальный уровень';
  if (c.upgrades[id] >= levelLimit(c)) return 'Нужно ретрансляторов: ' + ((c.upgrades[id] - 1) * 2);
  return '';
}
export function buyUpgrade(c: Campaign, id: UpgradeId): boolean {
  const def = UPGRADES[id], level = c.upgrades[id];
  if (!def || upgradeLock(c, id) || c.credits < def.prices[level] || c.research < def.research[level]) return false;
  c.credits -= def.prices[level]; c.research -= def.research[level]; c.upgrades[id]++; return true;
}
export function activeContracts(c: Campaign): Contract[] { return CONTRACTS.filter((q, i) => !c.claimed[i] && q.available(c)); }
export function settleContracts(c: Campaign, receipt: Receipt): void {
  CONTRACTS.forEach((q, i) => {
    if (!c.claimed[i] && q.available(c) && q.progress(c) >= q.total) {
      c.claimed[i] = true; c.credits += q.credits; c.earned += q.credits; c.research += q.research;
      receipt.credits += q.credits; receipt.research += q.research; receipt.messages.push(q.name + ' · +' + q.credits + ' деталей');
    }
  });
}
