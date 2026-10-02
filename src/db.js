import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, config.demo ? 'hotels-demo.db' : 'hotels.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_key TEXT NOT NULL,
    check_in TEXT NOT NULL,
    check_out TEXT NOT NULL,
    adults INTEGER NOT NULL,
    nightly REAL,
    total REAL,
    source TEXT,
    observed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history ON price_history (hotel_key, check_in, check_out, adults, observed_at);
  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_key TEXT NOT NULL,
    name TEXT NOT NULL,
    hotel_json TEXT NOT NULL,
    query TEXT,
    check_in TEXT NOT NULL,
    check_out TEXT NOT NULL,
    adults INTEGER NOT NULL,
    children INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    UNIQUE (hotel_key, check_in, check_out, adults)
  );
`);

export function cacheGet(key) {
  const row = db.prepare('SELECT value, expires_at FROM cache WHERE key = ?').get(key);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM cache WHERE key = ?').run(key);
    return null;
  }
  return JSON.parse(row.value);
}

export function cacheSet(key, value, ttlMs) {
  db.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)').run(
    key, JSON.stringify(value), Date.now() + ttlMs,
  );
}

export function recordSnapshot({ hotelKey, checkIn, checkOut, adults, nightly, total, source, observedAt = Date.now() }) {
  if (!hotelKey || !(nightly > 0)) return;
  // At most one snapshot per stay per hour so repeated searches don't skew history.
  const recent = db.prepare(`SELECT 1 FROM price_history WHERE hotel_key = ? AND check_in = ? AND check_out = ?
    AND adults = ? AND observed_at > ?`).get(hotelKey, checkIn, checkOut, adults, observedAt - 3600_000);
  if (recent) return;
  db.prepare(`INSERT INTO price_history (hotel_key, check_in, check_out, adults, nightly, total, source, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(hotelKey, checkIn, checkOut, adults, nightly, total ?? null, source ?? null, observedAt);
}

export function getHistory({ hotelKey, checkIn, checkOut, adults }) {
  return db.prepare(`SELECT nightly, total, source, observed_at AS observedAt FROM price_history
    WHERE hotel_key = ? AND check_in = ? AND check_out = ? AND adults = ? ORDER BY observed_at`)
    .all(hotelKey, checkIn, checkOut, adults);
}
