import { CARGO } from '../game/campaign';
import type { Campaign } from '../game/campaign';
import type { Simulation } from '../game/simulation';
import { cells, findPlacement } from '../game/inventory';
import { MODULES, RULES, STORIES } from '../game/features';
import type { ModuleId, RuleId } from '../game/features';
import type { Command } from '../game/commands';
export const escapeText = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function radioMarkup(c: Campaign): string {
  const r = c.progression.radio;
  return `<div class="radio-stories">${STORIES.map((story, i) => {
    const chapter = story.chapters[r.chapters[i]];
    if (!chapter) return `<article class="radio-card done"><small>${story.frequency} FM · ${story.voice}</small><h3>На связи</h3><p>История записана в архив.</p></article>`;
    const progress = Math.min(chapter.total, chapter.progress(c));
    return `<article class="radio-card"><div class="radio-frequency"><span>◉ ${story.frequency} FM</span><small>${r.chapters[i] + 1}/4</small></div><small>${story.voice}</small><h3>${chapter.title}</h3><p>«${chapter.text}»</p><div class="radio-objective">${chapter.objective} <strong>${progress}/${chapter.total}</strong></div><button data-radio="${i}" ${r.accepted[i] && progress < chapter.total ? 'disabled' : ''}>${r.accepted[i] ? progress >= chapter.total ? 'Доложить на станции' : 'На маршруте' : 'Принимаю. Я займусь этим →'}</button></article>`;
  }).join('')}</div>${r.archive.length ? `<details><summary>Архив передач · ${r.archive.length}</summary>${r.archive.map(line => `<p>${escapeText(line)}</p>`).join('')}</details>` : ''}`;
}
export function moduleMarkup(c: Campaign): string {
  const slots = { front: 'Спереди', roof: 'На крыше', cargo: 'В багажнике', rear: 'Сзади' };
  return `<details class="module-section" open><summary>Сборка машины · 4 крепления</summary><div class="module-grid">${Object.entries(slots).map(([slot, label]) => `<section><h3>${label}</h3>${(Object.keys(MODULES) as ModuleId[]).filter(id => MODULES[id].slot === slot).map(id => {
    const m = MODULES[id], installed = c.progression.modules[m.slot] === id, owned = c.progression.owned.includes(id), locked = c.relics.filter(Boolean).length < m.tier;
    return `<button data-module="${id}" class="module ${installed ? 'installed' : ''}" ${locked || !owned && c.credits < m.price ? 'disabled' : ''}><strong>${installed ? '◆ ' : '◇ '}${m.name}</strong><span>${m.hint}</span><small>${installed ? 'Установлен · снять' : locked ? `Связь в ${m.tier} районах` : owned ? 'Установить' : `${m.price} деталей`}</small></button>`;
  }).join('')}</section>`).join('')}</div></details>`;
}
export function rulesMarkup(c: Campaign): string {
  const rule = c.progression.rule;
  return `<div class="rule-picker"><label for="expedition-rule">Условия выезда</label><select id="expedition-rule">${(Object.keys(RULES) as RuleId[]).map(id => `<option value="${id}" ${rule === id ? 'selected' : ''} ${c.relics.filter(Boolean).length < RULES[id].tier ? 'disabled' : ''}>${RULES[id].name}${RULES[id].bonus ? ` · +${Math.round(RULES[id].bonus * 100)}%` : ''}</option>`).join('')}</select><p>${RULES[rule].hint}</p></div>`;
}
export function lastSignalMarkup(sim: Simulation): string {
  const last = sim.expedition.last;
  if (!['offered', 'accepted'].includes(last.phase)) return '';
  const distance = Math.round(Math.hypot(last.x - sim.player.x, last.y - sim.player.y));
  const detour = Math.max(0, distance + Math.hypot(last.x - sim.world.camp.x, last.y - sim.world.camp.y) - Math.hypot(sim.player.x - sim.world.camp.x, sim.player.y - sim.world.camp.y));
  return `<article class="radio-card last-signal"><small>◉ Частота не определена · ${Math.ceil(last.ttl)} с</small><h3>Последний сигнал</h3><p>«Ячейка ещё держит заряд. Оставляю её у дороги. Дальше еду без света».</p><p>${distance} м до сигнала · крюк ≈${Math.max(1, Math.ceil((detour / (sim.towing ? sim.towSpeed : 60) + 20) / 60))} мин · нестабильный груз${sim.full ? ' · багажник полон' : ''}</p>${last.phase === 'offered' ? '<div class="button-row"><button data-last="yes">Еду за ней</button><button data-last="no">Вернуться домой</button></div>' : '<p>Координаты приняты. Указатель включён.</p>'}</article>`;
}
export function inventoryMarkup(sim: Simulation, selected = -1): string {
  const occupied = new Map<string, number>();
  sim.cargo.forEach((item, i) => { if (item.placement) for (const [x, y] of cells(item.kind, item.placement.rotation)) occupied.set(`${x + item.placement.x}:${y + item.placement.y}`, i); });
  const chosen = sim.cargo[selected], blocked = sim.carried && !findPlacement(sim.cargo, sim.carried, sim.rows);
  return `<div class="inventory-heading"><h2 id="panel-title">Багажник</h2><span>${sim.usedSlots}/${sim.capacity}</span></div><p class="base-note">Выбери груз и свободную клетку. Перетаскивай или используй стрелки и R.</p><div class="inventory-layout"><div class="trunk-grid" style="--rows:${sim.rows}" aria-label="Багажник 4 на ${sim.rows}">${Array.from({ length: sim.rows * 4 }, (_, n) => {
    const x = n % 4, y = Math.floor(n / 4), i = occupied.get(`${x}:${y}`), item = i === undefined ? undefined : sim.cargo[i];
    return `<button class="trunk-cell ${item ? 'occupied' : ''} ${i === selected ? 'selected' : ''}" data-cell="${x},${y}" data-item="${i ?? -1}" style="--cargo:${item ? CARGO[item.kind].color : 'transparent'}" aria-label="${item ? CARGO[item.kind].name : 'Пусто'}, ${x + 1}:${y + 1}">${item ? CARGO[item.kind].short : '·'}</button>`;
  }).join('')}</div><div class="inventory-info">${chosen ? `<h3 style="color:${CARGO[chosen.kind].color}">${CARGO[chosen.kind].name}</h3><p>${Math.round(chosen.condition)}% · ${sim.itemValue(chosen)} деталей${chosen.kind === 'volatile' ? ` · ${Math.ceil(chosen.ttl)} с` : ''}</p><button id="rotate-cargo">↻ Повернуть · R</button><button id="drop-cargo">Выложить у машины</button>` : '<h3>Каждая вещь на своём месте</h3><p>Тяжёлое ближе к центру. Оптику вези аккуратно.</p>'}<button id="pack-cargo">Переложить автоматически</button></div></div>${sim.carried ? `<div class="carried-card"><span>В руках: ${CARGO[sim.carried.kind].name}</span>${blocked ? '<p>Форма груза не помещается. Переложи вещи, освободи место или вернись с тем, что уже взял.</p><button id="inventory-home">На базу →</button>' : ''}<div class="button-row"><button id="load-carried" ${!sim.nearCar ? 'disabled' : ''}>Погрузить</button><button id="drop-carried">Положить рядом</button></div></div>` : ''}${!sim.driving && !sim.carried && sim.nearCar ? '<button id="inventory-board">Сесть в машину</button>' : ''}<button id="inventory-close" class="pixel-button">Закрыть →</button>`;
}
export function bindFeatureButtons(root: HTMLElement, run: (command: Command) => void): void {
  root.querySelectorAll<HTMLButtonElement>('[data-radio]').forEach(b => b.onclick = () => run({ type: 'radio', index: Number(b.dataset.radio) }));
  root.querySelectorAll<HTMLButtonElement>('[data-module]').forEach(b => b.onclick = () => run({ type: 'module', id: b.dataset.module as ModuleId }));
  root.querySelectorAll<HTMLButtonElement>('[data-last]').forEach(b => b.onclick = () => run({ type: 'last', accept: b.dataset.last === 'yes' }));
  const rule = root.querySelector<HTMLSelectElement>('#expedition-rule'); if (rule) rule.onchange = () => run({ type: 'rule', id: rule.value as RuleId });
}
