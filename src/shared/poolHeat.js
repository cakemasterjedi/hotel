// Reads guest reviews and estimates whether the pool is heated and whether the
// hot tub is actually hot, based on what guests say about water temperature.

const FACILITY_RES = {
  hotTub: /\b(hot[\s-]?tubs?|jacuzzis?|whirlpools?|spa tubs?|spa pool)\b/gi,
  pool: /\b(?:swimming[\s-])?pools?\b(?!\s*(?:table|cue|hall))/gi,
};

const NEGATORS = /\b(not|no|never|wasn'?t|isn'?t|weren'?t|aren'?t|didn'?t|doesn'?t|nor|hardly|barely)\b(?:\s+\w+){0,2}\s*$/i;

// [regex, score for pool, score for hot tub, negatable]
const CUES = [
  [/\bunheated\b/gi, -2, -2, false],
  // "wish it was heated" / "would be nice if it were heated" means it isn't
  [/\b(?:wish(?:ed)?|if only|would be (?:nice|great|better) if)\b(?:\s+\w+){0,3}?\s+(?:was|were|had been|is|got)\s+(?:heated|warmer|warm)\b/gi, -2, -1.5, false],
  [/\bheated\b/gi, 2, 1, true],
  [/\bheater\b(?:\s+\w+){0,3}\s+(broken|out|off|not working)/gi, -1.5, -2, false],
  [/\b(nice and warm|toasty|bath[\s-]?water|perfect temp(?:erature)?|great temp(?:erature)?|comfortable temp(?:erature)?|good temp(?:erature)?)\b/gi, 2, 0.5, true],
  [/\bwarm\b/gi, 1.5, 0, true],
  [/\b(could|should) (?:have )?(?:been |be )?warmer\b|\bwish (?:it|they) (?:was|were) warmer\b/gi, -1, -1.5, false],
  [/\b(nice and hot|really hot|very hot|super hot|piping hot|steaming)\b/gi, 0.5, 2, true],
  [/\b(?:was|is|nice|plenty|good and|always) hot\b/gi, 0, 1.5, true],
  [/\b(lukewarm|tepid)\b/gi, 0.3, -1.5, false],
  [/\b(ice[\s-]?cold|freezing|frigid|icy|arctic)\b/gi, -2, -2, true],
  [/\btoo cold\b/gi, -2, -2, false],
  [/\b(cold|chilly)\b/gi, -1.5, -1.5, true],
  [/\btoo cool\b/gi, -1, -1.5, false],
];

const TEMP_RE = /(\d{2,3}(?:\.\d)?)\s*(°|º|degrees?|deg\b)?\s*([fc])?\b/gi;

function tempScore(value, unit, facility) {
  let f = value;
  if (unit === 'c' || (!unit && value < 45)) f = value * 9 / 5 + 32;
  if (f < 50 || f > 110) return 0; // probably not a water temperature
  if (facility === 'pool') {
    if (f >= 80) return 2;
    if (f >= 78) return 1;
    if (f <= 70) return -2;
    if (f <= 74) return -1.5;
    return 0;
  }
  if (f >= 100) return 2;
  if (f >= 97) return 0.5;
  if (f <= 95) return -1.5;
  return 0;
}

function sentences(text) {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function facilityMentions(sentence) {
  const out = [];
  for (const [facility, re] of Object.entries(FACILITY_RES)) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(sentence))) {
      // "spa pool"/"hot tub pool" style phrases are hot tubs, not the main pool
      if (facility === 'pool' && /(hot[\s-]?tub|spa|whirl)\s*$/i.test(sentence.slice(0, m.index))) continue;
      out.push({ facility, index: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

function nearestFacility(mentions, index) {
  let best = null;
  let bestDist = Infinity;
  for (const m of mentions) {
    const dist = index < m.index ? m.index - index : Math.max(0, index - m.end);
    if (dist < bestDist) { best = m; bestDist = dist; }
  }
  return best?.facility || null;
}

// Scores a single sentence; returns { pool: n, hotTub: n } with only facilities mentioned.
export function scoreSentence(sentence) {
  const mentions = facilityMentions(sentence);
  if (!mentions.length) return {};
  const scores = {};
  const claimed = [];
  const overlaps = (s, e) => claimed.some(([a, b]) => s < b && e > a);

  for (const [re, poolScore, tubScore, negatable] of CUES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(sentence))) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      claimed.push([start, end]);
      const facility = nearestFacility(mentions, start);
      let s = facility === 'pool' ? poolScore : tubScore;
      if (negatable && NEGATORS.test(sentence.slice(Math.max(0, start - 30), start))) s = -s;
      if (s) scores[facility] = (scores[facility] || 0) + s;
    }
  }

  TEMP_RE.lastIndex = 0;
  let t;
  while ((t = TEMP_RE.exec(sentence))) {
    if (!t[2] && !t[3]) continue; // bare numbers are too ambiguous
    const facility = nearestFacility(mentions, t.index);
    const s = tempScore(Number(t[1]), t[3]?.toLowerCase(), facility);
    if (s) scores[facility] = (scores[facility] || 0) + s;
  }

  for (const m of mentions) if (!(m.facility in scores)) scores[m.facility] = 0;
  return scores;
}

function verdictFor(facility, warm, cold, mentions) {
  const n = warm + cold;
  const labels = facility === 'pool'
    ? { warm: 'Likely heated', cold: 'Likely unheated / cold', mixed: 'Mixed reports', none: 'No temperature info' }
    : { warm: 'Reported hot', cold: 'Reported lukewarm / cold', mixed: 'Mixed reports', none: 'No temperature info' };
  if (!n) return { status: 'unknown', label: mentions ? labels.none : 'Not mentioned in reviews', confidence: 'none', warm, cold, mentions };
  const ratio = warm / n;
  const status = ratio >= 0.7 ? 'warm' : ratio <= 0.3 ? 'cold' : 'mixed';
  const extreme = ratio >= 0.85 || ratio <= 0.15;
  const confidence = n >= 5 && extreme ? 'high' : n >= 3 ? 'medium' : 'low';
  return { status, label: labels[status], confidence, warm, cold, mentions };
}

export function analyzeReviews(reviews, { heatedPoolListed = false } = {}) {
  const tally = { pool: { warm: 0, cold: 0, mentions: 0 }, hotTub: { warm: 0, cold: 0, mentions: 0 } };
  const evidence = { pool: [], hotTub: [] };

  for (const review of reviews) {
    const perReview = {};
    const best = {};
    for (const sentence of sentences(review.text || '')) {
      for (const [facility, score] of Object.entries(scoreSentence(sentence))) {
        perReview[facility] = (perReview[facility] || 0) + score;
        if (score && (!best[facility] || Math.abs(score) > Math.abs(best[facility].score))) {
          best[facility] = { quote: sentence, score };
        }
      }
    }
    // Each review casts at most one vote per facility.
    for (const [facility, total] of Object.entries(perReview)) {
      tally[facility].mentions++;
      if (total > 0) tally[facility].warm++;
      else if (total < 0) tally[facility].cold++;
      if (total && best[facility]) {
        evidence[facility].push({
          quote: best[facility].quote.slice(0, 280),
          sentiment: total > 0 ? 'warm' : 'cold',
          strength: Math.abs(total),
          date: review.date || null,
          rating: review.rating ?? null,
        });
      }
    }
  }

  if (heatedPoolListed) tally.pool.warm += 1; // the listing itself claims a heated pool

  const result = {};
  for (const facility of ['pool', 'hotTub']) {
    const t = tally[facility];
    result[facility] = {
      ...verdictFor(facility, t.warm, t.cold, t.mentions),
      evidence: evidence[facility]
        .sort((a, b) => b.strength - a.strength)
        .filter((e, i, all) => all.findIndex((o) => o.quote === e.quote) === i)
        .slice(0, 5),
    };
  }
  result.pool.listedHeated = heatedPoolListed;
  result.reviewsAnalyzed = reviews.length;
  return result;
}
