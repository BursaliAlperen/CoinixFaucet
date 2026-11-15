// CoinixFaucet i18n: 22 languages, device-language auto-detection, flag selector (flag-icons).
// Elements opt in with data-i18n="key"; English text stays in the HTML as the fallback.
export const LANGS = [
  ['en', 'gb', 'English'], ['tr', 'tr', 'Türkçe'], ['ru', 'ru', 'Русский'], ['es', 'es', 'Español'],
  ['pt', 'pt', 'Português'], ['fr', 'fr', 'Français'], ['de', 'de', 'Deutsch'], ['it', 'it', 'Italiano'],
  ['ar', 'sa', 'العربية'], ['hi', 'in', 'हिन्दी'], ['id', 'id', 'Indonesia'], ['vi', 'vn', 'Tiếng Việt'],
  ['th', 'th', 'ไทย'], ['zh', 'cn', '中文'], ['ja', 'jp', '日本語'], ['ko', 'kr', '한국어'],
  ['pl', 'pl', 'Polski'], ['uk', 'ua', 'Українська'], ['nl', 'nl', 'Nederlands'], ['fa', 'ir', 'فارسی'],
  ['bn', 'bd', 'বাংলা'], ['ur', 'pk', 'اردو']
];
const RTL = new Set(['ar', 'fa', 'ur']);
const STORE = 'cx-lang';
const codes = LANGS.map(l => l[0]);
const cache = {};

export function detectLang() {
  try { const saved = localStorage.getItem(STORE); if (saved && codes.includes(saved)) return saved; } catch (_) {}
  for (const tag of (navigator.languages || [navigator.language || 'en'])) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (codes.includes(base)) return base;
  }
  return 'en';
}

async function load(code) {
  if (cache[code]) return cache[code];
  try {
    const r = await fetch(`/locales/${code}.json`, { cache: 'force-cache' });
    if (!r.ok) throw new Error(r.status);
    return (cache[code] = await r.json());
  } catch (_) { return null; }
}

function apply(code, dict) {
  document.documentElement.lang = code;
  document.documentElement.dir = RTL.has(code) ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    if (el.dataset.i18nEn === undefined) el.dataset.i18nEn = el.textContent;
    const v = dict && dict[el.dataset.i18n];
    el.textContent = v || el.dataset.i18nEn;
  });
}

export async function setLang(code, persist = true) {
  if (!codes.includes(code)) code = 'en';
  const dict = code === 'en' ? null : await load(code);
  apply(code, dict);
  if (persist) { try { localStorage.setItem(STORE, code); } catch (_) {} }
  renderSelector(code);
}

function renderSelector(current) {
  const root = document.getElementById('cxLang');
  if (!root) return;
  const [, curFlag] = LANGS.find(l => l[0] === current) || LANGS[0];
  root.innerHTML = `
    <button class="cx-lang-btn" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Language">
      <span class="fi fi-${curFlag}" aria-hidden="true"></span><span class="cx-lang-code">${current.toUpperCase()}</span>
    </button>
    <ul class="cx-lang-menu" role="listbox" aria-label="Language" hidden>
      ${LANGS.map(([c, f, n]) => `<li role="option" tabindex="-1" data-code="${c}" aria-selected="${c === current}"><span class="fi fi-${f}" aria-hidden="true"></span><span>${n}</span></li>`).join('')}
    </ul>`;
  const btn = root.querySelector('.cx-lang-btn'), menu = root.querySelector('.cx-lang-menu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('[aria-selected="true"]')?.focus();
  });
  menu.addEventListener('click', e => { const li = e.target.closest('[data-code]'); if (li) setLang(li.dataset.code); });
  menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('[data-code]')], i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(i + 1, items.length - 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(i - 1, 0)]?.focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.activeElement?.click(); }
    else if (e.key === 'Escape') { close(); btn.focus(); }
  });
  document.addEventListener('click', e => { if (!root.contains(e.target)) close(); }, { once: true });
}

window.cxI18n = { refresh: () => setLang(document.documentElement.lang || 'en', false), setLang };
setLang(detectLang(), false);
