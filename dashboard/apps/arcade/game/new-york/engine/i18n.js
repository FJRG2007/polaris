// The game's words. Every string the page shows lives in the app's catalogs
// (`apps/arcade/messages/<locale>/new-york.json`); the framing page sends the
// reader's one over postMessage (`polaris-game:setup`, embed.js), and the English
// one is bundled for a page opened on its own and for any key a catalog lacks.
//
// In the page, `data-t="key"` sets an element's text, and `data-t-title`,
// `data-t-aria` and `data-t-placeholder` its title, aria-label and placeholder.
import source from '../../../messages/en-US/new-york.json';

const MAX_KEYS = 2000;
const MAX_TEXT = 500;

/** `{ a: { b: 'x' } }` -> Map { 'a.b' => 'x' }; null when it is not a catalog of strings. */
export function readCatalog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const found = new Map();
  const walk = (node, prefix, depth) => {
    if (depth > 6) return false;
    for (const [key, value] of Object.entries(node)) {
      if (!/^[\w-]{1,64}$/.test(key)) return false;
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string') {
        if (value.length > MAX_TEXT || found.size >= MAX_KEYS) return false;
        found.set(path, value);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (!walk(value, path, depth + 1)) return false;
      } else {
        return false;
      }
    }
    return true;
  };
  return walk(raw, '', 0) ? found : null;
}

/** `{name}` placeholders filled from `values`; an unknown one is left as written. */
export function fill(text, values) {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
}

const fallback = readCatalog(source);
let table = fallback;
let locale = 'en-US';
const listeners = new Set();

export function t(key, values) {
  return fill(table.get(key) ?? fallback.get(key) ?? key, values);
}

export function currentLocale() {
  return locale;
}

/** A number in the reader's locale. */
export function formatNumber(value, options) {
  try {
    return new Intl.NumberFormat(locale, options).format(value);
  } catch {
    return String(value);
  }
}

/** Fills every `data-t*` element under `root` from the current catalog. */
export function translatePage(root = document) {
  for (const el of root.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of root.querySelectorAll('[data-t-title]')) el.title = t(el.dataset.tTitle) + (el.dataset.tKey ? ` [${el.dataset.tKey}]` : '');
  for (const el of root.querySelectorAll('[data-t-aria]')) el.setAttribute('aria-label', t(el.dataset.tAria));
  for (const el of root.querySelectorAll('[data-t-placeholder]')) el.placeholder = t(el.dataset.tPlaceholder);
  document.documentElement.lang = locale;
}

/** Called after every change of catalog, so text drawn by code is drawn again. */
export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let settle;
/** Resolves once the reader's catalog is in (or it is clear none is coming). */
export const localeReady = new Promise((resolve) => { settle = resolve; });

/** Switches to `catalog` (a `readCatalog` map) for `nextLocale`. */
export function applyCatalog(nextLocale, catalog) {
  locale = nextLocale;
  table = catalog;
  translatePage();
  for (const listener of listeners) listener();
  settle();
}

/** Keeps the bundled English: the page is on its own, or the host never answered. */
export function keepFallback() {
  translatePage();
  settle();
}
