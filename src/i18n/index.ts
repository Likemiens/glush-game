import { english } from './en';

export type Language = 'en' | 'ru';
export const LANGUAGE_KEY = 'glush:language:v1';
let language: Language = 'en';
export const getLanguage = (): Language => language;
export function setLanguage(value: Language): void { language = value; }
export function readLanguage(storage: Pick<Storage, 'getItem'>): Language {
  try { return storage.getItem(LANGUAGE_KEY) === 'ru' ? 'ru' : 'en'; } catch { return 'en'; }
}
export function rememberLanguage(storage: Pick<Storage, 'setItem'>, value: Language): void {
  setLanguage(value);
  try { storage.setItem(LANGUAGE_KEY, value); } catch { /* The selection still works for this session. */ }
}

const extra: Readonly<Record<string, string>> = {
  'Игра Александра Варанцова': 'A game by Alexandr Varantsov',
  'Закрытый тест': 'Private playtest',
  'Кооператив для приглашённых друзей. Открой личную ссылку или вставь её ниже.': 'Co-op for invited friends. Open your private link or paste it below.',
  'Приглашение на тест': 'Playtest invitation',
  'Открыть тест →': 'Enter playtest →',
  'Одиночная игра →': 'Play solo →',
  'Проверяю приглашение…': 'Checking your invitation…',
  'Не удалось проверить приглашение.': 'Could not check your invitation. Try again.',
  'Кооператив доступен только по закрытому приглашению на тест.': 'Co-op requires a private playtest invitation.',
  'Язык': 'Language',
  '{0} с': '{0} s',
  'команда собирается на выезд': 'the crew is preparing to leave',
  'редкое место найдено': 'rare location found',
  'багажник полон': 'trunk full',
  'ГЛУШЬ — верни свет': 'GLUSH — Bring back the light',
  '+{0}% скорости. Больше тяги с грузом': '+{0}% speed. More pulling power with cargo',
  'Сетка 4 × {0}. Лучше крепления для оптики': 'Grid 4 × {0}. Better mounts for optics',
  'Сигнал с {0} м. Точнее направление': 'Signal range: {0} m. More precise direction',
  '{0} прочности. Меньше урон от ударов': '{0} durability. Less collision damage',
  'Быстрее зарядка. Ячейки живут {0} сек': 'Faster charging. Cells last {0} sec',
  'Верни сердце: {0}': 'Bring back the heart: {0}',
  'Нужно ретрансляторов: {0}': 'Relays required: {0}',
  'Сигнал {0}': 'Signal {0}',
  '{0} + в руках': '{0} + carrying',
};
const dictionary = { ...english, ...extra };
const rawPlayerMessages = new Set([
  '{0} на связи', '{0} подключил вторую лебёдку',
  '{0} готов. Выберите тот же район и нажмите «Выехать».',
]);
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = Object.entries(dictionary).filter(([source]) => /\{\d+\}/.test(source)).map(([source, target]) => {
  const slots: string[] = [];
  const parts = source.split(/(\{\d+\})/g);
  const expression = parts.map(part => /^\{\d+\}$/.test(part) ? (slots.push(part), '(.*?)') : escape(part)).join('');
  return { source, target, slots, regex: new RegExp('^' + expression + '$'), weight: source.replace(/\{\d+\}/g, '').length };
}).sort((a, b) => b.weight - a.weight);

/** Translate at the presentation boundary; saves and network messages keep their original values. */
export function t(source: string, locale: Language = language): string {
  if (locale === 'ru' || !/[а-яё]/i.test(source)) return source;
  const leading = source.match(/^\s*/)?.[0] ?? '', trailing = source.match(/\s*$/)?.[0] ?? '';
  const text = source.trim();
  return leading + translate(text, 0) + trailing;
}
function translate(text: string, depth: number): string {
  if (dictionary[text]) return dictionary[text];
  if (depth > 6 || !/[а-яё]/i.test(text)) return text;
  for (const pattern of patterns) {
    const match = pattern.regex.exec(text);
    if (!match) continue;
    const values = new Map(pattern.slots.map((slot, i) => [slot, rawPlayerMessages.has(pattern.source) ? match[i + 1] : translate(match[i + 1], depth + 1)]));
    return pattern.target.replace(/\{\d+\}/g, slot => values.get(slot) ?? slot);
  }
  const quoted = /^«(.*)»([.!?]?)$/.exec(text);
  if (quoted) return '“' + translate(quoted[1], depth + 1) + '”' + quoted[2];
  const decorated = /^([✓◆◇◉◌▸↻]\s*)(.+)$/.exec(text);
  if (decorated) return decorated[1] + translate(decorated[2], depth + 1);
  const level = /^(.*) (I{1,3}|IV|V)$/.exec(text);
  if (level) return translate(level[1], depth + 1) + ' ' + level[2];
  const coordinates = /^(.*)(, \d+:\d+)$/.exec(text);
  if (coordinates) return translate(coordinates[1], depth + 1) + coordinates[2];
  const pieces = text.split(/( · |: )/);
  if (pieces.length > 1) return pieces.map(part => /^( · |: )$/.test(part) ? part : translate(part, depth + 1)).join('');
  return text;
}
