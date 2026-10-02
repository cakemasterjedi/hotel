import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader so the app runs without extra dependencies.
const envFile = path.resolve('.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 3000),
  serpApiKey: process.env.SERPAPI_KEY || '',
  demo: !process.env.SERPAPI_KEY || process.env.DEMO_MODE === 'true',
  dataDir: process.env.DATA_DIR || path.resolve('data'),
  // Optional basic auth so strangers on your domain can't burn your API credits.
  appUser: process.env.APP_USER || 'admin',
  appPassword: process.env.APP_PASSWORD || '',
  searchCacheHours: num(process.env.SEARCH_CACHE_HOURS, 6),
  reviewCacheDays: num(process.env.REVIEW_CACHE_DAYS, 14),
  searchPages: num(process.env.SEARCH_PAGES, 2),
  reviewPages: num(process.env.REVIEW_PAGES, 2),
  watchIntervalHours: num(process.env.WATCH_INTERVAL_HOURS, 12),
  gl: process.env.SERPAPI_GL || 'us',
  hl: process.env.SERPAPI_HL || 'en',
};
