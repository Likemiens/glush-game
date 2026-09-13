import test from 'node:test';
import assert from 'node:assert/strict';
import { CARGO, CONTRACTS, REGIONS, UPGRADES, createCampaign, regionLock, upgradeLock } from '../src/game/campaign';
import { MODULES, RULES, RARE_PLACES, STORIES, settleStories } from '../src/game/features';
import { LANGUAGE_KEY, getLanguage, readLanguage, rememberLanguage, setLanguage, t } from '../src/i18n';
import { snapshot } from '../src/game/snapshot';
import { makeExpedition } from '../src/game/storage';

const translated = (value: string): void => { assert(!/[а-яё]/i.test(t(value, 'en')), `Missing English: ${value} => ${t(value, 'en')}`); assert.equal(t(value, 'ru'), value); };
test('English covers cargo, all upgrades, regions, radio chapters, rare places and expedition rules', () => {
  for (const item of Object.values(CARGO)) for (const key of ['name', 'short', 'hint'] as const) translated(item[key]);
  for (const item of Object.values(UPGRADES)) { translated(item.name); item.effects.forEach(translated); }
  for (const item of REGIONS) { translated(item.name); translated(item.subtitle); }
  for (const item of CONTRACTS) { translated(item.name); translated(item.description); }
  for (const item of [...Object.values(MODULES), ...Object.values(RULES)]) { translated(item.name); translated(item.hint); }
  RARE_PLACES.flat().forEach(translated);
  for (const story of STORIES) {
    translated(story.voice);
    for (const chapter of story.chapters) { translated(chapter.title); translated('«' + chapter.text + '»'); translated(chapter.objective); }
  }
});
test('Dynamic HUD, saved radio archive, rewards, locks and nested text translate without losing numbers', () => {
  const c = createCampaign();
  c.delivered = 3; c.progression.radio.accepted[0] = true;
  const receipt = { credits: 0, research: 0, delivered: 3, rescued: 0, lost: false, messages: [] as string[] };
  settleStories(c, receipt); c.progression.radio.archive.forEach(translated); receipt.messages.forEach(translated);
  for (let region = 0; region < 7; region++) translated(regionLock(c, region));
  c.upgrades.engine = 3; translated(upgradeLock(c, 'engine'));
  [
    'Кузов 73%', 'Ускорение: 88%', 'Сигнал ▮▮▮··', '12/12 + в руках',
    '◉ На связи 3/5 · команда собирается на выезд', 'Ячейка 46 с · Оптика 95%',
    '◆ Усиленная лебёдка', 'Двигатель III', 'Оптика, 2:3',
    '+1,200 деталей · +4 схем', 'Нужно ещё 1,100 деталей',
    'Находок 4 · спасений 1/2 · свет 2/3 · редкое место найдено',
    '431 м до сигнала · крюк ≈2 мин · нестабильный груз · багажник полон',
    '100% · 42 деталей · 64 с', 'Диспетчер Лада: Три огонька · +220',
    'Двигатель · неси к машине', 'Верни сердце: Поющие дюны',
  ].forEach(translated);
  assert.equal(t('Кузов 73%', 'en'), 'Body 73%');
  assert.equal(t('12/12 + в руках', 'en'), '12/12 + carrying');
  assert.equal(t('Диспетчер Лада: Три огонька · +220', 'en'), 'Lada, dispatcher: Three little lights · +220');
});
test('Player names, invitations and protocol labels keep their exact values', () => {
  assert.equal(t('Детали на связи', 'en'), 'Детали is on the air');
  assert.equal(t('Радио  Марк подключил вторую лебёдку', 'en'), 'Радио  Марк attached a second winch');
  const link = 'https://glush.varantsov.ru/#room=abc&invite=0123';
  assert.equal(t(link, 'en'), link);
  assert.equal(t('My callsign', 'en'), 'My callsign');
});
test('English is the default; the language setting is isolated from the campaign and survives reload', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  assert.equal(readLanguage(storage), 'en');
  const sim = makeExpedition(createCampaign('locale-migration')); sim.campaign.credits = 345;
  const before = JSON.stringify(snapshot(sim));
  data.set('quietwood:campaign:v5', before);
  rememberLanguage(storage, 'ru'); assert.equal(getLanguage(), 'ru'); assert.equal(readLanguage(storage), 'ru');
  assert.equal(data.get('quietwood:campaign:v5'), before); assert.equal(JSON.stringify(snapshot(sim)), before);
  assert.deepEqual([...data.keys()], ['quietwood:campaign:v5', LANGUAGE_KEY]);
  data.set(LANGUAGE_KEY, 'unsupported'); assert.equal(readLanguage(storage), 'en');
  assert.equal(readLanguage({ getItem: () => { throw Error('blocked'); } }), 'en');
  rememberLanguage({ setItem: () => { throw Error('blocked'); } }, 'ru'); assert.equal(getLanguage(), 'ru');
  setLanguage('en');
});
