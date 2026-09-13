import './style.css';
import { getLanguage, readLanguage, rememberLanguage, setLanguage, t } from './i18n';
import type { Language } from './i18n';
import { localize } from './i18n/dom';
import { Input } from './game/input';
import { Soundscape } from './game/audio';
import { Renderer } from './game/renderer';
import { CARGO, createCampaign } from './game/campaign';
import type { UpgradeId } from './game/campaign';
import { loadGame, makeExpedition, readSettings, saveGame, storeSettings } from './game/storage';
import { stationMarkup, journalMarkup } from './ui/station';
import type { BaseView } from './ui/station';
import { bindFeatureButtons, escapeText, inventoryMarkup, lastSignalMarkup } from './ui/expedition';
import { execute } from './game/commands';
import type { Command } from './game/commands';
import { cells as shapeCells } from './game/inventory';
import { CoopClient, createRoom, identityFor, invitation, parseInvitation, saveIdentity } from './net/client';
import type { Identity, RoomLink } from './net/client';
import { playtestAccess } from './net/playtest';

try { setLanguage(readLanguage(localStorage)); } catch { setLanguage('en'); }

const $ = <T extends HTMLElement>(selector: string): T => { const el = document.querySelector<T>(selector); if (!el) throw new Error(`Missing ${selector}`); return el; };
const timeString = (seconds: number): string => `${Math.floor(Math.ceil(seconds) / 60).toString().padStart(2, '0')}:${(Math.ceil(seconds) % 60).toString().padStart(2, '0')}`;
$('#app').innerHTML = `
  <canvas id="world" tabindex="0" aria-label="Игровой мир. WASD — движение, Space — газ, E — действие, Q — сканер, B — путь на базу, Esc — пауза."></canvas>
  <audio id="music" hidden preload="none"></audio>
  <div id="aux-controls" hidden><button id="trunk-button" aria-label="Багажник">▦</button><button id="radio-button" aria-label="Радио">◉</button><button id="lights-button" aria-label="Фары" aria-pressed="true">☀</button></div>
  <button id="last-banner" hidden>◉ Последний сигнал</button>
  <div id="hud" hidden>
    <div class="cargo hud-card"><div class="cargo-top"><span>Багажник</span><strong id="cargo-count"></strong></div><span id="cargo-icons"></span><span id="signal-meter"></span><span id="cargo-risk" hidden></span></div>
    <div class="clock-group hud-card"><div><span id="timer"></span><small>до ночи</small></div><span id="hull"></span><div class="hull-bar"><i id="hull-fill"></i></div><span id="boost-meter" aria-label="Ускорение">${'<i></i>'.repeat(8)}</span></div>
    <button id="return-banner" hidden><span>Багажник полон</span><strong>На базу →</strong></button>
    <div id="weather" hidden><span id="weather-label"></span><i id="exposure"></i></div>
    <div class="field-controls"><div class="movement-hint">WASD <span>руль</span> · SPACE <span>газ</span></div><button id="action-button" class="action"><kbd>E</kbd><span id="action-hint">Выйти</span></button><button id="scan-button"><kbd>Q</kbd><span>Сканер</span></button><button id="careful-button" aria-pressed="false"><span>Тихий ход</span></button><button id="home-button"><kbd>B</kbd><span>На базу</span></button><button id="map-button"><kbd>M</kbd><span>Карта</span></button><button id="pause-button" aria-label="Меню"><span>Меню</span></button></div>
    <div class="touch-controls"><div id="joystick" class="stick" aria-label="Джойстик"><i class="stick-knob"></i></div><button id="touch-boost" aria-label="Ускорение"><span>↑↑</span><small id="move-hint">Газ</small></button></div>
  </div>
  <div id="welcome"><div class="welcome-mark">□ · □ · □</div><h1>ГЛУШЬ</h1><p>Найди. Довези. Верни свет.</p><button id="start-button" class="pixel-button">На станцию →</button><label class="language-picker" for="welcome-language"><span translate="no">Language / Язык</span><select id="welcome-language" translate="no"><option value="en">English</option><option value="ru">Русский</option></select></label></div>
  <div id="toast" role="status" aria-live="polite"></div><output id="game-state" aria-hidden="true" class="sr-only"></output>
  <dialog id="panel" aria-labelledby="panel-title"><button id="close-panel" aria-label="Закрыть">×</button><div id="panel-content"></div></dialog>`;

const settings = readSettings();
let sim = loadGame() ?? makeExpedition(createCampaign());
let selectedRegion = sim.world.region, baseView: BaseView = 'dispatch';
const canvas = $<HTMLCanvasElement>('#world'), panel = $<HTMLDialogElement>('#panel');
const renderer = new Renderer(canvas); renderer.zoom = settings.zoom; renderer.reducedMotion = settings.reducedMotion; renderer.resize(); renderer.reset(sim);
const sound = new Soundscape($('#music')); sound.enabled = settings.sound; sound.volume = settings.effects; sound.musicVolume = settings.music;
const input = new Input($('#joystick'), $('#touch-boost'), $('#action-button'), $('#scan-button'));
let playing = false, paused = true, panelType = '', lastTime = performance.now(), accumulator = 0, saveTimer = 0, hudTimer = 0, fpsStart = performance.now(), fpsFrames = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined, saveWarning = false;
let selectedCargo = -1;
let coop: CoopClient | null = null;
const testAccess = playtestAccess(), coopEnabled = !!testAccess;
if (coopEnabled) $('.welcome-mark').textContent = 'GLUSH · PLAYTEST';
let coopServer = testAccess?.server ?? '';
let coopName = '', coopInvite = coopEnabled && location.hash.includes('room=') ? location.href : '', networkTarget: { x: number; y: number } | undefined;
const accessFor = (server: string): string | undefined => server === testAccess?.server ? testAccess.key : undefined;
function download(name: string, value: unknown): void { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function connectCoop(link: RoomLink): void {
  if (!coopEnabled) return;
  link = { ...link, access: accessFor(link.server) ?? link.access };
  persist(); coop?.close(); const identity = identityFor(link.server); identity.name = coopName.trim() || identity.name; coopName = identity.name; saveIdentity(identity);
  coop = new CoopClient(link, identity); coop.onError = message => toast(message, 7000);
  coop.onChange = refresh => {
    if (!coop?.self) return;
    const previous = sim; sim = coop.self; renderer.peers = coop.peers; renderer.pings = coop.pings;
    if (previous !== sim) renderer.reset(sim);
    if (!playing) { playing = true; $('#welcome').hidden = true; document.body.classList.add('playing'); void sound.start(); }
    if (refresh) { if (sim.docked) openPanel(panelType === 'coop' ? 'coop' : 'base'); else if (panelType === 'base' || panelType === 'coop') closePanel(); else if (panel.open) openPanel(panelType); }
    updateHud();
  };
  localStorage.setItem('glush:last-room', JSON.stringify(link)); history.replaceState(null, '', invitation(link)); coop.connect();
}
function run(command: Command): void {
  if (coop) { coop.command(command); return; }
  const previous = sim; sim = execute(sim, command);
  if (sim !== previous) { renderer.reset(sim); closePanel(); }
  persist(); updateHud();
  if (panel.open) openPanel(panelType);
}

function toast(text: string, duration = 3500): void {
  $('#toast').textContent = text; localize($('#toast')); $('#toast').classList.add('visible'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').classList.remove('visible'); $('#toast').textContent = ''; }, duration);
}
function persist(): void { if (coop) return; if (!saveGame(sim) && !saveWarning) { saveWarning = true; toast('Сохранение недоступно'); } }
function start(): void {
  playing = true; $('#welcome').hidden = true; document.body.classList.add('playing'); void sound.start();
  if (sim.docked) openPanel('base'); else closePanel();
}
function closePanel(): void {
  if (sim.docked && playing) { if (panelType !== 'base') openPanel('base'); return; }
  panel.close(); panelType = ''; paused = false; input.clear(); input.enabled = playing; $('#hud').hidden = !playing;
  accumulator = 0; lastTime = performance.now(); sound.setPaused(false); canvas.focus();
}
function depart(): void {
  run({ type: 'depart', region: selectedRegion }); input.careful = false;
  if (sim.campaign.expeditions === 0) toast('Ищи сигнал сканером. Чтобы забрать груз, выйди из машины.', 6000);
}
function cargoMarkup(): string {
  return sim.cargo.length ? `<div class="cargo-list">${sim.cargo.map(item => `<div><span style="color:${CARGO[item.kind].color}">${CARGO[item.kind].name}</span><small>${item.kind === 'volatile' ? `${Math.ceil(item.ttl)} сек` : item.kind === 'fragile' ? `${Math.round(item.condition)}%` : `${CARGO[item.kind].slots} мест`} · ${sim.itemValue(item)} дет.</small></div>`).join('')}</div>` : '<p class="base-note">Багажник пуст. Ищи находки сканером.</p>';
}
function openPanel(type: string): void {
  if (type === 'coop' && !coopEnabled) return;
  if (type === 'inventory' && sim.car.speed > 2) { toast('Останови машину, чтобы открыть багажник'); return; }
  const previousType = panelType, scroll = panel.scrollTop;
  paused = true; input.enabled = false; input.clear(); sound.setPaused(!coop && type !== 'base'); panelType = type; persist();
  $('#hud').hidden = sim.docked; $('#close-panel').hidden = type === 'base';
  panel.classList.toggle('base-panel', type === 'base'); panel.classList.toggle('map-panel', type === 'map');
  const content = $('#panel-content'); content.onkeydown = null;
  if (type === 'base') {
    content.innerHTML = stationMarkup(sim, baseView, selectedRegion, !!coop, coopEnabled);
    $('#base-settings').onclick = () => openPanel('settings');
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => { button.onclick = () => { baseView = button.dataset.view as BaseView; sound.play('ui'); openPanel('base'); panel.scrollTop = 0; document.querySelector<HTMLButtonElement>(`[data-view="${baseView}"]`)?.focus({ preventScroll: true }); }; });
    document.querySelectorAll<HTMLButtonElement>('[data-region]').forEach(button => { button.onclick = () => { selectedRegion = Number(button.dataset.region); sound.play('ui'); openPanel('base'); }; });
    document.querySelectorAll<HTMLButtonElement>('[data-upgrade]').forEach(button => { button.onclick = () => {
      const id = button.dataset.upgrade as UpgradeId;
      run({ type: 'upgrade', id }); sound.play('upgrade');
    }; });
    if (document.querySelector('#depart')) $('#depart').onclick = depart;
    content.querySelector<HTMLButtonElement>('#base-coop')?.addEventListener('click', () => openPanel('coop'));
    if (coop) content.insertAdjacentHTML('afterbegin', `<p id="coop-status">◉ ${coop.state === 'online' ? `На связи ${coop.actors.filter(a => a.online).length}/5` : 'Восстанавливаю связь…'}${coop.actors.some(a => a.ready !== null) ? ' · команда собирается на выезд' : ''}</p>`);
  } else if (type === 'coop') {
    if (coop) {
      content.innerHTML = `<h2 id="panel-title">Общий мир</h2><p id="coop-status">${coop.state === 'online' ? '◉ На связи' : '◌ Восстанавливаю соединение…'}</p><div class="crew-list">${coop.actors.map(a => `<div class="crew-member"><span translate="no">${escapeText(a.name)}</span><span>${a.ready !== null ? 'Готов' : a.online ? a.trip.docked ? 'На станции' : 'На маршруте' : 'Нет связи'}</span></div>`).join('')}</div><button id="copy-invite" class="pixel-button">Скопировать приглашение</button><div class="coop-actions">${['Нужна помощь', 'Нашёл груз', 'Возвращаюсь', 'Сюда', 'Зацепить трос', 'Отцепить трос'].map(label => `<button data-ping="${label}">${label}</button>`).join('')}<button id="export-world">Скачать мир</button><button id="export-key">Скачать личный ключ</button></div><p class="base-note">Ключ нужен для входа с другого устройства. Друзьям отправляй приглашение.</p><button id="leave-coop" class="quiet-button">Вернуться в одиночную игру</button><button id="resume" class="pixel-button">В игру →</button>`;
      $('#copy-invite').onclick = () => { if (coop) void navigator.clipboard.writeText(invitation(coop.link)).then(() => toast('Приглашение скопировано')).catch(() => { toast(invitation(coop!.link), 15000); }); };
      $('#export-key').onclick = () => { if (coop) download('glush-player-key.json', coop.identity); };
      $('#export-world').onclick = () => { if (coop) void coop.exportWorld().then(data => download('glush-world.json', data)).catch(e => toast(String(e))); };
      content.querySelectorAll<HTMLButtonElement>('[data-ping]').forEach(b => b.onclick = () => { coop?.ping(b.dataset.ping as Parameters<CoopClient['ping']>[0]); closePanel(); });
      $('#leave-coop').onclick = () => { coop?.close(); coop = null; renderer.peers = []; renderer.pings = []; sim = loadGame() ?? makeExpedition(createCampaign()); selectedRegion = sim.world.region; renderer.reset(sim); history.replaceState(null, '', location.pathname); openPanel(sim.docked ? 'base' : 'pause'); };
      $('#resume').onclick = closePanel;
    } else {
      content.innerHTML = `<h2 id="panel-title">Вместе в Глушь</h2><p class="story">До пяти водителей. Один сохраняемый мир.</p><div class="coop-form"><label for="coop-name">Позывной</label><input id="coop-name" maxlength="24" value="${escapeText(coopName)}"><button id="create-room" class="pixel-button" ${coopServer ? '' : 'disabled'}>Создать общий мир</button><label for="coop-invite">Приглашение друга</label><input id="coop-invite" value="${escapeText(coopInvite)}" placeholder="Вставь ссылку"><button id="join-room">Присоединиться →</button>${localStorage.getItem('glush:last-room') ? '<button id="last-room">Продолжить общий мир</button>' : ''}<details><summary>Сервер и перенос ключа</summary><label for="coop-server">Адрес сервера</label><input id="coop-server" value="${escapeText(coopServer)}" placeholder="https://glush-worlds.…workers.dev"><p class="base-note">${coopServer ? 'Личный ключ сохраняется в этом браузере.' : 'Сетевой сервер ещё не подключён. Здесь можно указать адрес собственного сервера.'}</p><label for="import-key">Загрузить личный ключ</label><input id="import-key" type="file" accept="application/json,.json"></details><button id="resume" class="quiet-button">Назад</button></div>`;
      $<HTMLInputElement>('#coop-name').oninput = e => { coopName = (e.target as HTMLInputElement).value; };
      $<HTMLInputElement>('#coop-invite').oninput = e => { coopInvite = (e.target as HTMLInputElement).value; };
      $<HTMLInputElement>('#coop-server').oninput = e => { coopServer = (e.target as HTMLInputElement).value; $<HTMLButtonElement>('#create-room').disabled = !coopServer; };
      $('#create-room').onclick = async () => { try { const identity = identityFor(coopServer); identity.name = coopName.trim() || identity.name; saveIdentity(identity); $<HTMLButtonElement>('#create-room').disabled = true; const link = await createRoom(coopServer, identity, accessFor(coopServer)); connectCoop(link); } catch (e) { toast(e instanceof Error ? e.message : 'Не удалось создать мир.'); openPanel('coop'); } };
      $('#join-room').onclick = () => { try { connectCoop(parseInvitation(coopInvite)); } catch (e) { toast(e instanceof Error ? e.message : 'Проверь приглашение.'); } };
      content.querySelector<HTMLButtonElement>('#last-room')?.addEventListener('click', () => { try { connectCoop(JSON.parse(localStorage.getItem('glush:last-room')!)); } catch { toast('Сохранённое приглашение повреждено.'); } });
      $<HTMLInputElement>('#import-key').onchange = async e => { try { const file = (e.target as HTMLInputElement).files?.[0]; if (!file || file.size > 4096) return; const identity = JSON.parse(await file.text()) as Identity; saveIdentity(identity); coopName = identity.name; coopServer = identity.server; openPanel('coop'); toast('Ключ загружен. Открой приглашение своего мира.'); } catch { toast('Не удалось прочитать личный ключ.'); } };
      $('#resume').onclick = closePanel;
    }
  } else if (type === 'inventory') {
    content.innerHTML = inventoryMarkup(sim, selectedCargo);
    const move = (x: number, y: number, rotation?: number): void => { const item = sim.cargo[selectedCargo]; if (item) run({ type: 'move', index: selectedCargo, x, y, rotation: rotation ?? item.placement?.rotation ?? 0 }); };
    let dragStart: { x: number; y: number; cell: string } | undefined; let suppressClick = false;
    content.querySelectorAll<HTMLButtonElement>('[data-cell]').forEach(b => {
      b.onpointerdown = e => { const i = Number(b.dataset.item); if (i >= 0) { selectedCargo = i; dragStart = { x: e.clientX, y: e.clientY, cell: b.dataset.cell! }; b.setPointerCapture(e.pointerId); } };
      b.onpointerup = e => {
        if (!dragStart) return;
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-cell]');
        const moved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 8;
        if (target && moved) { const [x, y] = target.dataset.cell!.split(',').map(Number); suppressClick = true; move(x, y); }
        dragStart = undefined;
      };
      b.onpointercancel = () => { dragStart = undefined; };
      b.onclick = () => { if (suppressClick) { suppressClick = false; return; } const i = Number(b.dataset.item); if (i >= 0) { selectedCargo = i; openPanel('inventory'); } else { const [x, y] = b.dataset.cell!.split(',').map(Number); move(x, y); } };
    });
    const rotate = (): void => { const p = sim.cargo[selectedCargo]?.placement; if (p) move(p.x, p.y, (p.rotation + 1) % 4); };
    content.querySelector<HTMLButtonElement>('#rotate-cargo')?.addEventListener('click', rotate);
    content.querySelector<HTMLButtonElement>('#drop-cargo')?.addEventListener('click', () => { run({ type: 'drop', index: selectedCargo }); selectedCargo = -1; openPanel('inventory'); });
    $('#pack-cargo').onclick = () => run({ type: 'pack' });
    content.querySelector<HTMLButtonElement>('#load-carried')?.addEventListener('click', () => run({ type: 'load' }));
    content.querySelector<HTMLButtonElement>('#drop-carried')?.addEventListener('click', () => run({ type: 'drop', index: -1 }));
    $('#inventory-close').onclick = closePanel;
    content.querySelector<HTMLButtonElement>('#inventory-board')?.addEventListener('click', () => { run({ type: 'board' }); closePanel(); });
    content.querySelector<HTMLButtonElement>('#inventory-home')?.addEventListener('click', () => { if (!sim.returning) run({ type: 'home' }); closePanel(); });
    content.onkeydown = e => {
      const p = sim.cargo[selectedCargo]?.placement; if (!p) return;
      if (e.code === 'KeyR') { e.preventDefault(); rotate(); }
      const direction: Record<string, number[]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const d = direction[e.code]; if (d) { e.preventDefault(); move(p.x + d[0], p.y + d[1]); }
    };
  } else if (type === 'map') {
    content.innerHTML = `<h2 id="panel-title">Полевая карта</h2><canvas id="map" width="384" height="384" aria-label="Исследованный мир. Находки, фонари, машина и база."></canvas><p class="map-key">□ база · ■ находка · 1–3 фонари</p><p class="base-note">Фонарей восстановлено ${sim.checkedLamps.length}/3 · свет сохранится</p><button class="pixel-button" id="resume">Назад →</button>`;
    renderer.drawMap(sim, $('#map')); $('#resume').onclick = closePanel;
  } else if (type === 'journal') {
    content.innerHTML = `<h2 id="panel-title">Радио</h2>${lastSignalMarkup(sim)}${journalMarkup(sim.campaign)}<button id="resume" class="pixel-button">Назад →</button>`; $('#resume').onclick = closePanel;
  } else if (type === 'evacuate') {
    content.innerHTML = '<h2 id="panel-title">Вызвать помощь?</h2><p class="story">Рейс закончится. Груз останется на карте — за ним можно вернуться. Купленные улучшения, открытия и восстановленный свет сохранятся.</p><button id="confirm-evacuate" class="pixel-button">Эвакуироваться</button><button id="resume" class="quiet-button">Остаться</button>';
    $('#confirm-evacuate').onclick = () => { run({ type: 'evacuate' }); baseView = 'dispatch'; if (!coop) { sim.events = []; openPanel('base'); } }; $('#resume').onclick = closePanel;
  } else if (type === 'settings') {
    content.innerHTML = `<h2 id="panel-title">Настройки</h2><label class="language-picker settings-language" for="language-select"><span>Язык</span><select id="language-select" translate="no"><option value="en" ${getLanguage() === 'en' ? 'selected' : ''}>English</option><option value="ru" ${getLanguage() === 'ru' ? 'selected' : ''}>Русский</option></select></label><button id="sound-button" class="setting-toggle" aria-pressed="${settings.sound}">Звук <span>${settings.sound ? 'включён' : 'выключен'}</span></button><div class="settings"><label for="music-volume">Музыка <output id="music-value">${Math.round(settings.music * 100)}%</output></label><input id="music-volume" type="range" min="0" max="100" value="${Math.round(settings.music * 100)}"><label for="effects-volume">Мир и эффекты <output id="effects-value">${Math.round(settings.effects * 100)}%</output></label><input id="effects-volume" type="range" min="0" max="100" value="${Math.round(settings.effects * 100)}"><label for="zoom">Масштаб <select id="zoom">${[2, 3, 4].map(z => `<option value="${z}" ${settings.zoom === z ? 'selected' : ''}>${z}×</option>`).join('')}</select></label><label class="motion-setting"><input type="checkbox" id="motion" ${settings.reducedMotion ? 'checked' : ''}> Меньше движения</label></div><div class="music-credit"><span>Сейчас в эфире</span><a href="https://www.scottbuckley.com.au/library/machina/" target="_blank" rel="noopener">Machina — Scott Buckley ↗</a><small>Адаптировано для игры · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a></small><button id="retry-music">Включить музыку</button></div><div class="creator-credit"><span>Игра Александра Варанцова</span><div><a href="https://varantsov.ru/" target="_blank" rel="me noopener">varantsov.ru ↗</a><a href="https://x.com/a_varantsov" target="_blank" rel="me noopener">X · @a_varantsov ↗</a></div></div><button id="resume" class="pixel-button">Готово →</button>`;
    $('#resume').onclick = closePanel;
    $('#sound-button').onclick = () => { settings.sound = sound.enabled = !sound.enabled; sound.syncVolume(); if (sound.enabled) void sound.start(); storeSettings(settings); $('#sound-button').innerHTML = `Звук <span>${settings.sound ? 'включён' : 'выключен'}</span>`; $('#sound-button').setAttribute('aria-pressed', String(settings.sound)); localize($('#sound-button')); };
    for (const kind of ['music', 'effects'] as const) $<HTMLInputElement>(`#${kind}-volume`).oninput = e => {
      settings[kind] = Number((e.target as HTMLInputElement).value) / 100; sound.musicVolume = settings.music; sound.volume = settings.effects;
      sound.syncVolume(); if (kind === 'music' && settings.sound) void sound.start(); storeSettings(settings); $(`#${kind}-value`).textContent = Math.round(settings[kind] * 100) + '%';
    };
    $('#retry-music').onclick = () => { settings.sound = sound.enabled = true; if (!settings.music) settings.music = sound.musicVolume = .55; storeSettings(settings); void sound.start(); openPanel('settings'); };
    $<HTMLSelectElement>('#language-select').onchange = e => { applyLanguage((e.target as HTMLSelectElement).value as Language); $('#language-select').focus(); };
    $<HTMLSelectElement>('#zoom').onchange = e => { renderer.zoom = settings.zoom = Number((e.target as HTMLSelectElement).value); renderer.resize(); storeSettings(settings); };
    $<HTMLInputElement>('#motion').onchange = e => { renderer.reducedMotion = settings.reducedMotion = (e.target as HTMLInputElement).checked; storeSettings(settings); };
  } else {
    content.innerHTML = `<h2 id="panel-title">Передышка</h2><button id="resume" class="pixel-button">Продолжить →</button>${cargoMarkup()}<div class="pause-grid"><button id="show-map">Карта</button><button id="show-journal">Радио</button><button id="show-settings">Настройки</button><button id="evacuate">Вызвать помощь</button>${coop ? '<button id="show-coop">Команда</button>' : ''}</div><p class="base-note">Восстановлено ${sim.checkedLamps.length}/3 фонарей · свет останется на маршруте</p><details><summary>Как играть</summary><p>Ищи сигнал сканером. Чем чаще он звучит, тем ближе находка. Выйди из машины, подойди и забери груз. Возвращайся с любой добычей.</p><p>«Тихий ход» бережёт оптику. Ячейку вези до разряда. Для спасения подгони машину, выйди и зацепи трос. Сядь и доставь машину на эвакуационный пост ◆. Для передачи груза другу оставь его рядом с машинами.</p><dl><dt>WASD / стрелки</dt><dd>Руль / шаг</dd><dt>Space</dt><dd>Газ / рывок</dd><dt>Shift</dt><dd>Тормоз / занос</dd><dt>E</dt><dd>Действие</dd><dt>Q / B / M</dt><dd>Сканер / база / карта</dd></dl></details>`;
    $('#resume').onclick = closePanel; $('#show-map').onclick = () => openPanel('map'); $('#show-journal').onclick = () => openPanel('journal'); $('#show-settings').onclick = () => openPanel('settings'); $('#evacuate').onclick = () => openPanel('evacuate'); content.querySelector<HTMLButtonElement>('#show-coop')?.addEventListener('click', () => openPanel('coop'));
  }
  if (type !== 'inventory') content.onkeydown = null;
  if (type === 'pause') { content.insertAdjacentHTML('beforeend', `<div class="pause-grid"><button id="pause-trunk">Багажник</button>${coopEnabled ? '<button id="pause-coop">Друзья и радио</button>' : ''}</div>`); $('#pause-trunk').onclick = () => openPanel('inventory'); content.querySelector('#pause-coop')?.addEventListener('click', () => openPanel('coop')); }
  panel.classList.toggle('inventory-panel', type === 'inventory');
  bindFeatureButtons(content, run); localize(panel);
  if (!panel.open) panel.showModal();
  if (type === 'inventory' && selectedCargo >= 0) content.querySelector<HTMLButtonElement>(`[data-item="${selectedCargo}"]`)?.focus({ preventScroll: true });
  panel.scrollTop = previousType === type ? scroll : 0; updateHud();
}
function applyLanguage(value: Language): void {
  try { rememberLanguage(localStorage, value); } catch { setLanguage(value); }
  document.documentElement.lang = value; document.title = t('ГЛУШЬ — верни свет');
  $<HTMLSelectElement>('#welcome-language').value = value;
  localize($('#app'));
  if (panel.open) openPanel(panelType);
  updateHud();
}
function updateHud(): void {
  const slots = sim.cargo.flatMap(item => shapeCells(item.kind).map(() => item));
  $('#cargo-icons').innerHTML = Array.from({ length: sim.capacity }, (_, i) => `<i ${slots[i] ? `class="full" style="background:${CARGO[slots[i].kind].color};border-color:${CARGO[slots[i].kind].color}"` : ''}></i>`).join('');
  $('#cargo-count').textContent = `${sim.usedSlots}/${sim.capacity}`;
  $('#aux-controls').hidden = !playing || sim.docked; $('#last-banner').hidden = !playing || sim.docked || !['offered', 'accepted'].includes(sim.expedition.last.phase);
  $('#lights-button').setAttribute('aria-pressed', String(sim.headlights));
  if (sim.carried) $('#cargo-count').textContent += ' + в руках';
  const payload = [...sim.cargo, ...(sim.carried ? [sim.carried] : [])];
  const cells = payload.filter(item => item.kind === 'volatile'), optics = payload.filter(item => item.kind === 'fragile');
  $('#cargo-risk').hidden = !cells.length && !optics.length;
  $('#cargo-risk').textContent = [cells.length ? `Ячейка ${Math.ceil(Math.min(...cells.map(item => item.ttl)))} с` : '', optics.length ? `Оптика ${Math.round(Math.min(...optics.map(item => item.condition)))}%` : ''].filter(Boolean).join(' · ');
  const signal = sim.signal;
  $('#signal-meter').textContent = sim.returning ? '▸ Курс на базу' : signal ? `${signal.rescue ? 'SOS' : 'Сигнал'} ${'▮'.repeat(Math.max(1, Math.ceil(signal.strength * 5)))}${'·'.repeat(5 - Math.max(1, Math.ceil(signal.strength * 5)))}` : 'Сигнал ·····';
  $('#timer').textContent = sim.night > 0 ? 'Ночь' : timeString(sim.remaining); $('#timer').classList.toggle('urgent', sim.remaining < 30);
  $('.clock-group small').hidden = sim.night > 0;
  const hull = Math.ceil(sim.hull / sim.maxHull * 100);
  $('#hull').textContent = `Кузов ${hull}%`; $('#hull').classList.toggle('urgent', hull < 35); $('#hull-fill').style.width = `${hull}%`;
  document.querySelectorAll('#boost-meter i').forEach((el, i) => el.classList.toggle('empty', i / 8 >= sim.player.energy));
  $('#boost-meter').setAttribute('aria-label', `Ускорение: ${Math.round(sim.player.energy * 100)}%`);
  $('#action-hint').textContent = sim.interaction || 'Действие'; $<HTMLButtonElement>('#action-button').disabled = !sim.interaction;
  $('#action-button').classList.toggle('contextual', Boolean(sim.nearbyCache || sim.nearbyWreck) || sim.nearbyLamp > 0 || sim.atCamp && sim.elapsed > 3 || !sim.driving && sim.nearCar);
  $('#move-hint').textContent = sim.driving ? 'Газ' : 'Рывок'; $('#home-button').classList.toggle('contextual', sim.returning);
  $('#careful-button').setAttribute('aria-pressed', String(input.careful)); $('#return-banner').hidden = !sim.full;
  const threat = ['warning','search','chase'].includes(sim.expedition.hunter.state);
  $('#weather').hidden = sim.storm < .15 && sim.exposure < 10 && sim.night === 0 && !threat;
  $('#weather-label').textContent = threat ? 'Помехи · тише' : sim.sheltered() ? 'Укрытие' : sim.storm > .3 ? 'Буря' : sim.night > 0 ? 'Темнота' : 'Туман'; $('#exposure').style.width = `${Math.max(3, sim.exposure)}%`;
  localize($('#hud'));
  Object.assign($('#game-state').dataset, { seed: sim.world.seed, region: String(sim.world.region), day: String(sim.campaign.day), x: sim.player.x.toFixed(2), y: sim.player.y.toFixed(2),
    driving: String(sim.driving), cargo: String(sim.cargo.length), slots: String(sim.usedSlots), full: String(sim.full), credits: String(sim.campaign.credits), research: String(sim.campaign.research), hull: sim.hull.toFixed(2), exposure: sim.exposure.toFixed(2),
    remaining: sim.remaining.toFixed(2), tracks: String(sim.tracks.length), particles: String(sim.particles.length), paused: String(paused), docked: String(sim.docked), playing: String(playing), rescued: String(sim.rescued), patrol: String(sim.checkedLamps.length), upgrades: JSON.stringify(sim.campaign.upgrades) });
}
$('#welcome-language').onchange = e => applyLanguage((e.target as HTMLSelectElement).value as Language);
$('#start-button').textContent = sim.docked ? 'На станцию →' : 'Продолжить →'; $('#start-button').onclick = start;
$('#pause-button').onclick = () => openPanel('pause'); $('#map-button').onclick = () => openPanel('map'); $('#close-panel').onclick = closePanel;
$('#trunk-button').onclick = () => openPanel('inventory'); $('#radio-button').onclick = () => openPanel('journal'); $('#last-banner').onclick = () => openPanel('journal'); $('#lights-button').onclick = () => run({ type: 'lights' });
$('#action-button').onclick = () => canvas.focus(); $('#scan-button').onclick = () => canvas.focus();
$('#home-button').onclick = () => { run({ type: 'home' }); canvas.focus(); };
$('#return-banner').onclick = () => { if (!sim.returning) run({ type: 'home' }); toast(sim.driving ? 'Следуй за указателем «База»' : 'Вернись к машине, затем на базу'); canvas.focus(); };
$('#careful-button').onclick = () => { input.careful = !input.careful; canvas.focus(); updateHud(); };
panel.addEventListener('cancel', e => { e.preventDefault(); closePanel(); });
input.onPause = () => { if (panel.open) closePanel(); else if (playing) openPanel('pause'); };
input.onMap = () => { if (panelType === 'map') closePanel(); else if (playing && !panel.open) openPanel('map'); };
window.addEventListener('keydown', e => { if (!playing && e.code === 'Enter') { e.preventDefault(); start(); } });
window.addEventListener('keydown', e => { if (!playing || e.repeat || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return; if (e.code === 'KeyI') { e.preventDefault(); if (panelType === 'inventory') closePanel(); else if (!panel.open) openPanel('inventory'); } if (e.code === 'KeyL' && !panel.open) run({ type: 'lights' }); });
canvas.addEventListener('pointerdown', e => { if (!playing || paused || e.button !== 0) return; const p = renderer.screenToWorld(e.clientX, e.clientY); if (sim.driving ? sim.world.drivable(p.x, p.y) : sim.world.walkable(p.x, p.y)) { if (coop) networkTarget = p; else sim.route = [p]; } else toast('Здесь не проехать. Поищи пеший проход.'); canvas.focus(); });
window.addEventListener('resize', () => renderer.resize()); window.addEventListener('pagehide', persist);
window.addEventListener('blur', () => { if (playing && !panel.open) openPanel('pause'); });
document.addEventListener('visibilitychange', () => { sound.setHidden(document.hidden); if (document.hidden && playing && !panel.open) openPanel('pause'); lastTime = performance.now(); accumulator = 0; });
function frame(now: number): void {
  const dt = Math.max(0, Math.min(.1, (now - lastTime) / 1000)); lastTime = now; fpsFrames++;
  if (now - fpsStart > 1000) { $('#game-state').dataset.fps = String(Math.round(fpsFrames * 1000 / (now - fpsStart))); fpsFrames = 0; fpsStart = now; }
  if (playing && coop) {
    const controls = input.read(); if (paused) { controls.x = controls.y = 0; controls.brake = true; networkTarget = undefined; }
    if (controls.x || controls.y) networkTarget = undefined;
    if (networkTarget) { const dx = networkTarget.x - sim.player.x, dy = networkTarget.y - sim.player.y, distance = Math.hypot(dx, dy); if (distance < 12) networkTarget = undefined; else { controls.x = dx / distance; controls.y = dy / distance; } }
    coop.update(dt, controls); renderer.peers = coop.peers; renderer.pings = coop.pings; renderer.carTows = coop.actors.flatMap(a => a.towTarget ? [{ id: a.id, target: a.towTarget }] : []);
    for (const event of [...coop.events, ...sim.events]) { if (event.type === 'signal') sound.signal(event.strength ?? 0,event.pan ?? 0); else sound.play(event.type); if (event.message) toast(event.message); }
    coop.events = []; sim.events = [];
  } else if (playing && !paused) {
    accumulator += dt; while (accumulator >= 1 / 60) { sim.update(1 / 60, input.read()); accumulator -= 1 / 60; }
    let dock = false;
    for (const event of sim.events) { if (event.type === 'signal') sound.signal(event.strength ?? 0, event.pan ?? 0); else sound.play(event.type); if (event.message) toast(event.message); if (event.type === 'dock') dock = true; }
    sim.events = []; if (dock) { baseView = 'dispatch'; openPanel('base'); }
    saveTimer += dt; if (saveTimer > 2) { persist(); saveTimer = 0; }
  } else if (sim.docked || !playing) sim.time += dt;
  sound.updateScene(sim); renderer.render(sim, dt); hudTimer += dt; if (hudTimer > .12) { hudTimer = 0; updateHud(); }
  requestAnimationFrame(frame);
}
applyLanguage(getLanguage()); requestAnimationFrame(frame); void document.fonts.load('12px Tiny5');
if (import.meta.env.DEV) Object.defineProperty(window, '__glush', { value: { get sim() { return sim; }, setSim(value: typeof sim) { sim = value; renderer.reset(sim); updateHud(); }, get coop() { return coop; }, openPanel, run, start } });
if (coopInvite) { playing = true; $('#welcome').hidden = true; openPanel('coop'); }
