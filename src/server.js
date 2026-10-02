import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { db, cacheGet, cacheSet, recordSnapshot, getHistory } from './db.js';
import * as live from './providers/serpapi.js';
import * as demo from './providers/demo.js';
import { analyzeReviews } from './poolHeat.js';
import { forecastPrice } from './forecast.js';

const provider = config.demo ? demo : live;
const app = express();
app.use(express.json());

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function stayParams(q) {
  const checkIn = String(q.checkIn || '');
  const checkOut = String(q.checkOut || '');
  if (!DATE_RE.test(checkIn) || !DATE_RE.test(checkOut)) throw httpError(400, 'checkIn and checkOut must be YYYY-MM-DD');
  if (checkOut <= checkIn) throw httpError(400, 'checkOut must be after checkIn');
  const today = new Date().toISOString().slice(0, 10);
  if (checkIn < today) throw httpError(400, 'checkIn is in the past');
  const adults = Math.min(10, Math.max(1, parseInt(q.adults, 10) || 2));
  const children = Math.min(10, Math.max(0, parseInt(q.children, 10) || 0));
  const currency = /^[A-Z]{3}$/.test(String(q.currency || '').toUpperCase()) ? String(q.currency).toUpperCase() : 'USD';
  return { checkIn, checkOut, adults, children, currency, q: String(q.q || '').trim().slice(0, 200) };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (!err.status) console.error(err);
  res.status(err.status || 502).json({ error: err.message });
});

function withForecast(hotel, stay) {
  const history = getHistory({ propertyToken: hotel.token, ...stay });
  return { ...hotel, forecast: forecastPrice({ nightly: hotel.best?.nightly, checkIn: stay.checkIn, nights: hotel.nights, history, offers: hotel.offers }), historyCount: history.length };
}

function snapshot(hotel, stay) {
  recordSnapshot({ propertyToken: hotel.token, checkIn: stay.checkIn, checkOut: stay.checkOut, adults: stay.adults, nightly: hotel.best?.nightly, total: hotel.best?.total, currency: stay.currency });
}

app.get('/api/status', (req, res) => {
  res.json({ demo: config.demo, watchIntervalHours: config.watchIntervalHours });
});

app.get('/api/search', wrap(async (req, res) => {
  const stay = stayParams(req.query);
  if (!stay.q) throw httpError(400, 'Enter a destination');
  const key = `search:${JSON.stringify(stay)}`;
  let hotels = cacheGet(key);
  const cached = !!hotels;
  if (!hotels) {
    hotels = await provider.searchHotels(stay);
    cacheSet(key, hotels, config.searchCacheHours * 3600_000);
    for (const h of hotels) snapshot(h, stay);
  }
  res.json({ cached, demo: config.demo, currency: stay.currency, hotels: hotels.map((h) => withForecast(h, stay)) });
}));

app.get('/api/hotel/:token/prices', wrap(async (req, res) => {
  const stay = stayParams(req.query);
  const token = req.params.token;
  const key = `details:${token}:${JSON.stringify(stay)}`;
  let hotel = cacheGet(key);
  if (!hotel) {
    hotel = await provider.hotelDetails({ ...stay, token });
    if (!hotel) throw httpError(404, 'Hotel not found');
    cacheSet(key, hotel, config.searchCacheHours * 3600_000);
    snapshot(hotel, stay);
  }
  res.json(withForecast(hotel, stay));
}));

app.get('/api/hotel/:token/heat', wrap(async (req, res) => {
  const token = req.params.token;
  const key = `reviews:${token}`;
  let reviews = cacheGet(key);
  if (!reviews) {
    reviews = await provider.hotelReviews({ token });
    cacheSet(key, reviews, config.reviewCacheDays * 86_400_000);
  }
  res.json(analyzeReviews(reviews, { heatedPoolListed: req.query.heatedListed === '1' }));
}));

app.get('/api/hotel/:token/history', wrap(async (req, res) => {
  const stay = stayParams(req.query);
  res.json(getHistory({ propertyToken: req.params.token, ...stay }));
}));

// Watchlist: re-checks prices on a schedule to build history for better forecasts.
app.get('/api/watches', (req, res) => {
  const rows = db.prepare('SELECT * FROM watches ORDER BY check_in').all();
  res.json(rows.map((w) => {
    const history = getHistory({ propertyToken: w.property_token, checkIn: w.check_in, checkOut: w.check_out, adults: w.adults });
    return { ...w, history };
  }));
});

app.post('/api/watches', wrap(async (req, res) => {
  const stay = stayParams(req.body);
  const { token, name } = req.body;
  if (!token || !name) throw httpError(400, 'token and name are required');
  db.prepare(`INSERT OR IGNORE INTO watches (property_token, name, query, check_in, check_out, adults, currency, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(token, String(name).slice(0, 200), stay.q, stay.checkIn, stay.checkOut, stay.adults, stay.currency, Date.now());
  res.status(201).json({ ok: true });
}));

app.delete('/api/watches/:id', (req, res) => {
  db.prepare('DELETE FROM watches WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

async function refreshWatches() {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare('DELETE FROM watches WHERE check_in < ?').run(today);
  const due = Date.now() - config.watchIntervalHours * 3600_000;
  const rows = db.prepare('SELECT * FROM watches WHERE last_checked_at IS NULL OR last_checked_at < ?').all(due);
  for (const w of rows) {
    const stay = { q: w.query || w.name, checkIn: w.check_in, checkOut: w.check_out, adults: w.adults, children: 0, currency: w.currency };
    try {
      const hotel = await provider.hotelDetails({ ...stay, token: w.property_token });
      if (hotel) snapshot(hotel, stay);
      db.prepare('UPDATE watches SET last_checked_at = ? WHERE id = ?').run(Date.now(), w.id);
    } catch (err) {
      console.error(`Watch refresh failed for ${w.name}:`, err.message);
    }
  }
}

if (process.env.NODE_ENV !== 'test') {
  setInterval(() => refreshWatches().catch(console.error), 30 * 60_000).unref();
  refreshWatches().catch(console.error);
  app.listen(config.port, () => {
    console.log(`Hotel Hunter listening on http://localhost:${config.port}${config.demo ? ' (DEMO MODE: set SERPAPI_KEY for live prices)' : ''}`);
  });
}

export { app };
