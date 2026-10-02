// Estimates where a hotel price is likely to go if you wait instead of booking.
//
// Combines (a) a prior built from typical hotel revenue-management behaviour
// (rates drift up as check-in approaches, faster in the final weeks, and
// weekend/holiday stays are more volatile) with (b) the actual price history
// this app has recorded for the same stay. The more history, the more weight it gets.

const DAY = 86_400_000;

function daysUntil(checkIn, now) {
  return Math.max(0, Math.round((new Date(`${checkIn}T00:00:00Z`) - now) / DAY));
}

// Expected daily drift (fraction) for a given lead time.
function priorDrift(lead) {
  if (lead > 90) return 0.0003;
  if (lead > 60) return 0.0006;
  if (lead > 21) return 0.0015;
  if (lead > 7) return 0.004;
  return 0.007;
}

// Daily volatility (fraction).
function priorVol(lead, weekendShare, peak) {
  let v = lead > 60 ? 0.012 : lead > 21 ? 0.016 : lead > 7 ? 0.022 : 0.03;
  v *= 1 + 0.35 * weekendShare;
  if (peak) v *= 1.25;
  return v;
}

function stayStats(checkIn, nights) {
  let weekend = 0;
  let peak = false;
  const start = new Date(`${checkIn}T00:00:00Z`);
  for (let i = 0; i < nights; i++) {
    const d = new Date(start.getTime() + i * DAY);
    if (d.getUTCDay() === 5 || d.getUTCDay() === 6) weekend++;
    const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    // Rough US peak windows: summer, Thanksgiving week, Christmas–New Year, spring break, July 4th.
    if ((md >= 615 && md <= 820) || (md >= 1120 && md <= 1130) || md >= 1218 || md <= 103 || (md >= 310 && md <= 331)) peak = true;
  }
  return { weekendShare: weekend / nights, peak };
}

// Least-squares slope of log(price) per day, plus residual daily volatility.
function fitHistory(history) {
  const pts = history.filter((h) => h.nightly > 0).map((h) => ({ x: h.observedAt / DAY, y: Math.log(h.nightly) }));
  if (pts.length < 2) return null;
  const span = pts.at(-1).x - pts[0].x;
  if (span < 0.5) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const slope = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx;
  const steps = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].x - pts[i - 1].x;
    if (dt > 0.1) steps.push((pts[i].y - pts[i - 1].y) / Math.sqrt(dt));
  }
  const vol = steps.length
    ? Math.sqrt(steps.reduce((s, v) => s + v * v, 0) / steps.length)
    : null;
  return { slope, vol, n: pts.length, spanDays: span };
}

const Z90 = 1.2816;

export function forecastPrice({ nightly, checkIn, nights, history = [], offers = [], now = Date.now() }) {
  if (!nightly) return null;
  const lead = daysUntil(checkIn, now);
  const { weekendShare, peak } = stayStats(checkIn, nights);
  let drift = priorDrift(lead);
  let vol = priorVol(lead, weekendShare, peak);
  const reasons = [];

  if (lead <= 7) reasons.push('Check-in is within a week, when rates usually move fastest');
  else if (lead <= 21) reasons.push('Within 3 weeks of check-in, when rates typically start climbing');
  else if (lead > 60) reasons.push('Far from check-in; rates are usually fairly stable');
  if (weekendShare >= 0.5) reasons.push('Weekend-heavy stay (more price swings)');
  if (peak) reasons.push('Peak travel period');

  const fit = fitHistory(history);
  if (fit) {
    // Weight observed behaviour by how much of it we have (caps at 80%).
    const w = Math.min(0.8, (fit.n - 1) / 10 + fit.spanDays / 30);
    drift = (1 - w) * drift + w * fit.slope;
    if (fit.vol != null) vol = (1 - w) * vol + w * Math.max(0.005, fit.vol);
    const dir = fit.slope > 0.002 ? 'rising' : fit.slope < -0.002 ? 'falling' : 'flat';
    reasons.push(`Tracked ${fit.n} prices over ${fit.spanDays.toFixed(1)} days: trend ${dir}`);
  } else {
    reasons.push('Not enough tracked history yet; using typical market behaviour (add to Watchlist to improve)');
  }

  // Cheap offers on few sites and a wide spread suggest limited inventory.
  if (offers.length >= 3) {
    const prices = offers.map((o) => o.nightly).sort((a, b) => a - b);
    const spread = (prices.at(-1) - prices[0]) / prices[0];
    if (spread > 0.25) {
      vol *= 1.1;
      reasons.push(`Prices vary ${Math.round(spread * 100)}% between sites`);
    }
  }

  const project = (days) => {
    const h = Math.min(days, lead);
    const mean = nightly * Math.exp(drift * h);
    const high = mean * Math.exp(Z90 * vol * Math.sqrt(Math.max(h, 0.0001)));
    const low = mean * Math.exp(-Z90 * vol * Math.sqrt(Math.max(h, 0.0001)));
    return { days: h, expected: round(mean), high: round(high), low: round(low), expectedTotal: round(mean * nights), highTotal: round(high * nights) };
  };

  const tomorrow = project(1);
  const week = project(7);
  const atCheckIn = project(lead);
  const pUp = probUp(drift, vol, Math.min(7, lead));

  let advice;
  if (lead <= 1) advice = 'Book now — check-in is imminent.';
  else if (pUp >= 0.6 || week.expected > nightly * 1.03) advice = 'Book soon — prices are more likely to rise than fall.';
  else if (pUp <= 0.4) advice = 'Can wait — prices look more likely to drop or hold.';
  else advice = 'Toss-up — book a free-cancellation rate now and keep watching.';

  return {
    leadDays: lead,
    current: round(nightly),
    tomorrow,
    week,
    atCheckIn,
    chanceUpInAWeek: Math.round(pUp * 100),
    advice,
    confidence: fit && fit.n >= 6 ? 'medium' : 'low',
    reasons,
  };
}

function probUp(drift, vol, days) {
  if (days <= 0) return 0.5;
  const z = (drift * days) / (vol * Math.sqrt(days));
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x) {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

const round = (n) => Math.round(n * 100) / 100;
