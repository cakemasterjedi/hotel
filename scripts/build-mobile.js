// Builds mobile/hotel-hunter.html: a single self-contained page (published as a
// claude.ai Artifact) that reuses the exact same shared modules as the server.
// Usage: node scripts/build-mobile.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchSuper, searchBooking, searchTripadvisor } from '../src/shared/sources.js';
import { merge, nightsBetween } from '../src/shared/merge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = ['geo', 'near', 'features', 'merge', 'sources', 'poolHeat', 'forecast']; // dependency order

function inline(name) {
  let src = fs.readFileSync(path.join(root, 'src/shared', `${name}.js`), 'utf8');
  const exported = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  src = src
    .replace(/^import\s*\{([^}]+)\}\s*from\s*'\.\/([A-Za-z0-9_]+)\.js';?$/gm, (_, names, mod) => `const {${names}} = __${mod};`)
    .replace(/^export\s+/gm, '');
  if (/^\s*(import|export)\b/m.test(src)) throw new Error(`Unsupported import/export in ${name}.js`);
  return `const __${name} = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();`;
}

// Example results from real responses captured on 2 Oct 2026 (test fixtures).
async function example() {
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/live-responses.json'), 'utf8'));
  const stay = { q: 'Scottsdale, AZ', checkIn: '2026-10-20', checkOut: '2026-10-21', adults: 2, children: 0 };
  const stub = (p) => async () => p;
  const ta = await searchTripadvisor(stub(fx.tripadvisor), stay, {});
  const listings = [...await searchSuper(stub(fx.super), stay), ...await searchBooking(stub(fx.booking), stay), ...ta.listings];
  const hotels = merge(listings, nightsBetween(stay.checkIn, stay.checkOut)).filter((h) => h.best).map((h) => ({ ...h, image: null }));
  return { stay, center: ta.center, hotels, observedAt: Date.parse('2026-10-02T13:00:00Z') };
}

const template = fs.readFileSync(path.join(root, 'mobile/template.html'), 'utf8');
const data = await example();
const html = template
  .replace('/*__SHARED__*/', () => MODULES.map(inline).join('\n\n'))
  .replace('/*__EXAMPLE__*/null', () => JSON.stringify(data).replace(/</g, '\\u003c'));
const out = path.join(root, 'mobile/hotel-hunter.html');
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(root, out)} (${Math.round(html.length / 1024)} KB, ${data.hotels.length} example hotels)`);
