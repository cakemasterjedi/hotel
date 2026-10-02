const $ = (sel, root = document) => root.querySelector(sel);
const state = { hotels: [], stay: null, currency: 'USD', heat: new Map(), watched: new Set() };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, digits = 0) => (n == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n));

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function qs(extra = {}) {
  return new URLSearchParams({ ...state.stay, ...extra }).toString();
}

// ---------- setup ----------
const form = $('#search-form');
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
form.checkIn.min = form.checkOut.min = iso(today);
form.checkIn.value = iso(new Date(today.getTime() + 14 * 864e5));
form.checkOut.value = iso(new Date(today.getTime() + 16 * 864e5));
form.checkIn.addEventListener('change', () => {
  if (form.checkOut.value <= form.checkIn.value) {
    form.checkOut.value = iso(new Date(new Date(form.checkIn.value).getTime() + 864e5));
  }
});

try {
  const saved = JSON.parse(localStorage.getItem('hh-last') || 'null');
  if (saved?.q) form.q.value = saved.q;
} catch { /* storage unavailable */ }

api('/api/status').then((s) => {
  $('#demo-banner').hidden = !s.demo;
  $('#watch-interval').textContent = s.watchIntervalHours;
}).catch(() => {});

document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  $('#tab-search').hidden = btn.dataset.tab !== 'search';
  $('#tab-watch').hidden = btn.dataset.tab !== 'watch';
  if (btn.dataset.tab === 'watch') loadWatches();
}));

// ---------- search ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  state.stay = data;
  state.currency = data.currency;
  try { localStorage.setItem('hh-last', JSON.stringify({ q: data.q })); } catch { /* ignore */ }
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  $('#results').innerHTML = '<p class="muted empty">Comparing prices across booking sites…</p>';
  $('#summary').textContent = '';
  try {
    const res = await api(`/api/search?${qs()}`);
    state.hotels = res.hotels;
    state.heat.clear();
    $('#filters').hidden = false;
    render();
  } catch (err) {
    $('#results').innerHTML = `<p class="error empty">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search all sites';
  }
});

['#f-pool', '#f-hottub', '#f-heated', '#f-max', '#f-rating', '#f-stars', '#f-sort'].forEach((id) => $(id).addEventListener('input', render));

function filtered() {
  const pool = $('#f-pool').value;
  const hotTub = $('#f-hottub').checked;
  const heated = $('#f-heated').checked;
  const max = Number($('#f-max').value) || Infinity;
  const minRating = Number($('#f-rating').value);
  const minStars = Number($('#f-stars').value);
  const sort = $('#f-sort').value;

  const list = state.hotels.filter((h) => {
    const f = h.features;
    if (!h.best) return false;
    if (pool === 'pool' && !f.pool) return false;
    if (pool === 'indoor' && !f.indoorPool) return false;
    if (pool === 'outdoor' && !f.outdoorPool) return false;
    if (hotTub && !f.hotTub) return false;
    if (heated) {
      const verdict = state.heat.get(h.token)?.pool?.status;
      if (!(verdict === 'warm' || (!verdict && f.heatedPoolListed))) return false;
    }
    if (h.best.nightly > max) return false;
    if ((h.rating || 0) < minRating) return false;
    if ((h.hotelClass || 0) < minStars) return false;
    return true;
  });
  const by = {
    total: (a, b) => a.best.total - b.best.total,
    nightly: (a, b) => a.best.nightly - b.best.nightly,
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    value: (a, b) => (b.rating || 0) / b.best.nightly - (a.rating || 0) / a.best.nightly,
  };
  return list.sort(by[sort]);
}

function render() {
  const list = filtered();
  const nights = state.hotels[0]?.nights || 1;
  const heatedOn = $('#f-heated').checked;
  $('#summary').innerHTML = `${list.length} of ${state.hotels.length} hotels · ${nights} night${nights > 1 ? 's' : ''}`
    + (heatedOn ? ' · <em>Heated filter only shows hotels whose reviews have been checked (or that list a heated pool)</em>' : '');
  const root = $('#results');
  root.innerHTML = '';
  if (!list.length) {
    root.innerHTML = '<p class="muted empty">No hotels match these filters.</p>';
    return;
  }
  for (const h of list) root.append(hotelCard(h));
}

function stars(n) {
  return n ? '★'.repeat(n) : '';
}

function hotelCard(h) {
  const el = $('#hotel-tpl').content.firstElementChild.cloneNode(true);
  el.dataset.token = h.token;
  const thumb = $('.thumb', el);
  if (h.image) thumb.style.backgroundImage = `url("${encodeURI(h.image)}")`;
  else thumb.textContent = '🏨';

  $('.name', el).innerHTML = h.link ? `<a href="${esc(h.link)}" target="_blank" rel="noopener">${esc(h.name)}</a>` : esc(h.name);
  $('.meta', el).innerHTML = [
    h.hotelClass ? `<span title="${h.hotelClass}-star">${stars(h.hotelClass)}</span>` : '',
    h.rating ? `<b>${h.rating}</b>/5 (${h.reviewCount.toLocaleString()} reviews)` : '',
  ].filter(Boolean).join(' · ');

  $('.nightly', el).innerHTML = `${money(h.best.nightly)} <small>/ night</small>`;
  $('.total', el).innerHTML = `${money(h.best.total)} <small>total · ${h.nights} night${h.nights > 1 ? 's' : ''}</small>`;
  $('.where', el).textContent = `cheapest on ${h.best.source}${h.offers.length > 1 ? ` · ${h.offers.length} sites listed` : ''}`;

  renderBadges(el, h);
  renderForecast($('.forecast', el), h.forecast);

  const btnPrices = $('.act-prices', el);
  btnPrices.addEventListener('click', () => togglePrices(el, h, btnPrices));
  const btnHeat = $('.act-heat', el);
  if (!h.features.pool && !h.features.hotTub) btnHeat.hidden = true;
  btnHeat.addEventListener('click', () => toggleHeat(el, h, btnHeat));
  if (state.heat.has(h.token)) renderHeat(el, h, state.heat.get(h.token));
  const btnWatch = $('.act-watch', el);
  if (state.watched.has(h.token)) btnWatch.textContent = '★ Watching';
  btnWatch.addEventListener('click', () => watch(h, btnWatch));
  return el;
}

function renderBadges(el, h) {
  const f = h.features;
  const heat = state.heat.get(h.token);
  const b = [];
  if (f.indoorPool) b.push(['🏊 Indoor pool', '']);
  if (f.outdoorPool) b.push(['🏊 Outdoor pool', '']);
  if (f.pool && !f.indoorPool && !f.outdoorPool) b.push(['🏊 Pool', '']);
  if (f.hotTub) b.push(['♨️ Hot tub', '']);
  if (f.heatedPoolListed) b.push(['Heated pool (listed)', 'good']);
  if (heat) {
    const cls = { warm: 'good', cold: 'bad', mixed: 'warn' };
    if (heat.pool.status !== 'unknown') b.push([`Pool: ${heat.pool.label}`, cls[heat.pool.status]]);
    if (heat.hotTub.status !== 'unknown') b.push([`Hot tub: ${heat.hotTub.label}`, cls[heat.hotTub.status]]);
  }
  if (h.best.freeCancellation) b.push(['Free cancellation', 'good']);
  if (!f.pool && !f.hotTub) b.push(['No pool or hot tub listed', '']);
  $('.badges', el).innerHTML = b.map(([t, c]) => `<span class="badge ${c}">${esc(t)}</span>`).join('');
}

function renderForecast(box, fc) {
  if (!fc) { box.hidden = true; return; }
  const arrow = fc.week.expected > fc.current * 1.01 ? '↗' : fc.week.expected < fc.current * 0.99 ? '↘' : '→';
  box.innerHTML = `
    <span>📈 If you wait:</span>
    <span>tomorrow up to <b>${money(fc.tomorrow.high)}</b>/night</span>
    <span>in a week ${arrow} ~<b>${money(fc.week.expected)}</b>, up to <b>${money(fc.week.high)}</b>/night (<b>${money(fc.week.highTotal)}</b> total)</span>
    <span>${fc.chanceUpInAWeek}% chance higher in 7 days</span>
    <span class="advice"><b>${esc(fc.advice)}</b></span>
    <details><summary>Why? (confidence: ${fc.confidence})</summary><ul>${fc.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    Estimates are statistical guesses, not guarantees. High = 90th-percentile scenario.</details>`;
}

// ---------- per-site prices ----------
async function togglePrices(el, h, btn) {
  const panel = $('.panel-prices', el);
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<p class="muted">Loading every site\'s price…</p>';
  btn.disabled = true;
  try {
    const d = await api(`/api/hotel/${encodeURIComponent(h.token)}/prices?${qs()}`);
    Object.assign(h, { best: d.best, offers: d.offers, forecast: d.forecast });
    renderForecast($('.forecast', el), d.forecast);
    $('.nightly', el).innerHTML = `${money(d.best.nightly)} <small>/ night</small>`;
    $('.total', el).innerHTML = `${money(d.best.total)} <small>total · ${d.nights} night${d.nights > 1 ? 's' : ''}</small>`;
    $('.where', el).textContent = `cheapest on ${d.best.source} · ${d.offers.length} sites compared`;
    if (!d.offers.length) { panel.innerHTML = '<p class="muted">No per-site prices available.</p>'; return; }
    panel.innerHTML = `<div class="table-scroll"><table>
      <thead><tr><th>Site</th><th class="num">Per night</th><th class="num">Total</th><th class="num col-tax">Before taxes</th><th></th></tr></thead>
      <tbody>${d.offers.map((o, i) => `<tr class="${i === 0 ? 'best' : ''}">
        <td>${esc(o.source)}${o.freeCancellation ? ' <span class="badge good">free cancel</span>' : ''}</td>
        <td class="num">${money(o.nightly)}</td>
        <td class="num">${money(o.total)}</td>
        <td class="num muted col-tax">${o.totalBeforeTax != null ? money(o.totalBeforeTax) : '—'}</td>
        <td>${o.link ? `<a href="${esc(o.link)}" target="_blank" rel="noopener">Book →</a>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;
  } catch (err) {
    panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- pool heat ----------
async function fetchHeat(h) {
  if (state.heat.has(h.token)) return state.heat.get(h.token);
  const d = await api(`/api/hotel/${encodeURIComponent(h.token)}/heat?heatedListed=${h.features.heatedPoolListed ? 1 : 0}`);
  state.heat.set(h.token, d);
  return d;
}

async function toggleHeat(el, h, btn) {
  const panel = $('.panel-heat', el);
  if (!panel.hidden && state.heat.has(h.token)) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<p class="muted">Reading reviews for water-temperature mentions…</p>';
  btn.disabled = true;
  try {
    renderHeat(el, h, await fetchHeat(h));
  } catch (err) {
    panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

function heatBlock(title, v) {
  const quotes = v.evidence.map((e) => `<div class="quote ${e.sentiment}">“${esc(e.quote)}”${e.date ? ` <span class="muted">— ${esc(e.date)}</span>` : ''}</div>`).join('');
  const counts = v.warm + v.cold ? `${v.warm} warm vs ${v.cold} cold mention${v.warm + v.cold > 1 ? 's' : ''} · confidence ${v.confidence}` : `${v.mentions} review${v.mentions === 1 ? '' : 's'} mention it, none mention temperature`;
  return `<div><h4>${title}: ${esc(v.label)}</h4><div class="muted">${counts}</div>${quotes}</div>`;
}

function renderHeat(el, h, d) {
  const panel = $('.panel-heat', el);
  panel.hidden = false;
  const blocks = [];
  if (h.features.pool || d.pool.mentions) blocks.push(heatBlock('🏊 Pool', d.pool));
  if (h.features.hotTub || d.hotTub.mentions) blocks.push(heatBlock('♨️ Hot tub', d.hotTub));
  panel.innerHTML = `<div class="heat-grid">${blocks.join('')}</div>
    <p class="muted">Based on ${d.reviewsAnalyzed} recent reviews${d.pool.listedHeated ? ' plus the listing saying “heated pool”' : ''}. Outdoor pools are often only heated seasonally.</p>`;
  renderBadges(el, h);
}

$('#bulk-heat').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const targets = filtered().filter((h) => (h.features.pool || h.features.hotTub) && !state.heat.has(h.token)).slice(0, 10);
  if (!targets.length) return;
  btn.disabled = true;
  let done = 0;
  btn.textContent = `Checking 0/${targets.length}…`;
  await Promise.all(targets.map(async (h) => {
    try { await fetchHeat(h); } catch { /* shown per-hotel on demand */ }
    btn.textContent = `Checking ${++done}/${targets.length}…`;
  }));
  btn.disabled = false;
  btn.textContent = 'Check pool heat for top 10';
  render();
});

// ---------- watchlist ----------
async function watch(h, btn) {
  try {
    await api('/api/watches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...state.stay, token: h.token, name: h.name }),
    });
    state.watched.add(h.token);
    btn.textContent = '★ Watching';
    refreshWatchCount();
  } catch (err) {
    alert(err.message);
  }
}

function sparkline(history) {
  const pts = history.filter((p) => p.nightly != null);
  if (pts.length < 2) return '<span class="muted">collecting data…</span>';
  const w = 160; const hgt = 36;
  const xs = pts.map((p) => p.observedAt); const ys = pts.map((p) => p.nightly);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x) => (x1 === x0 ? 0 : ((x - x0) / (x1 - x0)) * (w - 4) + 2);
  const sy = (y) => (y1 === y0 ? hgt / 2 : hgt - 2 - ((y - y0) / (y1 - y0)) * (hgt - 4));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.observedAt).toFixed(1)},${sy(p.nightly).toFixed(1)}`).join('');
  return `<svg class="spark" width="${w}" height="${hgt}" role="img" aria-label="Price history"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
}

async function loadWatches() {
  const root = $('#watchlist');
  try {
    const rows = await api('/api/watches');
    state.watched = new Set(rows.map((w) => w.property_token));
    $('#watch-count').textContent = rows.length ? `(${rows.length})` : '';
    if (!rows.length) { root.innerHTML = '<p class="muted empty">Nothing watched yet. Click “☆ Watch price” on a hotel.</p>'; return; }
    root.innerHTML = rows.map((w) => {
      const last = w.history.at(-1);
      const first = w.history[0];
      const change = last && first && first.nightly ? ((last.nightly - first.nightly) / first.nightly) * 100 : 0;
      const cur = new Intl.NumberFormat(undefined, { style: 'currency', currency: w.currency, maximumFractionDigits: 0 });
      return `<div class="card watch">
        <div><b>${esc(w.name)}</b><div class="muted">${esc(w.check_in)} → ${esc(w.check_out)} · ${w.adults} adults</div></div>
        ${sparkline(w.history)}
        <div class="price">${last ? `<div class="nightly">${cur.format(last.nightly)} <small>/ night</small></div><div class="where">${last.total ? `${cur.format(last.total)} total · ` : ''}${change ? `${change > 0 ? '+' : ''}${change.toFixed(1)}% since watching` : 'no change yet'}</div>` : '<span class="muted">pending</span>'}</div>
        <button class="secondary" data-del="${w.id}">Remove</button>
      </div>`;
    }).join('');
    root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/watches/${b.dataset.del}`, { method: 'DELETE' });
      loadWatches();
    }));
  } catch (err) {
    root.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

async function refreshWatchCount() {
  try {
    const rows = await api('/api/watches');
    state.watched = new Set(rows.map((w) => w.property_token));
    $('#watch-count').textContent = rows.length ? `(${rows.length})` : '';
  } catch { /* ignore */ }
}
refreshWatchCount();
