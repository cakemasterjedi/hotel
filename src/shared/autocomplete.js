// Small accessible autocomplete dropdown for text inputs (browser only).
// attachAutocomplete(input, { source: async (q) => [{ label, ... }], onPick(item) })

let styled = false;
let uid = 0;

function addStyles() {
  if (styled) return;
  styled = true;
  const css = `
  .ac-list { position: absolute; z-index: 50; margin: 4px 0 0; padding: 4px; list-style: none; max-height: 280px; overflow-y: auto;
    background: var(--ac-bg, #1a1f28); color: var(--ac-text, #e6e9ef); border: 1px solid var(--ac-border, #2b3240);
    border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.35); font-size: 15px; }
  .ac-list[hidden] { display: none !important; }
  .ac-list li { padding: 9px 10px; border-radius: 7px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
  .ac-list li[aria-selected="true"], .ac-list li:hover { background: var(--ac-active, #24324a); }
  .ac-list .ac-sub { color: var(--ac-muted, #98a0b3); font-size: 12px; }`;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.append(el);
}

export function attachAutocomplete(input, { source, onPick, minChars = 2, delay = 180 }) {
  addStyles();
  const list = document.createElement('ul');
  list.className = 'ac-list';
  list.id = `ac-${++uid}`;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  document.body.append(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('autocomplete', 'off');

  let items = [];
  let active = -1;
  let timer = null;
  let seq = 0;

  const place = () => {
    const r = input.getBoundingClientRect();
    list.style.left = `${r.left + window.scrollX}px`;
    list.style.top = `${r.bottom + window.scrollY}px`;
    list.style.width = `${Math.max(r.width, 220)}px`;
  };
  const close = () => {
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, n) => li.setAttribute('aria-selected', String(n === i)));
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', list.children[i].id);
      list.children[i].scrollIntoView({ block: 'nearest' });
    }
  };
  const pick = (i) => {
    const item = items[i];
    if (!item) return;
    input.value = item.label;
    close();
    onPick?.(item);
  };
  const render = () => {
    list.innerHTML = '';
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      const [main, ...rest] = item.label.split(', ');
      li.textContent = main;
      if (rest.length) {
        const sub = document.createElement('span');
        sub.className = 'ac-sub';
        sub.textContent = rest.join(', ');
        li.append(sub);
      }
      // mousedown so the pick happens before the input loses focus
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      list.append(li);
    });
    if (!items.length) { close(); return; }
    place();
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(-1);
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < minChars) { items = []; close(); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      let found = [];
      try { found = await source(q); } catch { found = []; }
      if (mine !== seq || document.activeElement !== input) return; // stale or user moved on
      items = found || [];
      render();
    }, delay);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active <= 0 ? items.length - 1 : active - 1); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') close();
  }, true); // capture: runs before the page's own Enter handlers
  input.addEventListener('blur', () => setTimeout(close, 120));
  window.addEventListener('resize', () => { if (!list.hidden) place(); });
  return { close };
}
