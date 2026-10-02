// Finds weekend (Fri + Sat night) hotel prices that are well below usual.
//
// "Usual" for a hotel = the median of every other weekend price seen for it:
// the other weekends in this scan plus earlier scans kept in the history file.
// A price at least `threshold` (default 15%) under that median is a deal.
// It also flags when the cheapest pool / hot-tub hotel for a weekend hits a
// new low. Deals already reported aren't repeated unless the price drops further.

const DAY = 86_400_000;
const iso = (d) => d.toISOString().slice(0, 10);

export function upcomingWeekends(today, count = 4) {
  const d = new Date(`${today}T00:00:00Z`);
  const out = [];
  // Next Friday strictly after today, so the stay is never same-day.
  d.setUTCDate(d.getUTCDate() + (((5 - d.getUTCDay() + 7) % 7) || 7));
  for (let i = 0; i < count; i++) {
    const fri = new Date(d.getTime() + i * 7 * DAY);
    out.push({ checkIn: iso(fri), checkOut: iso(new Date(fri.getTime() + 2 * DAY)) });
  }
  return out;
}

export function emptyHistory() {
  return { version: 1, obs: {}, lows: {}, alerted: {}, coords: {} };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const hasPerk = (h) => h.features?.pool || h.features?.hotTub;

/**
 * @param scans   [{ checkIn, checkOut, hotels: [hotel with key, name, best, features, distanceMi] }]
 * @param history mutable history object (see emptyHistory)
 * @returns deals, sorted pool/hot-tub first then biggest discount
 */
export function findDeals(scans, history, { now = Date.now(), threshold = 0.15, minSamples = 3, keepDays = 90 } = {}) {
  const h = history;
  // Prices from earlier runs, per hotel, excluding the weekends scanned now (those use fresh prices).
  const scanned = new Set(scans.map((s) => s.checkIn));
  const pastPrices = (key) => (h.obs[key] || []).filter(([w]) => !scanned.has(w)).map(([, p]) => p);

  const current = {}; // key -> { weekend -> nightly }
  for (const s of scans) for (const hotel of s.hotels) if (hotel.best) (current[hotel.key] ||= {})[s.checkIn] = hotel.best.nightly;

  const deals = [];
  for (const s of scans) {
    // Rule 1: well below this hotel's usual weekend price.
    for (const hotel of s.hotels) {
      if (!hotel.best) continue;
      const price = hotel.best.nightly;
      const others = [
        ...Object.entries(current[hotel.key] || {}).filter(([w]) => w !== s.checkIn).map(([, p]) => p),
        ...pastPrices(hotel.key),
      ];
      if (others.length < minSamples) continue;
      const usual = median(others);
      const below = 1 - price / usual;
      if (below >= threshold) deals.push(deal(s, hotel, { usual, below, reason: 'below-usual' }));
    }
    // Rule 2: cheapest pool / hot-tub hotel for this weekend hits a new low.
    const perkHotels = s.hotels.filter((x) => x.best && hasPerk(x)).sort((a, b) => a.best.nightly - b.best.nightly);
    const cheapest = perkHotels[0];
    const prevLow = h.lows[s.checkIn];
    if (cheapest) {
      if (prevLow && cheapest.best.nightly <= prevLow * 0.95 && !deals.some((d) => d.key === cheapest.key && d.checkIn === s.checkIn)) {
        deals.push(deal(s, cheapest, { usual: prevLow, below: 1 - cheapest.best.nightly / prevLow, reason: 'new-low' }));
      }
      h.lows[s.checkIn] = Math.min(prevLow || Infinity, cheapest.best.nightly);
    }
  }

  // Skip deals already reported at the same (or a lower) price.
  const fresh = deals.filter((d) => {
    const k = `${d.key}|${d.checkIn}`;
    const prev = h.alerted[k];
    if (prev && d.nightly > prev * 0.95) return false;
    h.alerted[k] = d.nightly;
    return true;
  });

  // Record this run's prices, then prune old data and past weekends.
  for (const s of scans) {
    for (const hotel of s.hotels) {
      if (!hotel.best) continue;
      const list = (h.obs[hotel.key] ||= []).filter(([w]) => w !== s.checkIn);
      list.push([s.checkIn, hotel.best.nightly, now]);
      h.obs[hotel.key] = list;
    }
  }
  const cutoff = now - keepDays * DAY;
  const today = iso(new Date(now));
  for (const [k, list] of Object.entries(h.obs)) {
    const kept = list.filter(([, , t]) => t >= cutoff);
    if (kept.length) h.obs[k] = kept;
    else delete h.obs[k];
  }
  for (const w of Object.keys(h.lows)) if (w < today) delete h.lows[w];
  for (const k of Object.keys(h.alerted)) if (k.split('|')[1] < today) delete h.alerted[k];

  fresh.sort((a, b) => (b.perk - a.perk) || (b.below - a.below));
  fresh.weekends = weekendLevels(scans, current);
  return fresh;
}

// How each weekend compares with the others overall: the median, across hotels
// priced on several weekends, of (this weekend's price ÷ that hotel's other weekends).
function weekendLevels(scans, current) {
  return scans.map((s) => {
    const ratios = [];
    for (const [, byWeekend] of Object.entries(current)) {
      const price = byWeekend[s.checkIn];
      const others = Object.entries(byWeekend).filter(([w]) => w !== s.checkIn).map(([, p]) => p);
      if (price && others.length >= 2) ratios.push(price / median(others));
    }
    return { checkIn: s.checkIn, checkOut: s.checkOut, level: ratios.length >= 5 ? Math.round(median(ratios) * 1000) / 1000 : null, hotels: s.hotels.length };
  });
}

function deal(scan, hotel, { usual, below, reason }) {
  return {
    key: hotel.key,
    name: hotel.name,
    checkIn: scan.checkIn,
    checkOut: scan.checkOut,
    nightly: hotel.best.nightly,
    total: hotel.best.total,
    source: hotel.best.source,
    taxIncluded: hotel.best.taxIncluded,
    link: [hotel.best.link, hotel.link].find((l) => l && l.length <= 200) || null,
    usual: Math.round(usual * 100) / 100,
    below: Math.round(below * 1000) / 1000,
    reason,
    pool: !!hotel.features?.pool,
    hotTub: !!hotel.features?.hotTub,
    perk: hasPerk(hotel) ? 1 : 0,
    distanceMi: hotel.distanceMi ?? null,
    rating: hotel.rating ?? null,
  };
}

const fmtDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const usd = (n) => `$${Math.round(n)}`;

// Short, phone-friendly summary grouped by weekend.
export function formatDeals(deals, { origin, perWeekend = 3, maxLinks = 4 } = {}) {
  if (!deals.length) return `No new weekend hotel deals near ${origin} right now.`;
  const levels = new Map((deals.weekends || []).map((w) => [w.checkIn, w.level]));
  const groups = new Map();
  for (const d of deals) (groups.get(d.checkIn) || groups.set(d.checkIn, []).get(d.checkIn)).push(d);
  // Weekends with the best deal first.
  const ordered = [...groups.entries()].sort((a, b) => (b[1][0].perk - a[1][0].perk) || (b[1][0].below - a[1][0].below));
  let links = 0;
  const parts = ordered.map(([checkIn, list]) => {
    const level = levels.get(checkIn);
    const cheap = level != null && level <= 0.9 ? ` — whole weekend ~${Math.round((1 - level) * 100)}% cheaper than the others` : '';
    const head = `${fmtDate(checkIn)}–${fmtDate(list[0].checkOut)}${cheap}:`;
    const lines = list.slice(0, perWeekend).map((d) => {
      const perks = [d.pool && 'pool', d.hotTub && 'hot tub'].filter(Boolean).join(' + ');
      const why = d.reason === 'new-low' ? `new low for a pool/hot tub hotel (was ${usd(d.usual)})` : `${Math.round(d.below * 100)}% under its usual ${usd(d.usual)}`;
      const link = d.link && d.link.length <= 200 && links < maxLinks ? (links++, `\n   ${d.link}`) : '';
      return ` • ${d.name}: ${usd(d.nightly)}/night, ${usd(d.total)} total${d.taxIncluded === false ? ' + tax' : ''} (${d.source}), ${why}${perks ? ` · ${perks}` : ''}${d.distanceMi != null ? ` · ${d.distanceMi.toFixed(1)} mi` : ''}${link}`;
    });
    const more = list.length > perWeekend ? `\n   +${list.length - perWeekend} more that weekend` : '';
    return `${head}\n${lines.join('\n')}${more}`;
  });
  return `🏨 ${deals.length} weekend hotel deal${deals.length > 1 ? 's' : ''} near ${origin}\n\n${parts.join('\n\n')}`;
}
