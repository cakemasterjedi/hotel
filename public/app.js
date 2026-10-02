import { haversineKm, formatDistance, KM_PER_MI } from './shared/geo.js';

const $ = (sel, root = document) => root.querySelector(sel);
const state = {
  hotels: [], stay: null, currency: 'USD', center: null, origin: null,
  heat: new Map(), watched: new Set(), shown: 40,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency, maximumFractionDigits: 0 }).format(n));
const store = {
  get(k, d) { try { const v = localStorage.getItem(`hh-${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`hh-${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

async function api(path, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- setup ----------
const form = $('#search-form');
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
form.checkIn.min = form.checkOut.min = iso(today);
form.checkIn.value = iso(new Date(today.getTime() + 14 * 864e5));
form.checkOut.value = iso(new Date(today.getTime() + 16 * 864e5));
form.checkIn.addEventListener('change', () => {
  if (form.checkOut.value <= form.checkIn.value) form.checkOut.value = iso(new Date(new Date(form.checkIn.value).getTime() + 864e5));
});
form.q.value = store.get('q', '');
state.origin = store.get('origin', null);
$('#unit').value = store.get('unit', 'mi');
for (const id of ['w-pool', 'w-hottub', 'w-heated']) $(`#${id}`).checked = store.get(id, $(`#${id}`).checked);

api('/api/status').then((s) => {
  $('#demo-banner').hidden = !s.demo;
  state.currency = s.currency || 'USD';
  $('#watch-interval').textContent = s.watchIntervalHours;
  $('#sources').textContent = `Searches ${s.sources.join(', ')}.`;
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
  store.set('q', data.q);
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  $('#results').innerHTML = '<p class="muted empty">Comparing prices on Super.com, Booking.com, Tripadvisor and more. This takes 10–30 seconds.</p>';
  $('#summary').textContent = '';
  try {
    const res = await api(`/api/search?${new URLSearchParams(data)}`);
    state.hotels = res.hotels;
    state.center = res.center;
    state.heat.clear();
    state.shown = 40;
    $('#filters').hidden = false;
    renderSources(res.status, res.cached);
    renderOrigin();
    render();
    fillCoordinates();
  } catch (err) {
    $('#results').innerHTML = `<p class="error empty">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search all sites';
  }
});

function renderSources(status = [], cached) {
  const parts = status.map((s) => (s.ok
    ? `${esc(s.label)} <b>${s.count}</b>`
    : `<span class="warn-text" title="${esc(s.error)}">${esc(s.label)} unavailable</span>`));
  $('#sources').innerHTML = `Compared ${parts.join(' · ')}${cached ? ' · <span title="Saved results from the last few hours">cached</span>' : ''}`;
}

// Some sites (e.g. Super.com) don't give coordinates; look them up in the background.
async function fillCoordinates() {
  const missing = state.hotels.filter((h) => h.lat == null).slice(0, 120);
  for (let i = 0; i < missing.length; i += 40) {
    const chunk = missing.slice(i, i + 40);
    try {
      const found = await api('/api/coords', { center: state.center, hotels: chunk.map((h) => ({ key: h.key, name: [h.name, h.city].filter(Boolean).join(', ') })) });
      for (const h of chunk) if (found[h.key]) Object.assign(h, found[h.key]);
      render();
    } catch { return; }
  }
}

// ---------- distance origin ----------
function originPoint() {
  return state.origin || state.center;
}

function renderOrigin() {
  const o = originPoint();
  $('#origin-label').textContent = state.origin ? state.origin.name : o ? `${o.name || 'destination'} centre` : 'destination centre';
}

$('#origin-me').addEventListener('click', () => {
  if (!navigator.geolocation || !window.isSecureContext) {
    alert('Your browser only shares your location on secure (https) pages. Type your city instead.');
    return;
  }
  $('#origin-label').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude, name: 'your location' }),
    () => { renderOrigin(); alert('Couldn\'t get your location. Type a city instead.'); },
    { timeout: 15000, maximumAge: 600000 },
  );
});

$('#origin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#origin-q').value.trim();
  if (!q) { setOrigin(null); return; }
  $('#origin-label').textContent = 'Looking up…';
  try {
    setOrigin(await api(`/api/geocode?q=${encodeURIComponent(q)}`));
    $('#origin-q').value = '';
  } catch (err) {
    renderOrigin();
    alert(err.message);
  }
});

function setOrigin(o) {
  state.origin = o;
  store.set('origin', o);
  renderOrigin();
  render();
}

$('#unit').addEventListener('change', () => { store.set('unit', $('#unit').value); render(); });

// ---------- filtering, highlighting, sorting ----------
['#f-sort', '#f-dist', '#f-max', '#f-rating', '#f-stars'].forEach((id) => $(id).addEventListener('input', () => { state.shown = 40; render(); }));
['w-pool', 'w-hottub', 'w-heated'].forEach((id) => $(`#${id}`).addEventListener('change', () => { store.set(id, $(`#${id}`).checked); render(); }));

function distanceKm(h) {
  return h.lat == null ? null : haversineKm(originPoint(), { lat: h.lat, lng: h.lng });
}

function heatedState(h) {
  const v = state.heat.get(h.key)?.pool?.status;
  if (v === 'warm') return 'yes';
  if (v === 'cold') return 'no';
  return h.features.heatedPoolListed ? 'yes' : 'unknown';
}

// Which of the wanted perks this hotel has.
function perks(h) {
  const want = { pool: $('#w-pool').checked, hotTub: $('#w-hottub').checked, heated: $('#w-heated').checked };
  const has = [];
  const missing = [];
  if (want.pool) (h.features.pool ? has : missing).push('pool');
  if (want.hotTub) (h.features.hotTub ? has : missing).push('hot tub');
  if (want.heated) (heatedState(h) === 'yes' ? has : missing).push('heated pool');
  const wanted = has.length + missing.length;
  return { has, missing, level: !wanted || !has.length ? 0 : missing.length ? 1 : 2 };
}

function filtered() {
  const unit = $('#unit').value;
  const maxDist = Number($('#f-dist').value) * (unit === 'km' ? 1 : KM_PER_MI);
  const max = Number($('#f-max').value) || Infinity;
  const minRating = Number($('#f-rating').value);
  const minStars = Number($('#f-stars').value);
  const sort = $('#f-sort').value;
  const list = state.hotels.filter((h) => {
    if (!h.best || h.best.nightly > max) return false;
    if ((h.rating || 0) < minRating) return false;
    if ((h.stars || 0) < minStars) return false;
    if (maxDist) {
      const d = distanceKm(h);
      if (d != null && d > maxDist) return false;
    }
    return true;
  });
  const dist = (h) => distanceKm(h) ?? Infinity;
  const by = {
    total: (a, b) => a.best.total - b.best.total,
    nightly: (a, b) => a.best.nightly - b.best.nightly,
    distance: (a, b) => dist(a) - dist(b),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    value: (a, b) => (b.rating || 0) / b.best.nightly - (a.rating || 0) / a.best.nightly,
  };
  return list.sort(by[sort]);
}

function render() {
  if (!state.hotels.length) return;
  const list = filtered();
  const nights = state.hotels[0]?.nights || 1;
  const matches = list.filter((h) => perks(h).level === 2).length;
  $('#summary').innerHTML = `${list.length} of ${state.hotels.length} hotels · ${nights} night${nights > 1 ? 's' : ''}`
    + (matches ? ` · <span class="match-text">${matches} have everything you highlighted</span>` : '');
  const root = $('#results');
  root.innerHTML = '';
  if (!list.length) {
    root.innerHTML = '<p class="muted empty">No hotels match these filters.</p>';
    return;
  }
  for (const h of list.slice(0, state.shown)) root.append(hotelCard(h));
  if (list.length > state.shown) {
    const more = document.createElement('button');
    more.className = 'secondary more';
    more.textContent = `Show ${Math.min(40, list.length - state.shown)} more`;
    more.addEventListener('click', () => { state.shown += 40; render(); });
    root.append(more);
  }
}

function hotelCard(h) {
  const el = $('#hotel-tpl').content.firstElementChild.cloneNode(true);
  el.dataset.key = h.key;
  const thumb = $('.thumb', el);
  if (h.image) thumb.style.backgroundImage = `url("${encodeURI(h.image)}")`;
  else { thumb.textContent = '🏨'; thumb.classList.add('empty'); }

  $('.name', el).innerHTML = h.link ? `<a href="${esc(h.link)}" target="_blank" rel="noopener">${esc(h.name)}</a>` : esc(h.name);
  const d = distanceKm(h);
  const o = originPoint();
  $('.meta', el).innerHTML = [
    h.stars ? `<span title="${h.stars}-star">${'★'.repeat(h.stars)}</span>` : '',
    h.rating ? `<b>${h.rating}</b>/5${h.reviewCount ? ` (${h.reviewCount.toLocaleString()} reviews)` : ''}` : '',
    d != null ? `📍 ${formatDistance(d, $('#unit').value)} from ${esc(state.origin ? state.origin.name : 'centre')}` : (o ? '<span title="This site didn\'t give a location">📍 distance unknown</span>' : ''),
  ].filter(Boolean).join(' · ');

  renderPrice(el, h);
  renderPerks(el, h);
  renderBadges(el, h);
  renderForecast($('.forecast', el), h.forecast);

  const btnPrices = $('.act-prices', el);
  btnPrices.addEventListener('click', () => togglePrices(el, h, btnPrices));
  const btnHeat = $('.act-heat', el);
  if (h.features.amenitiesKnown && !h.features.pool && !h.features.hotTub) btnHeat.hidden = true;
  btnHeat.addEventListener('click', () => toggleHeat(el, h, btnHeat));
  if (state.heat.has(h.key)) renderHeat(el, h, state.heat.get(h.key));
  const btnWatch = $('.act-watch', el);
  if (state.watched.has(h.key)) btnWatch.textContent = '★ Watching';
  btnWatch.addEventListener('click', () => watch(h, btnWatch));
  return el;
}

function renderPrice(el, h) {
  $('.nightly', el).innerHTML = `${money(h.best.nightly)} <small>/ night</small>`;
  $('.total', el).innerHTML = `${money(h.best.total)} <small>total · ${h.nights} night${h.nights > 1 ? 's' : ''}</small>`;
  const tax = h.best.taxIncluded === false ? ' · + tax' : '';
  $('.where', el).textContent = `cheapest on ${h.best.source}${tax} · ${h.offers.length} site${h.offers.length > 1 ? 's' : ''}`;
}

function renderPerks(el, h) {
  const p = perks(h);
  el.classList.toggle('match-full', p.level === 2);
  el.classList.toggle('match-some', p.level === 1);
  const ribbon = $('.ribbon', el);
  ribbon.hidden = !p.level;
  if (p.level === 2) ribbon.textContent = `✓ Has ${p.has.join(' + ')}`;
  else if (p.level === 1) ribbon.textContent = `Has ${p.has.join(' + ')} · no ${p.missing.join(' / ')} listed`;
}

function renderBadges(el, h) {
  const f = h.features;
  const heat = state.heat.get(h.key);
  const b = [];
  if (f.indoorPool) b.push(['🏊 Indoor pool', 'perk']);
  if (f.outdoorPool) b.push(['🏊 Outdoor pool', 'perk']);
  if (f.pool && !f.indoorPool && !f.outdoorPool) b.push(['🏊 Pool', 'perk']);
  if (f.hotTub) b.push(['♨️ Hot tub', 'perk']);
  if (f.heatedPoolListed) b.push(['🔥 Heated pool (listed)', 'good']);
  if (heat) {
    const cls = { warm: 'good', cold: 'bad', mixed: 'warn' };
    if (heat.pool.status !== 'unknown') b.push([`Pool: ${heat.pool.label}`, cls[heat.pool.status]]);
    if (heat.hotTub.status !== 'unknown') b.push([`Hot tub: ${heat.hotTub.label}`, cls[heat.hotTub.status]]);
  }
  if (h.best.freeCancellation) b.push(['Free cancellation', 'good']);
  if (!f.amenitiesKnown) b.push(['Amenities not listed — check “Compare all sites”', '']);
  for (const s of h.sources) b.push([s, 'src']);
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
    Estimates are statistical guesses, not guarantees. "Up to" is the 90th-percentile scenario.</details>`;
}

// ---------- per-site prices ----------
const taxLabel = (o) => (o.taxIncluded === true ? 'incl. tax' : o.taxIncluded === false ? '+ tax' : 'tax may apply');

async function togglePrices(el, h, btn) {
  const panel = $('.panel-prices', el);
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<p class="muted">Checking every site\'s price…</p>';
  btn.disabled = true;
  try {
    const d = await api('/api/hotel/prices', { stay: state.stay, hotel: h });
    Object.assign(h, { best: d.best, offers: d.offers, forecast: d.forecast });
    renderPrice(el, h);
    renderForecast($('.forecast', el), d.forecast);
    panel.innerHTML = `<div class="table-scroll"><table>
      <thead><tr><th>Site</th><th class="num">Per night</th><th class="num">Total</th><th class="col-tax">Taxes</th><th></th></tr></thead>
      <tbody>${d.offers.map((o, i) => `<tr class="${i === 0 ? 'best' : ''}">
        <td>${esc(o.source)}${o.via ? ` <span class="muted">via ${esc(o.via)}</span>` : ''}${o.freeCancellation ? ' <span class="badge good">free cancel</span>' : ''}</td>
        <td class="num">${money(o.nightly)}</td>
        <td class="num">${money(o.total)}<div class="tax-inline muted">${taxLabel(o)}</div></td>
        <td class="muted col-tax">${taxLabel(o)}</td>
        <td>${o.link ? `<a href="${esc(o.link)}" target="_blank" rel="noopener">Book →</a>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>
      <p class="muted small-text">Sites show taxes differently, so compare the “Taxes” column too.${d.errors?.length ? ` Some sites didn't answer: ${esc(d.errors.join('; '))}` : ''}</p>`;
  } catch (err) {
    panel.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- pool heat ----------
async function fetchHeat(h) {
  if (state.heat.has(h.key)) return state.heat.get(h.key);
  const d = await api('/api/hotel/heat', { stay: state.stay, hotel: h });
  state.heat.set(h.key, d);
  return d;
}

async function toggleHeat(el, h, btn) {
  const panel = $('.panel-heat', el);
  if (!panel.hidden && state.heat.has(h.key)) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<p class="muted">Reading guest reviews for water-temperature mentions…</p>';
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
  const counts = v.warm + v.cold
    ? `${v.warm} warm vs ${v.cold} cold mention${v.warm + v.cold > 1 ? 's' : ''} · confidence ${v.confidence}`
    : `${v.mentions} review${v.mentions === 1 ? '' : 's'} mention it, none mention temperature`;
  return `<div><h4>${title}: ${esc(v.label)}</h4><div class="muted">${counts}</div>${quotes}</div>`;
}

function renderHeat(el, h, d) {
  const panel = $('.panel-heat', el);
  panel.hidden = false;
  panel.innerHTML = `<div class="heat-grid">${heatBlock('🏊 Pool', d.pool)}${heatBlock('♨️ Hot tub', d.hotTub)}</div>
    ${d.bookingAnswer ? `<div class="answer"><b>Booking.com's answer:</b> ${esc(d.bookingAnswer)}</div>` : ''}
    ${d.summary ? `<div class="answer"><b>Tripadvisor review summary:</b> ${esc(d.summary)}</div>` : ''}
    <p class="muted small-text">Based on ${d.reviewsAnalyzed} recent reviews${d.pool.listedHeated ? ' and the listing saying “heated pool”' : ''}. Outdoor pools are often only heated in some seasons, so check the review dates.</p>`;
  renderBadges(el, h);
  renderPerks(el, h);
}

$('#bulk-heat').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const targets = filtered().filter((h) => (h.features.pool || h.features.hotTub) && !state.heat.has(h.key)).slice(0, 10);
  if (!targets.length) return;
  btn.disabled = true;
  let done = 0;
  btn.textContent = `Checking 0/${targets.length}…`;
  // Two at a time to stay gentle on the review sites.
  const queue = [...targets];
  const worker = async () => {
    for (let h; (h = queue.shift());) {
      try { await fetchHeat(h); } catch { /* shown per hotel on demand */ }
      btn.textContent = `Checking ${++done}/${targets.length}…`;
    }
  };
  await Promise.all([worker(), worker()]);
  btn.disabled = false;
  btn.textContent = 'Check pool heat for top 10';
  render();
});

// ---------- watchlist ----------
async function watch(h, btn) {
  try {
    await api('/api/watches', { stay: state.stay, hotel: h });
    state.watched.add(h.key);
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
    state.watched = new Set(rows.map((w) => w.key));
    $('#watch-count').textContent = rows.length ? `(${rows.length})` : '';
    if (!rows.length) { root.innerHTML = '<p class="muted empty">Nothing watched yet. Click “☆ Watch price” on a hotel.</p>'; return; }
    root.innerHTML = rows.map((w) => {
      const last = w.history.at(-1);
      const first = w.history[0];
      const change = last && first?.nightly ? ((last.nightly - first.nightly) / first.nightly) * 100 : 0;
      return `<div class="card watch">
        <div><b>${esc(w.name)}</b><div class="muted">${esc(w.checkIn)} → ${esc(w.checkOut)} · ${w.adults} adults</div></div>
        ${sparkline(w.history)}
        <div class="price">${last ? `<div class="nightly">${money(last.nightly)} <small>/ night</small></div><div class="where">${last.total ? `${money(last.total)} total · ` : ''}${last.source ? `${esc(last.source)} · ` : ''}${change ? `${change > 0 ? '+' : ''}${change.toFixed(1)}% since watching` : 'no change yet'}</div>` : '<span class="muted">pending</span>'}</div>
        <button class="secondary" data-del="${w.id}">Remove</button>
      </div>`;
    }).join('');
    root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      await fetch(`/api/watches/${b.dataset.del}`, { method: 'DELETE' });
      loadWatches();
    }));
  } catch (err) {
    root.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

async function refreshWatchCount() {
  try {
    const rows = await api('/api/watches');
    state.watched = new Set(rows.map((w) => w.key));
    $('#watch-count').textContent = rows.length ? `(${rows.length})` : '';
  } catch { /* ignore */ }
}
refreshWatchCount();
