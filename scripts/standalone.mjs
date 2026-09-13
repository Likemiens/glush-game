import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const bundle = await build({ configFile: false, root, build: { write: false, rollupOptions: { input: resolve(root, 'index.html'), output: { inlineDynamicImports: true } } } });
const files = bundle.output;
let html = String(files.find(file => file.fileName === 'index.html').source);
let css = String(files.find(file => file.fileName.endsWith('.css')).source);
let js = files.find(file => file.type === 'chunk' && file.isEntry).code;
const music = await readFile(resolve(root, 'public/audio/machina-game.mp3'));
js = js.replaceAll('/audio/machina-game.mp3', `data:audio/mpeg;base64,${music.toString('base64')}`);
for (const font of ['tiny5']) {
  const data = await readFile(resolve(root, `public/fonts/${font}.ttf`));
  css = css.replaceAll(`/fonts/${font}.ttf`, `data:font/ttf;base64,${data.toString('base64')}`);
}
const favicon = await readFile(resolve(root, 'public/favicon.svg'), 'utf8');
html = html.replace(/<link rel="icon"[^>]+>/, `<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(favicon).toString('base64')}">`);
html = html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, () => `<script type="module">${js.replaceAll('</script', '<\\/script')}</script>`);
html = html.replace(/<link rel="stylesheet"[^>]+>/, () => `<style>${css}</style>`);
html += `\n<!-- GLUSH: original procedural game and sprites. Visual reference: Kit Langton, https://x.com/kitlangton/status/2097026206617026936/video/1. -->\n`;
for (const license of ['TINY5-LICENSE']) html += `<!-- ${await readFile(resolve(root, `public/fonts/${license}.txt`), 'utf8')} -->\n`;
html += `<!-- ${await readFile(resolve(root, 'public/audio/CREDITS.txt'), 'utf8')} -->\n`;
const destination = resolve(root, '..', 'Глушь.html');
await writeFile(destination, html);
console.log(`Standalone game: ${destination} (${Math.round(Buffer.byteLength(html) / 1024)} KB)`);
