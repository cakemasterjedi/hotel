import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { db, cacheGet, cacheSet, recordSnapshot, getHistory } from './db.js';
import { searchAll, searchNear, hotelPrices, hotelHeatSources, hotelPhotos, activeSources } from './search.js';
import { geocode, geocodeHotel, reverseGeocode, locateIp, suggestAddresses } from './geocode.js';
import { suggestPlaces } from './shared/places.js';
import { KM_PER_MI } from './shared/geo.js';
import { analyzeReviews } from './shared/poolHeat.js';
import { forecastPrice } from './shared/forecast.js';
import { detectFeatures } from './shared/features.js';

const app = express();
app.use(express.json({ limit: '200kb' }));

// Optional password protection (recommended when hosting on a public domain).
if (config.appPassword) {
  const expected = Buffer.from(`${config.appUser}:${config.appPassword}`);
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const given = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Hotel Hunter"').status(401).send('Authentication required');
  });
}

app.use(express.static(path.resolve('public')));
app.use('/shared', express.static(path.resolve('src/shared')));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function stayParams(q) {
  const checkIn = String(q.checkIn || '');
  const checkOut = String(q.checkOut || '');
  if (!DATE_RE.test(checkIn) || !DATE_RE.test(checkOut)) throw httpError(400, 'Check-in and check-out must be dates (YYYY-MM-DD)');
  if (checkOut <= checkIn) throw httpError(400, 'Check-out must be after check-in');
  const today = new Date().toISOString().slice(0, 10);
  if (checkIn < today) throw httpError(400, 'Check-in is in the past');
  const adults = Math.min(10, Math.max(1, parseInt(q.adults, 10) || 2));
  const children = Math.min(10, Math.max(0, parseInt(q.children, 10) || 0));
  return { checkIn, checkOut, adults, children, currency: config.currency, q: String(q.q || '').trim().slice(0, 200) };
}

// The hotel object the browser sends back for details calls; keep only what we need.
function hotelParam(h) {
  if (!h || typeof h !== 'object' || !h.name || !h.key) throw httpError(400, 'Missing hotel');
  const refs = h.refs && typeof h.refs === 'object' ? h.refs : {};
  return {
    key: String(h.key).slice(0, 300),
    name: String(h.name).slice(0, 200),
    city: h.city ? String(h.city).slice(0, 100) : null,
    refs: {
      tripadvisorId: refs.tripadvisorId ? Number(refs.tripadvisorId) : undefined,
      bookingId: refs.bookingId ? Number(refs.bookingId) : undefined,
      serpToken: refs.serpToken ? String(refs.serpToken).slice(0, 300) : undefined,
      superName: refs.superName ? String(refs.superName).slice(0, 200) : undefined,
    },
    offers: Array.isArray(h.offers) ? h.offers.slice(0, 50) : [],
    images: (Array.isArray(h.images) ? h.images : []).filter((u) => typeof u === 'string' && /^https:\/\//.test(u)).slice(0, 5),
    features: h.features || {},
    nights: Number(h.nights) || 1,
  };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (!err.status) console.error(err);
  res.status(err.status || 502).json({ error: err.message });
});

function withForecast(hotel, stay) {
  const history = getHistory({ hotelKey: hotel.key, ...stay });
  return { ...hotel, forecast: forecastPrice({ nightly: hotel.best?.nightly, checkIn: stay.checkIn, nights: hotel.nights, history, offers: hotel.offers }), historyCount: history.length };
}

function snapshot(hotel, stay) {
  recordSnapshot({ hotelKey: hotel.key, checkIn: stay.checkIn, checkOut: stay.checkOut, adults: stay.adults, nightly: hotel.best?.nightly, total: hotel.best?.total, source: hotel.best?.source });
}

app.get('/api/status', (req, res) => {
  res.json({ demo: config.demo, sources: activeSources(), currency: config.currency, watchIntervalHours: config.watchIntervalHours });
});

app.get('/api/geocode', wrap(async (req, res) => {
  const hit = await geocode(req.query.q);
  if (!hit) throw httpError(404, `Couldn't find "${req.query.q}". Try adding the state, e.g. "Mesa, AZ".`);
  res.json(hit);
}));

// Fills in coordinates for hotels whose listing had none (cached for good).
app.post('/api/coords', wrap(async (req, res) => {
  const center = req.body.center?.lat != null ? { lat: Number(req.body.center.lat), lng: Number(req.body.center.lng) } : null;
  const list = (Array.isArray(req.body.hotels) ? req.body.hotels : []).slice(0, 40)
    .filter((h) => h?.key && h?.name).map((h) => ({ key: String(h.key).slice(0, 300), name: String(h.name).slice(0, 200) }));
  const out = {};
  const queue = [...list];
  const worker = async () => {
    for (let h; (h = queue.shift());) {
      const ck = `coords:${h.key}`;
      let hit = cacheGet(ck);
      if (hit === null && !config.demo) {
        try { hit = (await geocodeHotel(h.name, center)) || { none: true }; } catch { continue; }
        cacheSet(ck, hit, 180 * 86_400_000);
      }
      if (hit && !hit.none) out[h.key] = hit;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  res.json(out);
}));

// Location autofill: bundled US towns instantly, plus street addresses and
// landmarks from OpenStreetMap when the text looks like more than a town.
app.get('/api/suggest', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const local = suggestPlaces(q, { limit: 6 });
  let remote = [];
  if (q.length >= 4 && !config.demo && (local.length < 3 || /\d/.test(q))) {
    const key = `suggest:${q.toLowerCase()}`;
    remote = cacheGet(key);
    if (!remote) {
      remote = await suggestAddresses(q).catch(() => null);
      if (remote) cacheSet(key, remote, 30 * 86_400_000); // never cache a failed lookup
    }
    remote ||= [];
  }
  const seen = new Set(local.map((s) => s.label.toLowerCase()));
  res.json([...local, ...remote.filter((r) => !seen.has(r.label.toLowerCase()) && seen.add(r.label.toLowerCase()))].slice(0, 8));
}));

app.post('/api/hotel/photos', wrap(async (req, res) => {
  const stay = stayParams(req.body.stay || {});
  const hotel = hotelParam(req.body.hotel);
  const key = `photos:${config.demo}:${hotel.key}`;
  let photos = cacheGet(key);
  if (!photos) {
    photos = await hotelPhotos(stay, hotel);
    if (photos.length) cacheSet(key, photos, 7 * 86_400_000);
  }
  res.json({ photos });
}));

// Where is the user? Approximate, from their internet connection (used when
// the browser can't share GPS, e.g. on plain http).
app.get('/api/whereami', wrap(async (req, res) => {
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const hit = await locateIp(ip).catch(() => null);
  if (!hit) throw httpError(502, "Couldn't work out your location. Type a city instead.");
  res.json(hit);
}));

app.get('/api/reverse', wrap(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw httpError(400, 'lat and lng are required');
  res.json({ name: (await reverseGeocode(lat, lng).catch(() => null)) || `${lat.toFixed(3)}, ${lng.toFixed(3)}` });
}));

function nearParams(q) {
  const lat = Number(q.nearLat);
  const lng = Number(q.nearLng);
  if (!q.nearLat || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const radiusMi = Math.min(100, Math.max(1, Number(q.radiusMi) || 15));
  // Rounded so nearby repeat searches share the cache.
  return { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100, radiusKm: radiusMi * KM_PER_MI, label: String(q.nearName || '').slice(0, 100) };
}

app.get('/api/search', wrap(async (req, res) => {
  const near = nearParams(req.query);
  const stay = stayParams(near ? { ...req.query, q: req.query.q || near.label || 'near me' } : req.query);
  if (!stay.q) throw httpError(400, 'Enter a destination');
  const key = `search:${config.demo}:${JSON.stringify(stay)}:${JSON.stringify(near)}`;
  let result = cacheGet(key);
  const cached = !!result;
  if (!result) {
    if (near && !near.label) near.label = (await reverseGeocode(near.lat, near.lng).catch(() => null)) || stay.q;
    result = near
      ? await searchNear(stay, { point: near, radiusKm: near.radiusKm, label: near.label })
      : await searchAll(stay);
    if (result.hotels.length) cacheSet(key, result, config.searchCacheHours * 3600_000);
    for (const h of result.hotels) snapshot(h, stay);
  }
  res.json({ ...result, cached, demo: config.demo, currency: stay.currency, hotels: result.hotels.map((h) => withForecast(h, stay)) });
}));

app.post('/api/hotel/prices', wrap(async (req, res) => {
  const stay = stayParams(req.body.stay || {});
  const hotel = hotelParam(req.body.hotel);
  const key = `prices:${config.demo}:${hotel.key}:${JSON.stringify(stay)}`;
  let result = cacheGet(key);
  if (!result) {
    result = await hotelPrices(stay, hotel);
    cacheSet(key, result, config.searchCacheHours * 3600_000);
    snapshot(result.hotel, stay);
  }
  res.json({ ...withForecast(result.hotel, stay), errors: result.errors });
}));

app.post('/api/hotel/heat', wrap(async (req, res) => {
  const stay = stayParams(req.body.stay || {});
  const hotel = hotelParam(req.body.hotel);
  const key = `heat:${config.demo}:${hotel.key}`;
  let src = cacheGet(key);
  if (!src) {
    src = await hotelHeatSources(stay, hotel);
    if (src.reviews.length || src.bookingAnswer) cacheSet(key, src, config.reviewCacheDays * 86_400_000);
  }
  const listed = hotel.features.heatedPoolListed || detectFeatures(src.amenities).heatedPoolListed;
  const extra = src.bookingAnswer ? [{ text: src.bookingAnswer, source: 'Booking.com answer', date: null }] : [];
  const analysis = analyzeReviews([...src.reviews, ...extra], { heatedPoolListed: listed });
  const summary = src.summary && /pool|hot tub|jacuzzi|spa/i.test(src.summary) ? src.summary : null;
  res.json({ ...analysis, bookingAnswer: src.bookingAnswer, summary, errors: src.errors });
}));

// Watchlist: re-checks prices on a schedule to build history for better forecasts.
app.get('/api/watches', (req, res) => {
  const rows = db.prepare('SELECT * FROM watchlist ORDER BY check_in').all();
  res.json(rows.map((w) => ({
    id: w.id, key: w.hotel_key, name: w.name, checkIn: w.check_in, checkOut: w.check_out, adults: w.adults,
    lastCheckedAt: w.last_checked_at,
    history: getHistory({ hotelKey: w.hotel_key, checkIn: w.check_in, checkOut: w.check_out, adults: w.adults }),
  })));
});

app.post('/api/watches', wrap(async (req, res) => {
  const stay = stayParams(req.body.stay || {});
  const hotel = hotelParam(req.body.hotel);
  db.prepare(`INSERT OR IGNORE INTO watchlist (hotel_key, name, hotel_json, query, check_in, check_out, adults, children, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hotel.key, hotel.name, JSON.stringify({ ...hotel, offers: [] }), stay.q, stay.checkIn, stay.checkOut, stay.adults, stay.children, Date.now());
  res.status(201).json({ ok: true });
}));

app.delete('/api/watches/:id', (req, res) => {
  db.prepare('DELETE FROM watchlist WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

async function refreshWatches() {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare('DELETE FROM watchlist WHERE check_in < ?').run(today);
  const due = Date.now() - config.watchIntervalHours * 3600_000;
  const rows = db.prepare('SELECT * FROM watchlist WHERE last_checked_at IS NULL OR last_checked_at < ?').all(due);
  for (const w of rows) {
    const stay = { q: w.query || w.name, checkIn: w.check_in, checkOut: w.check_out, adults: w.adults, children: w.children, currency: config.currency };
    try {
      const { hotel } = await hotelPrices(stay, JSON.parse(w.hotel_json));
      if (hotel.best) snapshot(hotel, stay);
      db.prepare('UPDATE watchlist SET last_checked_at = ? WHERE id = ?').run(Date.now(), w.id);
    } catch (err) {
      console.error(`Watch refresh failed for ${w.name}:`, err.message);
    }
  }
}

if (process.env.NODE_ENV !== 'test') {
  setInterval(() => refreshWatches().catch(console.error), 30 * 60_000).unref();
  refreshWatches().catch(console.error);
  app.listen(config.port, () => {
    console.log(`Hotel Hunter on http://localhost:${config.port} — sources: ${activeSources().join(', ')}${config.demo ? ' (DEMO DATA)' : ''}`);
  });
}

export { app };
