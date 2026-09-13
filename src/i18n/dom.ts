import { t } from './index';

type Original = { source: string; rendered: string };
const texts = new WeakMap<Text, Original>();
const attributes = new WeakMap<Element, Map<string, Original>>();
const excluded = 'script,style,input,textarea,[translate="no"]';
function translated(value: string, original?: Original): Original {
  const source = original && value === original.rendered ? original.source : value;
  return { source, rendered: t(source) };
}

/** Keeps original copy for live switching, without changing markup, input values or command IDs. */
export function localize(root: Element): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const node = current as Text;
    if (!node.parentElement || node.parentElement.closest(excluded)) continue;
    const value = translated(node.data, texts.get(node));
    texts.set(node, value);
    if (node.data !== value.rendered) node.data = value.rendered;
  }
  for (const el of [root, ...root.querySelectorAll('[aria-label],[title],[placeholder]')]) {
    if (el.closest('[translate="no"]')) continue;
    const saved = attributes.get(el) ?? new Map<string, Original>();
    for (const key of ['aria-label', 'title', 'placeholder']) {
      const original = el.getAttribute(key); if (original === null) continue;
      const value = translated(original, saved.get(key)); saved.set(key, value);
      if (original !== value.rendered) el.setAttribute(key, value.rendered);
    }
    attributes.set(el, saved);
  }
}
