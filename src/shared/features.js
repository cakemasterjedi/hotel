// Works out pool / hot tub features from amenity lists of any booking site.

const NOT_A_POOL = /billiard|pool table|nearby|car ?pool|pool toys?|parasol|umbrella|cabana|lounger|fence|hoist|lift|ramp|towel|poolside bar|pool bar|whirlpool/i;
const POOL = /pool/i;
const INDOOR = /indoor (swimming )?pool|INDOOR_POOL/i;
const OUTDOOR = /outdoor (swimming )?pool|OUTDOOR_POOL/i;
const HOT_TUB = /hot ?tub|jacuzzi|whirlpool(?! ?bath)|spa tub|hot spring|HOT_TUB/i;
const HEATED = /heated (indoor |outdoor |swimming )?pool|HEATED_POOL/i;

export function detectFeatures(amenities = []) {
  const f = { pool: false, indoorPool: false, outdoorPool: false, hotTub: false, heatedPoolListed: false };
  for (const raw of amenities) {
    const a = String(raw);
    if (HOT_TUB.test(a) && !/bathtub|in-room|in room/i.test(a)) f.hotTub = true;
    if (HEATED.test(a)) f.heatedPoolListed = true;
    if (!POOL.test(a) || NOT_A_POOL.test(a)) continue;
    if (/private pool|children'?s pool|kids'? pool|KIDS_POOL/i.test(a)) continue;
    f.pool = true;
    if (INDOOR.test(a)) f.indoorPool = true;
    if (OUTDOOR.test(a)) f.outdoorPool = true;
  }
  if (f.heatedPoolListed) f.pool = true;
  return f;
}
