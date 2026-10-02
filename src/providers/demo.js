// Fake versions of the Super.com / Booking.com / Tripadvisor MCP servers that
// return payloads in the same shape as the real ones, so demo mode runs the
// real parsing and merging code without network access.

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

const CENTER = { lat: 33.4942, lng: -111.9261 }; // demo city centre
const PREFIX = ['Harbor', 'Palm', 'Summit', 'Grand', 'Sunset', 'Riverside', 'Lakeview', 'Cedar', 'Coral', 'Desert Rose', 'Maple', 'Seabreeze', 'Ironwood', 'Willow', 'Bayfront', 'Canyon'];
const SUFFIX = ['Inn', 'Hotel', 'Suites', 'Resort & Spa', 'Lodge', 'Inn & Suites', 'Boutique Hotel'];
const PARTNERS = ['Expedia.com', 'Hotels.com', 'Priceline', 'Agoda', 'Trip.com', 'Official site', 'ZenHotels.com'];
const BASE_AMENITIES = ['Free wifi', 'Air conditioning', 'Free parking', 'Restaurant', 'Fitness center', 'Breakfast available', 'Pet friendly'];

const REVIEW_TEXT = {
  heated: ['The pool was heated and perfect even in the evening.', 'Loved the heated pool, the water was nice and warm.', 'Pool temp was around 84 degrees, kids stayed in for hours.'],
  cold: ['The pool was freezing, nobody could get in.', 'Beautiful pool but it is not heated so way too cold for a swim.', 'Pool was cold, maybe 70 degrees.', 'Wish the pool was heated, it was chilly.'],
  tubHot: ['The hot tub was nice and hot after a long day.', 'Jacuzzi was hot and relaxing.'],
  tubCold: ['Hot tub was lukewarm at best.', 'The jacuzzi was cold and out of order half the time.'],
  filler: ['Friendly staff and clean rooms.', 'Location was convenient, close to restaurants.', 'Bed was comfortable but the walls are thin.', 'Breakfast was decent, parking was easy.'],
};

function hotels(city) {
  const list = [];
  for (let i = 0; i < 26; i++) {
    const r = rng(`${city}|${i}`);
    const stars = 2 + Math.floor(r() * 4);
    const name = `${PREFIX[i % PREFIX.length]} ${SUFFIX[Math.floor(r() * SUFFIX.length)]}${i >= PREFIX.length ? ' North' : ''}`;
    const amenities = BASE_AMENITIES.filter(() => r() < 0.55);
    const poolRoll = r();
    if (poolRoll < 0.3) amenities.push('Indoor pool');
    else if (poolRoll < 0.6) amenities.push('Outdoor pool');
    if (r() < 0.4) amenities.push('Hot tub');
    if (poolRoll < 0.6 && r() < 0.2) amenities.push('Heated pool');
    list.push({
      i,
      name,
      stars,
      amenities,
      base: 60 + stars * 35 + r() * 80,
      lat: CENTER.lat + (r() - 0.5) * 0.35,
      lng: CENTER.lng + (r() - 0.5) * 0.4,
      rating: Math.round((3 + r() * 2) * 10) / 10,
      reviews: Math.floor(40 + r() * 3000),
      onSuper: r() < 0.85,
      onBooking: r() < 0.7,
      onTa: r() < 0.75,
    });
  }
  return list;
}

const cityOf = (s) => String(s || 'Demo City').split(',')[0].trim() || 'Demo City';
const nightsOf = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 86_400_000));
const jitter = (seed) => 0.92 + rng(seed)() * 0.18;

export function demoCaller(sourceId) {
  return async (tool, args) => {
    await new Promise((r) => setTimeout(r, 150));
    if (sourceId === 'super') return superServer(tool, args);
    if (sourceId === 'booking') return bookingServer(tool, args);
    return tripadvisorServer(tool, args);
  };
}

function superServer(tool, a) {
  if (tool === 'get_rates_for_city') {
    const city = cityOf(a.city_name);
    return {
      city_name: city,
      hotels: hotels(city).filter((h) => h.onSuper).map((h) => {
        const nightly = h.base * jitter(`super${h.i}${a.check_in}`);
        return { name: `${h.name} ${city}`, stars: h.stars, city, images: [], amenities: h.amenities, price_before_tax: nightly / 1.14, price_after_tax: nightly, currency: 'USD', url: 'https://www.super.com/travel/' };
      }),
    };
  }
  return { name: a.hotel_name, rates: [{ currency: 'USD', description: 'Standard Room', pre_tax_price: 120, total_price: 137 }], booking_url: 'https://www.super.com/travel/' };
}

function bookingServer(tool, a) {
  if (tool === 'answer_property_qa_by_ids_v2') {
    const heated = rng(`heat${a.hotel_ids[0]}`)() < 0.5;
    return { answer: heated ? 'Yes, the outdoor pool is heated year-round according to the property, and guests describe the water as warm.' : 'The pool is not heated. Some guests mention the water is cold outside the summer months.' };
  }
  const city = cityOf(a.destination);
  const nights = nightsOf(a.checkin_date, a.checkout_date);
  return {
    accommodations: hotels(city).filter((h) => h.onBooking).filter((h) => {
      const p = h.base;
      return (!a.price?.minimum || p >= a.price.minimum) && (!a.price?.maximum || p < a.price.maximum);
    }).slice(0, 10).map((h) => ({
      id: 1000 + h.i,
      name: `${h.name} ${city}`,
      url: 'https://www.booking.com/',
      price: { book: h.base * jitter(`bk${h.i}${a.checkin_date}`) * nights * 0.97, currency: 'USD' },
      rating: { number_of_reviews: Math.floor(h.reviews / 2), review_score: h.rating * 2 - 0.2, stars: h.stars },
      facilities: h.amenities.map((x) => (x === 'Hot tub' ? 'Hot tub/Jacuzzi' : x)),
      location: { address: `${100 + h.i} Main St`, city_name: city, coordinates: { latitude: h.lat, longitude: h.lng } },
    })),
  };
}

function tripadvisorServer(tool, a) {
  const city = cityOf(a.location || a.hotelName?.split(',')[1]);
  if (tool === 'search_hotels') {
    const nights = nightsOf(a.checkIn, a.checkOut);
    return {
      searchParameters: { searchGeoData: { name: city, lat: CENTER.lat, lon: CENTER.lng } },
      hotels: (a.limit === 1 ? [] : hotels(city).filter((h) => h.onTa)).map((h) => ({
        hotelId: 5000 + h.i,
        hotelName: `${h.name} ${city}`,
        hotelReviewUrl: '/Hotel_Review-demo.html',
        geocode: { latitude: h.lat + 0.0004, longitude: h.lng - 0.0003 },
        reviewSummary: { rating: h.rating, count: h.reviews },
        priceInfo: { availabilityStatus: 'AVAILABLE', displayPrice: `$${Math.round(h.base * nights * jitter(`ta${h.i}`) * 0.95)}`, commerceUrl: `/Commerce?p=${PARTNERS[h.i % PARTNERS.length]}` },
      })),
    };
  }
  // hotel_details
  const id = a.hotelId || 5000;
  const h = hotels(city)[(id - 5000) % 26] || hotels(city)[0];
  const r = rng(`reviews${id}`);
  const heatedPool = r() < 0.5;
  const hotTub = r() < 0.6;
  const reviews = [];
  for (let k = 0; k < 10; k++) {
    let text = REVIEW_TEXT.filler[Math.floor(r() * REVIEW_TEXT.filler.length)];
    const roll = r();
    if (roll < 0.45) {
      const set = (heatedPool ? r() < 0.85 : r() < 0.15) ? REVIEW_TEXT.heated : REVIEW_TEXT.cold;
      text += ` ${set[Math.floor(r() * set.length)]}`;
    } else if (roll < 0.65) {
      const set = (hotTub ? r() < 0.85 : r() < 0.2) ? REVIEW_TEXT.tubHot : REVIEW_TEXT.tubCold;
      text += ` ${set[Math.floor(r() * set.length)]}`;
    }
    reviews.push({ title: 'Demo review', text, rating: 3 + Math.floor(r() * 3), publishedDate: `2026-0${1 + Math.floor(r() * 9)}-1${k % 9}` });
  }
  const nights = nightsOf(a.checkIn, a.checkOut);
  return {
    hotel: { id, name: `${h.name} ${city}`, location: { latitude: h.lat, longitude: h.lng }, amenities: h.amenities.map((n) => ({ name: n })), reviews },
    offers: { metaOffers: PARTNERS.slice(0, 4 + (id % 3)).map((p, k) => ({ providerName: p, displayPrice: `$${Math.round(h.base * nights * (0.9 + k * 0.04))}`, commerceUrl: `/Commerce?p=${p}`, status: 'AVAILABLE' })) },
    aiReviewSummary: 'Demo summary: guests like the location and the pool area.',
  };
}
