import './style.css';
import { Input } from './game/input';
import { Soundscape } from './game/audio';
import { Renderer } from './game/renderer';
import { CARGO, UPGRADES, buyUpgrade, createCampaign, regionLock, settleContracts } from './game/campaign';
import type { UpgradeId } from './game/campaign';
import { loadGame, makeExpedition, readSettings, saveGame, storeSettings } from './game/storage';
import { stationMarkup, journalMarkup } from './ui/station';
import type { BaseView } from './ui/station';

const $ = <T extends HTMLElement>(selector: string): T => { const el = document.querySelector<T>(selector); if (!el) throw new Error(`Missing ${selector}`); return el; };
const timeString = (seconds: number): string => `${Math.floor(Math.ceil(seconds) / 60).toString().padStart(2, '0')}:${(Math.ceil(seconds) % 60).toString().padStart(2, '0')}`;
$('#app').innerHTML = `
  <canvas id="world" tabindex="0" aria-label="Игровой мир. WASD — движение, Space — газ, E — действие, Q — сканер, B — путь на базу, Esc — пауза."></canvas>
  <audio id="music" hidden preload="none"></audio>
  <div id="hud" hidden>
    <div class="cargo hud-card"><div class="cargo-top"><span>Багажник</span><strong id="cargo-count"></strong></div><span id="cargo-icons"></span><span id="signal-meter"></span><span id="cargo-risk" hidden></span></div>
    <div class="clock-group hud-card"><div><span id="timer"></span><small>до ночи</small></div><span id="hull"></span><div class="hull-bar"><i id="hull-fill"></i></div><span id="boost-meter" aria-label="Ускорение">${'<i></i>'.repeat(8)}</span></div>
    <button id="return-banner" hidden><span>Багажник полон</span><strong>На базу →</strong></button>
    <div id="weather" hidden><span id="weather-label"></span><i id="exposure"></i></div>
    <div class="field-controls"><div class="movement-hint">WASD <span>руль</span> · SPACE <span>газ</span></div><button id="action-button" class="action"><kbd>E</kbd><span id="action-hint">Выйти</span></button><button id="scan-button"><kbd>Q</kbd><span>Сканер</span></button><button id="careful-button" aria-pressed="false"><span>Тихий ход</span></button><button id="home-button"><kbd>B</kbd><span>На базу</span></button><button id="map-button"><kbd>M</kbd><span>Карта</span></button><button id="pause-button" aria-label="Меню"><span>Меню</span></button></div>
    <div class="touch-controls"><div id="joystick" class="stick" aria-label="Джойстик"><i class="stick-knob"></i></div><button id="touch-boost" aria-label="Ускорение"><span>↑↑</span><small id="move-hint">Газ</small></button></div>
  </div>
  <div id="welcome"><div class="welcome-mark">□ · □ · □</div><h1>ГЛУШЬ</h1><p>Найди. Довези. Верни свет.</p><button id="start-button" class="pixel-button">На станцию →</button></div>
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

function toast(text: string, duration = 3500): void {
  $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').classList.remove('visible'); $('#toast').textContent = ''; }, duration);
}
function persist(): void { if (!saveGame(sim) && !saveWarning) { saveWarning = true; toast('Сохранение недоступно'); } }
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
  if (regionLock(sim.campaign, selectedRegion)) return;
  persist(); sim = makeExpedition(sim.campaign, selectedRegion); sim.launch(); input.careful = false;
  renderer.reset(sim); clearTimeout(toastTimer); $('#toast').classList.remove('visible'); $('#toast').textContent = ''; closePanel(); persist(); updateHud();
  if (sim.campaign.expeditions === 0) toast('Ищи сигнал сканером. Чтобы забрать груз, выйди из машины.', 6000);
}
function cargoMarkup(): string {
  return sim.cargo.length ? `<div class="cargo-list">${sim.cargo.map(item => `<div><span style="color:${CARGO[item.kind].color}">${CARGO[item.kind].name}</span><small>${item.kind === 'volatile' ? `${Math.ceil(item.ttl)} сек` : item.kind === 'fragile' ? `${Math.round(item.condition)}%` : `${CARGO[item.kind].slots} мест`} · ${sim.itemValue(item)} дет.</small></div>`).join('')}</div>` : '<p class="base-note">Багажник пуст. Ищи находки сканером.</p>';
}
function openPanel(type: string): void {
  const previousType = panelType, scroll = panel.scrollTop;
  paused = true; input.enabled = false; input.clear(); sound.setPaused(type !== 'base'); panelType = type; persist();
  $('#hud').hidden = sim.docked; $('#close-panel').hidden = type === 'base';
  panel.classList.toggle('base-panel', type === 'base'); panel.classList.toggle('map-panel', type === 'map');
  const content = $('#panel-content');
  if (type === 'base') {
    content.innerHTML = stationMarkup(sim, baseView, selectedRegion);
    $('#base-settings').onclick = () => openPanel('settings');
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => { button.onclick = () => { baseView = button.dataset.view as BaseView; sound.play('ui'); openPanel('base'); panel.scrollTop = 0; document.querySelector<HTMLButtonElement>(`[data-view="${baseView}"]`)?.focus({ preventScroll: true }); }; });
    document.querySelectorAll<HTMLButtonElement>('[data-region]').forEach(button => { button.onclick = () => { selectedRegion = Number(button.dataset.region); sound.play('ui'); openPanel('base'); }; });
    document.querySelectorAll<HTMLButtonElement>('[data-upgrade]').forEach(button => { button.onclick = () => {
      const id = button.dataset.upgrade as UpgradeId;
      if (buyUpgrade(sim.campaign, id)) {
        const receipt = sim.receipt ?? { credits: 0, research: 0, delivered: 0, rescued: 0, lost: false, messages: [] };
        settleContracts(sim.campaign, receipt); if (receipt.messages.length) sim.receipt = receipt;
        persist(); sound.play('upgrade'); openPanel('base'); toast(`${UPGRADES[id].name} · уровень ${sim.campaign.upgrades[id]}`);
      }
    }; });
    if (document.querySelector('#depart')) $('#depart').onclick = depart;
  } else if (type === 'map') {
    content.innerHTML = `<h2 id="panel-title">Полевая карта</h2><canvas id="map" width="384" height="384" aria-label="Исследованный мир. Находки, фонари, машина и база."></canvas><p class="map-key">□ база · ■ находка · 1–3 фонари</p><p class="base-note">Фонарей проверено ${sim.checkedLamps.length}/3${sim.patrolComplete ? ' · награда на базе' : ' · подойди пешком'}</p><button class="pixel-button" id="resume">Назад →</button>`;
    renderer.drawMap(sim, $('#map')); $('#resume').onclick = closePanel;
  } else if (type === 'journal') {
    content.innerHTML = `<h2 id="panel-title">Полевой журнал</h2>${journalMarkup(sim.campaign)}<button id="resume" class="pixel-button">Назад →</button>`; $('#resume').onclick = closePanel;
  } else if (type === 'evacuate') {
    content.innerHTML = '<h2 id="panel-title">Вызвать помощь?</h2><p class="story">Рейс закончится. Груз и награды этого выезда будут потеряны. Накопленные детали и улучшения останутся.</p><button id="confirm-evacuate" class="pixel-button">Эвакуироваться</button><button id="resume" class="quiet-button">Остаться</button>';
    $('#confirm-evacuate').onclick = () => { sim.finish(true); sim.events = []; baseView = 'dispatch'; openPanel('base'); }; $('#resume').onclick = closePanel;
  } else if (type === 'settings') {
    content.innerHTML = `<h2 id="panel-title">Настройки</h2><button id="sound-button" class="setting-toggle" aria-pressed="${settings.sound}">Звук <span>${settings.sound ? 'включён' : 'выключен'}</span></button><div class="settings"><label for="music-volume">Музыка <output id="music-value">${Math.round(settings.music * 100)}%</output></label><input id="music-volume" type="range" min="0" max="100" value="${Math.round(settings.music * 100)}"><label for="effects-volume">Мир и эффекты <output id="effects-value">${Math.round(settings.effects * 100)}%</output></label><input id="effects-volume" type="range" min="0" max="100" value="${Math.round(settings.effects * 100)}"><label for="zoom">Масштаб <select id="zoom">${[2, 3, 4].map(z => `<option value="${z}" ${settings.zoom === z ? 'selected' : ''}>${z}×</option>`).join('')}</select></label><label class="motion-setting"><input type="checkbox" id="motion" ${settings.reducedMotion ? 'checked' : ''}> Меньше движения</label></div><div class="music-credit"><span>Сейчас в эфире</span><a href="https://www.scottbuckley.com.au/library/machina/" target="_blank" rel="noopener">Machina — Scott Buckley ↗</a><small>Адаптировано для игры · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a></small><button id="retry-music">Включить музыку</button></div><button id="resume" class="pixel-button">Готово →</button>`;
    $('#resume').onclick = closePanel;
    $('#sound-button').onclick = () => { settings.sound = sound.enabled = !sound.enabled; sound.syncVolume(); if (sound.enabled) void sound.start(); storeSettings(settings); $('#sound-button').innerHTML = `Звук <span>${settings.sound ? 'включён' : 'выключен'}</span>`; $('#sound-button').setAttribute('aria-pressed', String(settings.sound)); };
    for (const kind of ['music', 'effects'] as const) $<HTMLInputElement>(`#${kind}-volume`).oninput = e => {
      settings[kind] = Number((e.target as HTMLInputElement).value) / 100; sound.musicVolume = settings.music; sound.volume = settings.effects;
      sound.syncVolume(); if (kind === 'music' && settings.sound) void sound.start(); storeSettings(settings); $(`#${kind}-value`).textContent = Math.round(settings[kind] * 100) + '%';
    };
    $('#retry-music').onclick = () => { settings.sound = sound.enabled = true; if (!settings.music) settings.music = sound.musicVolume = .55; storeSettings(settings); void sound.start(); openPanel('settings'); };
    $<HTMLSelectElement>('#zoom').onchange = e => { renderer.zoom = settings.zoom = Number((e.target as HTMLSelectElement).value); renderer.resize(); storeSettings(settings); };
    $<HTMLInputElement>('#motion').onchange = e => { renderer.reducedMotion = settings.reducedMotion = (e.target as HTMLInputElement).checked; storeSettings(settings); };
  } else {
    content.innerHTML = `<h2 id="panel-title">Передышка</h2><button id="resume" class="pixel-button">Продолжить →</button>${cargoMarkup()}<div class="pause-grid"><button id="show-map">Карта</button><button id="show-journal">Задания</button><button id="show-settings">Настройки</button><button id="evacuate">Вызвать помощь</button></div><p class="base-note">Патруль ${sim.checkedLamps.length}/3 · проверяй фонари пешком</p><details><summary>Как играть</summary><p>Ищи сигнал сканером. Чем чаще он звучит, тем ближе находка. Выйди из машины, подойди и забери груз. Возвращайся с любой добычей.</p><p>«Тихий ход» бережёт оптику. Ячейку вези до разряда. Для спасения подгони машину, выйди и зацепи трос. Сядь и тяни.</p><dl><dt>WASD / стрелки</dt><dd>Руль / шаг</dd><dt>Space</dt><dd>Газ / рывок</dd><dt>Shift</dt><dd>Тормоз / занос</dd><dt>E</dt><dd>Действие</dd><dt>Q / B / M</dt><dd>Сканер / база / карта</dd></dl></details>`;
    $('#resume').onclick = closePanel; $('#show-map').onclick = () => openPanel('map'); $('#show-journal').onclick = () => openPanel('journal'); $('#show-settings').onclick = () => openPanel('settings'); $('#evacuate').onclick = () => openPanel('evacuate');
  }
  if (!panel.open) panel.showModal();
  panel.scrollTop = previousType === type ? scroll : 0; updateHud();
}
function updateHud(): void {
  const slots = sim.cargo.flatMap(item => Array.from({ length: CARGO[item.kind].slots }, () => item));
  $('#cargo-icons').innerHTML = Array.from({ length: sim.capacity }, (_, i) => `<i ${slots[i] ? `class="full" style="background:${CARGO[slots[i].kind].color};border-color:${CARGO[slots[i].kind].color}"` : ''}></i>`).join('');
  $('#cargo-count').textContent = `${sim.usedSlots}/${sim.capacity}`;
  const cells = sim.cargo.filter(item => item.kind === 'volatile'), optics = sim.cargo.filter(item => item.kind === 'fragile');
  $('#cargo-risk').hidden = !cells.length && !optics.length;
  $('#cargo-risk').textContent = [cells.length ? `Ячейка ${Math.ceil(Math.min(...cells.map(item => item.ttl)))} с` : '', optics.length ? `Оптика ${Math.round(Math.min(...optics.map(item => item.condition)))}%` : ''].filter(Boolean).join(' · ');
  const signal = sim.signal;
  $('#signal-meter').textContent = sim.returning ? '▸ Курс на базу' : signal ? `${signal.rescue ? 'SOS' : 'Сигнал'} ${'▮'.repeat(Math.max(1, Math.ceil(signal.strength * 5)))}${'·'.repeat(5 - Math.max(1, Math.ceil(signal.strength * 5)))}` : 'Сигнал ·····';
  $('#timer').textContent = sim.remaining > 0 ? timeString(sim.remaining) : 'Ночь'; $('#timer').classList.toggle('urgent', sim.remaining < 30);
  $('.clock-group small').hidden = sim.remaining <= 0;
  const hull = Math.ceil(sim.hull / sim.maxHull * 100);
  $('#hull').textContent = `Кузов ${hull}%`; $('#hull').classList.toggle('urgent', hull < 35); $('#hull-fill').style.width = `${hull}%`;
  document.querySelectorAll('#boost-meter i').forEach((el, i) => el.classList.toggle('empty', i / 8 >= sim.player.energy));
  $('#boost-meter').setAttribute('aria-label', `Ускорение: ${Math.round(sim.player.energy * 100)}%`);
  $('#action-hint').textContent = sim.interaction || 'Действие'; $<HTMLButtonElement>('#action-button').disabled = !sim.interaction;
  $('#action-button').classList.toggle('contextual', Boolean(sim.nearbyCache || sim.nearbyWreck) || sim.nearbyLamp > 0 || sim.atCamp && sim.elapsed > 3 || !sim.driving && sim.nearCar);
  $('#move-hint').textContent = sim.driving ? 'Газ' : 'Рывок'; $('#home-button').classList.toggle('contextual', sim.returning);
  $('#careful-button').setAttribute('aria-pressed', String(input.careful)); $('#return-banner').hidden = !sim.full;
  $('#weather').hidden = sim.storm < .15 && sim.exposure < 10 && sim.night === 0;
  $('#weather-label').textContent = sim.sheltered() ? 'Укрытие' : sim.storm > .3 ? 'Буря' : sim.night > 0 ? 'Темнота' : 'Туман'; $('#exposure').style.width = `${Math.max(3, sim.exposure)}%`;
  Object.assign($('#game-state').dataset, { seed: sim.world.seed, region: String(sim.world.region), day: String(sim.campaign.day), x: sim.player.x.toFixed(2), y: sim.player.y.toFixed(2),
    driving: String(sim.driving), cargo: String(sim.cargo.length), slots: String(sim.usedSlots), full: String(sim.full), credits: String(sim.campaign.credits), research: String(sim.campaign.research), hull: sim.hull.toFixed(2), exposure: sim.exposure.toFixed(2),
    remaining: sim.remaining.toFixed(2), tracks: String(sim.tracks.length), particles: String(sim.particles.length), paused: String(paused), docked: String(sim.docked), playing: String(playing), rescued: String(sim.rescued), patrol: String(sim.checkedLamps.length), upgrades: JSON.stringify(sim.campaign.upgrades) });
}
$('#start-button').textContent = sim.docked ? 'На станцию →' : 'Продолжить →'; $('#start-button').onclick = start;
$('#pause-button').onclick = () => openPanel('pause'); $('#map-button').onclick = () => openPanel('map'); $('#close-panel').onclick = closePanel;
$('#action-button').onclick = () => canvas.focus(); $('#scan-button').onclick = () => canvas.focus();
$('#home-button').onclick = () => { sim.returning = !sim.returning; canvas.focus(); updateHud(); };
$('#return-banner').onclick = () => { sim.returning = true; toast(sim.driving ? 'Следуй за указателем «База»' : 'Вернись к машине, затем на базу'); canvas.focus(); };
$('#careful-button').onclick = () => { input.careful = !input.careful; canvas.focus(); updateHud(); };
panel.addEventListener('cancel', e => { e.preventDefault(); closePanel(); });
input.onPause = () => { if (panel.open) closePanel(); else if (playing) openPanel('pause'); };
input.onMap = () => { if (panelType === 'map') closePanel(); else if (playing && !panel.open) openPanel('map'); };
window.addEventListener('keydown', e => { if (!playing && e.code === 'Enter') { e.preventDefault(); start(); } });
canvas.addEventListener('pointerdown', e => { if (!playing || paused || e.button !== 0) return; const p = renderer.screenToWorld(e.clientX, e.clientY); if (sim.driving ? sim.world.drivable(p.x, p.y) : sim.world.walkable(p.x, p.y)) sim.route = [p]; else toast('Здесь не проехать. Поищи пеший проход.'); canvas.focus(); });
window.addEventListener('resize', () => renderer.resize()); window.addEventListener('pagehide', persist);
window.addEventListener('blur', () => { if (playing && !panel.open) openPanel('pause'); });
document.addEventListener('visibilitychange', () => { sound.setHidden(document.hidden); if (document.hidden && playing && !panel.open) openPanel('pause'); lastTime = performance.now(); accumulator = 0; });
function frame(now: number): void {
  const dt = Math.max(0, Math.min(.1, (now - lastTime) / 1000)); lastTime = now; fpsFrames++;
  if (now - fpsStart > 1000) { $('#game-state').dataset.fps = String(Math.round(fpsFrames * 1000 / (now - fpsStart))); fpsFrames = 0; fpsStart = now; }
  if (playing && !paused) {
    accumulator += dt; while (accumulator >= 1 / 60) { sim.update(1 / 60, input.read()); accumulator -= 1 / 60; }
    let dock = false;
    for (const event of sim.events) { if (event.type === 'signal') sound.signal(event.strength ?? 0, event.pan ?? 0); else sound.play(event.type); if (event.message) toast(event.message); if (event.type === 'dock') dock = true; }
    sim.events = []; if (dock) { baseView = 'dispatch'; openPanel('base'); }
    saveTimer += dt; if (saveTimer > 2) { persist(); saveTimer = 0; }
  } else if (sim.docked || !playing) sim.time += dt;
  sound.updateScene(sim); renderer.render(sim, dt); hudTimer += dt; if (hudTimer > .12) { hudTimer = 0; updateHud(); }
  requestAnimationFrame(frame);
}
updateHud(); requestAnimationFrame(frame); void document.fonts.load('12px Tiny5');
