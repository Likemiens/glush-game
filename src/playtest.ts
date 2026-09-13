import './style.css';
import { getLanguage, readLanguage, setLanguage, t } from './i18n';
import { enablePlaytest } from './net/playtest';
import { checkAccess, serverAddress } from './net/client';

try { setLanguage(readLanguage(localStorage)); } catch { setLanguage('en'); }
const root = document.querySelector<HTMLElement>('#app')!;
document.documentElement.lang = getLanguage();
root.innerHTML = `<div class="playtest-gate"><div class="welcome-mark">GLUSH · PLAYTEST</div><h1>${t('Закрытый тест')}</h1><p>${t('Кооператив для приглашённых друзей. Открой личную ссылку или вставь её ниже.')}</p><form><label for="test-invite">${t('Приглашение на тест')}</label><input id="test-invite" type="password" autocomplete="off" spellcheck="false" required><button class="pixel-button" type="submit">${t('Открыть тест →')}</button></form><p id="test-status" role="status" aria-live="polite"></p><a href="/">${t('Одиночная игра →')}</a></div>`;
const field = root.querySelector<HTMLInputElement>('input')!, button = root.querySelector<HTMLButtonElement>('button')!, status = root.querySelector<HTMLElement>('#test-status')!;
let defaultServer = '';
try { const config = await fetch('/multiplayer.json').then(r => r.json()) as { server?: string }; defaultServer = config.server ?? ''; } catch { /* The invitation can supply a server. */ }

async function enter(value: string): Promise<void> {
  button.disabled = true; status.textContent = t('Проверяю приглашение…');
  try {
    const url = value.includes('://') ? new URL(value) : new URL(location.href);
    const params = new URLSearchParams(url.hash.slice(1));
    const key = /^[a-f0-9]{64}$/.test(value) ? value : params.get('test') ?? '';
    const server = serverAddress(params.get('server') ?? defaultServer);
    await checkAccess(server, key);
    enablePlaytest({ server, key });
    if (value.includes('://')) history.replaceState(null, '', location.pathname + url.hash);
    await import('./main');
  } catch (error) {
    status.textContent = t(error instanceof Error ? error.message : 'Не удалось проверить приглашение.');
    button.disabled = false;
  }
}
root.querySelector('form')!.onsubmit = e => { e.preventDefault(); void enter(field.value.trim()); };
if (new URLSearchParams(location.hash.slice(1)).has('test')) void enter(location.href);
