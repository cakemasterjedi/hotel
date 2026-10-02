// Scans the next few weekends for hotel deals near a place and prints a
// short message listing them (or saying there are none).
//
//   node scripts/weekend-deals.js --origin "Maple Heights, OH" \
//     --areas "Maple Heights, OH|Cleveland, OH" --radius 20 --history data/weekend-history.json
//
// The history file is optional; with it, "usual" prices improve over time and
// deals that were already reported aren't repeated.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { searchArea } from '../src/search.js';
import { geocode, geocodeHotel } from '../src/geocode.js';
import { haversineKm, KM_PER_MI } from '../src/shared/geo.js';
import { upcomingWeekends, emptyHistory, findDeals, formatDeals } from '../src/weekendDeals.js';

const { values: opt } = parseArgs({
  options: {
    origin: { type: 'string', default: 'Maple Heights, OH' },
    areas: { type: 'string' },
    radius: { type: 'string', default: '20' },
    weekends: { type: 'string', default: '4' },
    adults: { type: 'string', default: '2' },
    threshold: { type: 'string', default: '0.15' },
    history: { type: 'string' },
    json: { type: 'string' },
  },
});

const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const areas = (opt.areas || opt.origin).split('|').map((s) => s.trim()).filter(Boolean);
const radiusMi = Number(opt.radius);

const history = opt.history && fs.existsSync(opt.history) ? JSON.parse(fs.readFileSync(opt.history, 'utf8')) : emptyHistory();
history.coords ||= {};

const origin = await geocode(opt.origin);
if (!origin) log(`Couldn't locate "${opt.origin}"; distances will be skipped.`);

const today = new Date().toISOString().slice(0, 10);
const scans = [];
let lookups = 0;
for (const w of upcomingWeekends(today, Number(opt.weekends))) {
  const stay = { q: areas[0], checkIn: w.checkIn, checkOut: w.checkOut, adults: Number(opt.adults), children: 0, currency: 'USD' };
  try {
    const near = origin ? { lat: origin.lat, lng: origin.lng, radiusKm: radiusMi * KM_PER_MI } : null;
    const { hotels, status } = await searchArea(stay, { areas, near });
    // Locate hotels whose listing had no coordinates (cached in the history file).
    for (const h of hotels) {
      if (h.lat != null) { history.coords[h.key] = [h.lat, h.lng]; continue; }
      const cached = history.coords[h.key];
      if (cached === undefined && origin && lookups < 80) {
        lookups++;
        const hit = await geocodeHotel([h.name, h.city].filter(Boolean).join(', '), origin).catch(() => null);
        history.coords[h.key] = hit ? [hit.lat, hit.lng] : 0;
      }
      if (history.coords[h.key]) [h.lat, h.lng] = history.coords[h.key];
    }
    const inRange = hotels.filter((h) => {
      h.distanceMi = origin && h.lat != null ? haversineKm(origin, h) / KM_PER_MI : null;
      return h.distanceMi == null || h.distanceMi <= radiusMi;
    });
    scans.push({ ...w, hotels: inRange });
    log(`${w.checkIn}: ${inRange.length} hotels within ${radiusMi} mi (${status.map((s) => `${s.label} ${s.ok ? s.count : 'failed'}`).join(', ')})`);
  } catch (err) {
    log(`${w.checkIn}: search failed: ${err.message}`);
  }
  await sleep(2000); // be gentle on the booking sites
}

if (!scans.length) {
  console.log(`Couldn't check weekend hotel prices near ${opt.origin} today: every search failed.`);
  process.exit(1);
}

const deals = findDeals(scans, history, { threshold: Number(opt.threshold) });
console.log(formatDeals(deals, { origin: opt.origin }));

if (opt.history) {
  fs.mkdirSync(path.dirname(path.resolve(opt.history)), { recursive: true });
  fs.writeFileSync(opt.history, JSON.stringify(history));
}
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ checkedAt: new Date().toISOString(), origin: opt.origin, deals }, null, 1));
log(`Done: ${deals.length} new deal(s), ${lookups} location lookups.`);
