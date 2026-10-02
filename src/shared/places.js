// Instant place suggestions from the bundled US places list (browser + server).
import { US_PLACES } from './usPlaces.js';

let index = null;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function load() {
  if (index) return index;
  index = US_PLACES.split('\n').map((line) => {
    const [name, st, lat, lng, pop] = line.split('|');
    return { name, st, lat: Number(lat), lng: Number(lng), pop: Number(pop), key: norm(name) };
  });
  return index;
}

/**
 * "maple h" -> [{ label: 'Maple Heights, OH', lat, lng }, …]
 * Matches the start of the name or of any word in it; "springfield, il"
 * narrows to a state. Bigger places rank first.
 */
export function suggestPlaces(query, { limit = 6 } = {}) {
  const raw = String(query || '');
  const [placePart, statePart] = raw.split(',');
  const q = norm(placePart);
  if (q.length < 2) return [];
  const st = (statePart || '').trim().toUpperCase().slice(0, 2);
  const scored = [];
  for (const p of load()) {
    if (st && !p.st.startsWith(st)) continue;
    let score;
    if (p.key === q) score = 3;
    else if (p.key.startsWith(q)) score = 2;
    else if (p.key.includes(` ${q}`)) score = 1;
    else continue;
    scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || b.p.pop - a.p.pop);
  return scored.slice(0, limit).map(({ p }) => ({ label: `${p.name}, ${p.st}`, lat: p.lat, lng: p.lng }));
}
