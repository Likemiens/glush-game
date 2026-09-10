import type { Campaign, Receipt } from './campaign';
import type { GroundCargo } from './inventory';
export type ModuleSlot = 'front' | 'roof' | 'cargo' | 'rear';
export type ModuleId = 'winch' | 'plow' | 'scanner' | 'light' | 'rack' | 'padding' | 'battery' | 'rescue';
export const MODULES: Record<ModuleId, { slot: ModuleSlot; name: string; hint: string; price: number; tier: number }> = {
  winch: { slot: 'front', name: 'Усиленная лебёдка', hint: '+40% тяги. Тише при натяжении.', price: 160, tier: 0 },
  plow: { slot: 'front', name: 'Отвал', hint: 'Меньше тряски и сопротивления грязи. Тяжелее руль.', price: 180, tier: 1 },
  scanner: { slot: 'roof', name: 'Дальний сканер', hint: '+250 м к сигналу. Импульс слышен охотнику.', price: 150, tier: 0 },
  light: { slot: 'roof', name: 'Прожектор', hint: 'Шире свет и лучше обзор. Заметнее в тумане.', price: 190, tier: 1 },
  rack: { slot: 'cargo', name: 'Грузовая рама', hint: 'Ещё ряд багажника. +10% массы.', price: 140, tier: 0 },
  padding: { slot: 'cargo', name: 'Защитная укладка', hint: 'Вдвое меньше урона хрупкому грузу.', price: 190, tier: 1 },
  battery: { slot: 'rear', name: 'Резервный аккумулятор', hint: 'Ускорение расходует на 35% меньше заряда.', price: 180, tier: 1 },
  rescue: { slot: 'rear', name: 'Спасательная сцепка', hint: 'Стабильнее прицеп. Дополнительная тяга.', price: 220, tier: 2 },
};
export type RuleId = 'normal' | 'night' | 'fog' | 'fragile' | 'convoy' | 'battery' | 'silent';
export const RULES: Record<RuleId, { name: string; hint: string; bonus: number; tier: number }> = {
  normal: { name: 'Обычный маршрут', hint: 'Спокойный поиск. До ночи 8 минут.', bonus: 0, tier: 0 },
  night: { name: 'Ночная смена', hint: 'Темно с самого выезда. Фонари — убежища.', bonus: .35, tier: 1 },
  fog: { name: 'Белая пелена', hint: 'Обзор меньше. Держись знакомых дорог.', bonus: .3, tier: 1 },
  fragile: { name: 'Тонкая работа', hint: 'Бонус за целую оптику. Она чувствительнее к ударам.', bonus: .4, tier: 0 },
  convoy: { name: 'Тяжёлый караван', hint: 'Бонус за двигатель или спасение. Прицепы тяжелее.', bonus: .45, tier: 1 },
  battery: { name: 'Последний заряд', hint: 'Ускорение не восстанавливается вне укрытий.', bonus: .35, tier: 1 },
  silent: { name: 'Радиомолчание', hint: 'Активный импульс выключен. Пассивный сигнал работает.', bonus: .3, tier: 0 },
};
export const RARE_PLACES = [
  ['Метеостанция', 'Диспетчер', 'На ленте барографа снова ровная линия. Кто-то отмечал здесь каждый рассвет.', 'Запустить передатчик'],
  ['Затопленная мастерская', 'Механик', 'Инструменты висят выше уровня воды. Мастер до последнего верил, что вернётся.', 'Поднять ящик'],
  ['Застывший фуникулёр', 'Механик', 'В кабине всё ещё лежат два билета. Обратная сторона одного — карта перевала.', 'Включить привод'],
  ['Тихая деревня', 'Неизвестный', 'Все окна смотрят на площадь. Только одно — в лес. Начни с него.', 'Открыть ставни'],
  ['Обсерватория', 'Неизвестный', 'Телескоп направлен под землю. Это не ошибка.', 'Настроить зеркало'],
  ['Заброшенная шахта', 'Механик', 'На стене мелом: «Мы слышали их снизу». Лифт поднимается пустым.', 'Поднять клетку'],
  ['Кристаллический узел', 'Неизвестный', 'Ты всё время восстанавливал связь. Теперь послушай, кто отвечает.', 'Согласовать частоту'],
] as const;
export type RegionMemory = {
  taken: number[]; rescued: number[]; wisps: number[]; lamps: number[]; discovered: number[];
  wrecks: { x: number; y: number; progress: number }[]; roads: Record<string, number>; roadTrips: Record<string, number>;
  drops: GroundCargo[]; rare: boolean; rareSeen: boolean;
  job: { id: number; x: number; y: number; kind: 'scrap' | 'fragile' | 'heavy'; taken: boolean; delivered: boolean } | null;
  sequence: number; lastDay: number;
};
export const createRegionMemory = (): RegionMemory => ({ taken: [], rescued: [], wisps: [], lamps: [], discovered: [], wrecks: [], roads: {}, roadTrips: {}, drops: [], rare: false, rareSeen: false, job: null, sequence: 0, lastDay: -1 });
export type RadioStoryState = { chapters: number[]; accepted: boolean[]; archive: string[] };
export type Progression = { radio: RadioStoryState; owned: ModuleId[]; modules: Partial<Record<ModuleSlot, ModuleId>>; rule: RuleId; rareCount: number };
export const createProgression = (): Progression => ({ radio: { chapters: [0, 0, 0], accepted: [false, false, false], archive: [] }, owned: [], modules: {}, rule: 'normal', rareCount: 0 });
const relays = (c: Campaign): number => c.relics.filter(Boolean).length;
const lamps = (c: Campaign): number => c.regions.reduce((n, r) => n + r.lamps.length, 0);
type Chapter = { title: string; text: string; objective: string; total: number; progress: (c: Campaign) => number };
export const STORIES: { voice: string; frequency: string; chapters: Chapter[] }[] = [
  { voice: 'Диспетчер Лада', frequency: '88.4', chapters: [
    { title: 'Есть кто живой?', text: 'Красная машина, ответь. На станции ещё есть свет. Привези три находки — соберём линию к лесу.', objective: 'Доставить 3 находки', total: 3, progress: c => c.delivered },
    { title: 'Три огонька', text: 'Я оставила фонари вдоль старой линии. Запусти их. Они будут ждать тебя каждую ночь.', objective: 'Восстановить 3 фонаря', total: 3, progress: lamps },
    { title: 'Сердце линии', text: 'Нужен сердечник из руин. Возьми его бережно. Я обещала человеку по ту сторону, что мы ещё поговорим.', objective: 'Восстановить первый ретранслятор', total: 1, progress: relays },
    { title: 'Семь голосов', text: 'Теперь на каждой частоте кто-то дышит. Верни остальные линии. В этот раз никто не останется один.', objective: 'Восстановить 7 ретрансляторов', total: 7, progress: relays },
  ] },
  { voice: 'Механик Марк', frequency: '104.2', chapters: [
    { title: 'Трос ещё цел', text: 'Наш караван не дошёл. На обочине осталась первая машина. Дотащи её до эвакуационного поста, я узнаю водителя.', objective: 'Доставить спасённую машину', total: 1, progress: c => c.rescued },
    { title: 'Запас хода', text: 'Он помнит поворот и три мотора в кузове. Собери двигатели: тяжёлый рейс потребует хорошей машины.', objective: 'Доставить 3 двигателя', total: 3, progress: c => c.stats.heavy },
    { title: 'Пятая машина', text: 'Каждая спасённая машина — ещё кусок маршрута. Нам осталось собрать колонну.', objective: 'Спасти 5 машин', total: 5, progress: c => c.rescued },
    { title: 'Своих не бросаем', text: 'Первые уже вернулись за остальными. Я оставлю свет в мастерской, сколько потребуется.', objective: 'Спасти 12 машин', total: 12, progress: c => c.rescued },
  ] },
  { voice: 'Голос без имени', frequency: '0.7', chapters: [
    { title: 'Между станциями', text: 'Ты слышишь меня в паузах. Найди место, которого нет на старой карте. Там осталась запись.', objective: 'Исследовать редкое место', total: 1, progress: c => c.progression.rareCount },
    { title: 'Эхо', text: 'Два передатчика слышат друг друга даже без питания. Ты уже заметил?', objective: 'Восстановить 2 ретранслятора', total: 2, progress: relays },
    { title: 'После заката', text: 'Днём здесь слышно только нас. Вернись из двух ночных рейсов с грузом. Потом поговорим.', objective: 'Вернуться с грузом ночью дважды', total: 2, progress: c => c.stats.nightRuns },
    { title: 'Кто отвечает', text: 'Я не прошу выключать свет. Дойди до последнего узла. Услышь ответ сам.', objective: 'Исследовать кристаллический узел', total: 1, progress: c => Number(c.regions[6].rare) },
  ] },
];
export function settleStories(c: Campaign, receipt: Receipt): void {
  STORIES.forEach((story, i) => {
    const state = c.progression.radio, chapter = story.chapters[state.chapters[i]];
    if (!chapter || !state.accepted[i] || chapter.progress(c) < chapter.total) return;
    const reward = 120 + state.chapters[i] * 100;
    state.archive.push(`${story.voice}: ${chapter.title}`); state.chapters[i]++; state.accepted[i] = false;
    c.credits += reward; c.research += 2; c.earned += reward; receipt.credits += reward; receipt.research += 2;
    receipt.messages.push(`${story.voice}: ${chapter.title} · +${reward}`);
    if (state.chapters[i] < 4) receipt.messages.push('Получена новая передача · Радио');
  });
}
export function installModule(c: Campaign, id: ModuleId): boolean {
  const def = MODULES[id]; if (!def || relays(c) < def.tier) return false;
  if (!c.progression.owned.includes(id)) {
    if (c.credits < def.price) return false;
    c.credits -= def.price; c.progression.owned.push(id);
  }
  if (c.progression.modules[def.slot] === id) delete c.progression.modules[def.slot];
  else c.progression.modules[def.slot] = id;
  return true;
}
