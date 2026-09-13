import { getLanguage } from '../i18n';
import { CONTRACTS, MAX_LEVEL, REGIONS, UPGRADES, levelLimit, regionLock, upgradeLock } from '../game/campaign';
import type { Campaign, UpgradeId } from '../game/campaign';
import type { Simulation } from '../game/simulation';
import { escapeText, moduleMarkup, radioMarkup, rulesMarkup } from './expedition';
export type BaseView = 'dispatch' | 'workshop' | 'journal';
export const escape = escapeText;
const money = (n: number): string => n.toLocaleString(getLanguage() === 'ru' ? 'ru-RU' : 'en-US');

export function journalMarkup(c: Campaign): string {
  const completed = c.claimed.filter(Boolean).length;
  return radioMarkup(c) + `<details><summary>Достижения · ${completed}/${CONTRACTS.length}</summary>${CONTRACTS.map((q, i) => {
    if (!c.claimed[i] && !q.available(c)) return '';
    return `<article class="contract ${c.claimed[i] ? 'done' : ''}"><div><span>${c.claimed[i] ? '✓ ' : ''}${q.name}</span><span>${q.progress(c)}/${q.total}</span></div><p>${q.description}</p><small>+${money(q.credits)} деталей · +${q.research} схем</small></article>`;
  }).join('')}</details>`;
}
export function stationMarkup(sim: Simulation, view: BaseView, selected: number, shared = false, coopEnabled = false): string {
  const c = sim.campaign, relays = c.relics.filter(Boolean).length;
  const header = `<header class="station-header"><div class="base-eyebrow"><span>День ${c.day} · Станция «Глушь»</span><button id="base-settings" aria-label="Настройки">☷</button></div><div class="station-title"><h2 id="panel-title">ГЛУШЬ</h2><div class="bank"><span>${money(c.credits)} <small>деталей</small></span><span>${c.research} <small>схем</small></span></div></div><div class="relay-progress" aria-label="Восстановлено ${relays} из 7 ретрансляторов"><span>${REGIONS.map((r, i) => `<i title="${r.name}" class="${c.relics[i] ? 'online' : ''}" style="--region:${r.color}"></i>`).join('')}</span><small>Связь ${relays}/7</small></div><nav class="base-tabs" aria-label="Станция">${(['dispatch', 'workshop', 'journal'] as const).map((v, i) => `<button data-view="${v}" aria-pressed="${view === v}">${['Выезд', 'Машина', 'Радио'][i]}</button>`).join('')}</nav></header>`;
  if (view === 'journal') return header + journalMarkup(c);
  if (view === 'workshop') return header + moduleMarkup(c) + `<div class="section-heading"><span>Улучшения</span><small>Технологии ${levelLimit(c)}/5</small></div><div class="upgrade-grid">${(Object.keys(UPGRADES) as UpgradeId[]).map(id => {
    const def = UPGRADES[id], level = c.upgrades[id], max = level >= MAX_LEVEL, lock = upgradeLock(c, id);
    const affordable = !lock && c.credits >= def.prices[level] && c.research >= def.research[level];
    return `<article class="upgrade"><div class="upgrade-name"><span class="upgrade-icon">${def.icon}</span><h3>${def.name}</h3><small>${level}/5</small></div><div class="upgrade-levels">${Array.from({ length: MAX_LEVEL }, (_, i) => `<i class="${i < level ? 'filled' : i >= levelLimit(c) ? 'locked' : ''}"></i>`).join('')}</div><p>${def.effects[Math.min(level, MAX_LEVEL - 1)]}</p><button class="purchase" data-upgrade="${id}" ${!affordable ? 'disabled' : ''}><span>${max ? 'Максимальный уровень' : `${money(def.prices[level])} дет. · ${def.research[level]} сх.`}</span><small>${lock || (affordable ? 'Установить →' : c.credits < def.prices[level] ? `Нужно ещё ${money(def.prices[level] - c.credits)} деталей` : 'Нужны схемы')}</small></button></article>`;
  }).join('')}</div><p class="base-note">Новые технологии открываются с восстановлением связи. Ремонт и зарядка на станции бесплатны.</p>`;
  const receipt = sim.receipt, r = REGIONS[selected], memory = c.regions[selected];
  const remaining = Math.max(0, 8 - memory.taken.length);
  return header + (receipt ? `<div class="receipt ${receipt.lost ? 'loss' : ''}"><strong>${receipt.lost ? 'Ты снова на станции' : `+${money(receipt.credits)} деталей · +${receipt.research} схем`}</strong><p>${receipt.lost ? 'Груз отмечен на карте. За ним можно вернуться.' : `Доставлено ${receipt.delivered} · спасено ${receipt.rescued}`}</p>${receipt.messages.map(m => `<small>${escape(m)}</small>`).join('')}</div>` : '') +
    `<div class="section-heading"><span>Продолжить путь</span><small>Районы ${REGIONS.filter((_, i) => !regionLock(c, i, shared)).length}/7</small></div><div class="region-list">${REGIONS.map((region, i) => {
      const lock = regionLock(c, i, shared), m = c.regions[i];
      return `<button data-region="${i}" class="region ${selected === i ? 'selected' : ''} ${lock ? 'locked' : ''}" aria-pressed="${selected === i}" style="--region:${region.color}"><span class="region-number">${c.relics[i] ? '✓' : String(i + 1).padStart(2, '0')}</span><span>${region.name}</span><small>${lock ? 'Закрыт' : `Свет ${m.lamps.length}/3 · ${Math.round(c.scouted[i] / (192 * 192) * 100)}% карты`}</small></button>`;
    }).join('')}</div><div class="region-detail"><span style="color:${r.color}">${r.name}</span><p>${r.subtitle}</p><small>${regionLock(c, selected, shared) ? `Для открытия: ${regionLock(c, selected, shared)}` : `Находок ${remaining} · спасений ${memory.rescued.length}/2 · свет ${memory.lamps.length}/3${memory.rare ? ' · редкое место найдено' : ''}`}</small></div>${rulesMarkup(c)}<p class="base-note">Мир остаётся прежним. Восстановленный свет и найденные места сохраняются между выездами.</p><footer class="depart-footer"><button id="depart" class="pixel-button" ${regionLock(c, selected, shared) ? 'disabled' : ''}>${regionLock(c, selected, shared) ? 'Район пока закрыт' : 'Выехать →'}</button>${coopEnabled ? '<button id="base-coop" class="quiet-button">◉ Играть с друзьями</button>' : ''}</footer>`;
}
