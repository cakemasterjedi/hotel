// Deterministic fake data so the app can be tried without an API key.
import { detectFeatures, nightsBetween, offer } from './normalize.js';

function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const SOURCES = ['Booking.com', 'Expedia', 'Hotels.com', 'Priceline', 'Agoda', 'Trip.com', 'Official site', 'Orbitz', 'Travelocity', 'Hopper'];
const PREFIX = ['Harbor', 'Palm', 'Summit', 'Grand', 'Sunset', 'Riverside', 'Lakeview', 'Cedar', 'Coral', 'Desert Rose', 'Maple', 'Seabreeze', 'Ironwood', 'Willow', 'Bayfront', 'Canyon'];
const SUFFIX = ['Inn', 'Hotel', 'Suites', 'Resort & Spa', 'Lodge', 'Hotel & Conference Center', 'Boutique Hotel', 'Inn & Suites'];
const BASE_AMENITIES = ['Free Wi-Fi', 'Air conditioning', 'Parking', 'Restaurant', 'Fitness center', 'Breakfast', 'Pet-friendly', 'Airport shuttle', 'Bar', 'Kitchen in some rooms'];

const POOL_REVIEWS = {
  heated: [
    'The pool was heated and perfect even in the evening.',
    'Loved the heated pool, the water was nice and warm.',
    'Pool temp was around 84 degrees, kids stayed in for hours.',
    'Great pool — warm water, clean deck chairs.',
  ],
  cold: [
    'The pool was freezing, nobody could get in.',
    'Beautiful pool but it is not heated so way too cold for a swim.',
    'Pool was cold, maybe 70 degrees. Disappointing.',
    'Wish the pool was heated, it was chilly.',
  ],
  tubHot: ['The hot tub was nice and hot after a long day.', 'Jacuzzi was hot and relaxing.'],
  tubCold: ['Hot tub was lukewarm at best.', 'The jacuzzi was cold and out of order half the time.'],
  filler: [
    'Friendly staff and clean rooms.',
    'Location was convenient, close to restaurants.',
    'Bed was comfortable but the walls are thin.',
    'Breakfast was decent, parking was easy.',
    'Check-in took a while but staff were helpful.',
    'Room smelled a bit musty, otherwise fine.',
  ],
};

function buildHotels({ q, checkIn, checkOut, adults, currency }) {
  const nights = nightsBetween(checkIn, checkOut);
  const city = q.replace(/hotels?\s+(in|near)\s+/i, '').trim() || 'Demo City';
  const r = rng(`${city.toLowerCase()}|${checkIn}|${checkOut}|${adults}`);
  const hotels = [];
  for (let i = 0; i < 24; i++) {
    const hr = rng(`${city.toLowerCase()}|hotel|${i}`); // stable per-hotel traits
    const stars = 2 + Math.floor(hr() * 4);
    const name = `${PREFIX[Math.floor(hr() * PREFIX.length)]} ${SUFFIX[Math.floor(hr() * SUFFIX.length)]} ${city}`;
    const amenities = BASE_AMENITIES.filter(() => hr() < 0.55);
    const poolRoll = hr();
    if (poolRoll < 0.3) amenities.push('Indoor pool');
    else if (poolRoll < 0.6) amenities.push('Outdoor pool');
    else if (poolRoll < 0.7) amenities.push('Indoor pool', 'Outdoor pool');
    if (hr() < 0.4) amenities.push('Hot tub');
    if (amenities.some((a) => /pool/i.test(a)) && hr() < 0.15) amenities.push('Heated pool');

    const base = (60 + stars * 38 + hr() * 90) * (1 + (adults - 2) * 0.08);
    const offers = SOURCES.filter(() => r() < 0.65).map((source) => {
      const nightly = base * (0.9 + r() * 0.25);
      return offer({
        source,
        link: `https://example.com/demo/${encodeURIComponent(source)}`,
        nightly,
        nightlyBeforeTax: nightly / 1.14,
        nights,
        freeCancellation: r() < 0.5,
      });
    }).sort((a, b) => a.nightly - b.nightly);
    if (!offers.length) continue;

    hotels.push({
      token: `demo-${city.toLowerCase().replace(/\W+/g, '-')}-${i}`,
      name,
      type: 'hotel',
      link: 'https://example.com/demo',
      description: `A ${stars}-star demo property in ${city}.`,
      image: null,
      hotelClass: stars,
      rating: Math.round((3 + hr() * 2) * 10) / 10,
      reviewCount: Math.floor(50 + hr() * 3000),
      location: null,
      amenities,
      features: detectFeatures(amenities),
      best: offers[0],
      offers,
      nights,
      _currency: currency,
    });
  }
  return hotels;
}

export async function searchHotels(params) {
  return buildHotels(params).map(({ offers, ...h }) => ({ ...h, offers: offers.slice(0, 4) }));
}

export async function hotelDetails(params) {
  return buildHotels(params).find((h) => h.token === params.token) || null;
}

export async function hotelReviews({ token }) {
  const r = rng(`${token}|reviews`);
  const heatedPool = r() < 0.5;
  const hotTub = r() < 0.6;
  const reviews = [];
  for (let i = 0; i < 30; i++) {
    let text = POOL_REVIEWS.filler[Math.floor(r() * POOL_REVIEWS.filler.length)];
    const roll = r();
    if (roll < 0.2) {
      const set = (heatedPool ? r() < 0.85 : r() < 0.15) ? POOL_REVIEWS.heated : POOL_REVIEWS.cold;
      text += ` ${set[Math.floor(r() * set.length)]}`;
    } else if (roll < 0.3) {
      const set = (hotTub ? r() < 0.85 : r() < 0.2) ? POOL_REVIEWS.tubHot : POOL_REVIEWS.tubCold;
      text += ` ${set[Math.floor(r() * set.length)]}`;
    }
    reviews.push({ text, rating: 3 + Math.floor(r() * 3), date: `${1 + Math.floor(r() * 11)} months ago`, source: 'Demo' });
  }
  return reviews;
}
