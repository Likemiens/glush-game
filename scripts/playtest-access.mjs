import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), data = resolve(root, '.data');
await mkdir(data, { recursive: true });
const file = resolve(data, 'private-playtest.json');
let saved;
try { saved = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const key = process.argv.includes('--rotate') || !saved ? randomBytes(32).toString('hex') : saved.key;
if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Invalid saved playtest key');
const config = JSON.parse(await readFile(resolve(root, 'public/multiplayer.json'), 'utf8'));
const url = new URL('/playtest/', process.env.GLUSH_CLIENT_URL ?? 'https://glush.varantsov.ru');
url.hash = new URLSearchParams({ server: config.server, test: key }).toString();
const hash = createHash('sha256').update(key).digest('hex');
await writeFile(file, JSON.stringify({ key, hash, server: config.server, url: url.href }, null, 2));
const output = resolve(root, 'test-results/private-playtest'); await mkdir(output, { recursive: true });
const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>GLUSH — закрытый тест</title><style>body{font:20px/1.6 system-ui;background:#17120f;color:#dcc784;max-width:640px;padding:32px;margin:32px auto}a{color:inherit}a.start{display:block;background:#dcc784;color:#17120f;padding:20px;text-align:center;border-radius:8px}small{color:#baad90}</style><h1>GLUSH · закрытый тест</h1><a class="start" href="${url.href}">Открыть кооператив →</a><p>На станции: «Играть с друзьями» → «Создать общий мир» → «Скопировать приглашение». Отправь приглашение друзьям — оно сразу откроет закрытый тест и нужный мир.</p><p>Чтобы продолжить прежний мир, нажми «Продолжить общий мир» или вставь старое приглашение после входа в тест.</p><small>Ссылка даёт доступ к кооперативу. Отправляй её только своим тестерам. Личный ключ машины остаётся отдельным.</small></html>`;
await writeFile(resolve(output, 'OPEN-PLAYTEST.html'), html);
await writeFile(resolve(output, 'GLUSH-private-playtest.url'), `[InternetShortcut]\r\nURL=${url.href}\r\n`);
if (process.argv.includes('--hash')) process.stdout.write(hash + '\n');
else console.log('Private launch files saved in test-results/private-playtest; secret is kept in .data/private-playtest.json.');
