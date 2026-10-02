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
  CREATE TABLE IF NOT EXISTS price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_token TEXT NOT NULL,
    check_in TEXT NOT NULL,
    check_out TEXT NOT NULL,
    adults INTEGER NOT NULL,
    nightly REAL,
    total REAL,
    currency TEXT,
    observed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snap ON price_snapshots (property_token, check_in, check_out, adults, observed_at);
  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_token TEXT NOT NULL,
    name TEXT NOT NULL,
    query TEXT,
    check_in TEXT NOT NULL,
    check_out TEXT NOT NULL,
    adults INTEGER NOT NULL,
    currency TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    UNIQUE (property_token, check_in, check_out, adults)
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

export function recordSnapshot({ propertyToken, checkIn, checkOut, adults, nightly, total, currency, observedAt = Date.now() }) {
  if (!propertyToken || nightly == null) return;
  // At most one snapshot per stay per hour so cached re-searches don't skew history.
  const recent = db.prepare(`SELECT 1 FROM price_snapshots WHERE property_token = ? AND check_in = ? AND check_out = ?
    AND adults = ? AND observed_at > ?`).get(propertyToken, checkIn, checkOut, adults, observedAt - 3600_000);
  if (recent) return;
  db.prepare(`INSERT INTO price_snapshots (property_token, check_in, check_out, adults, nightly, total, currency, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(propertyToken, checkIn, checkOut, adults, nightly, total ?? null, currency ?? null, observedAt);
}

export function getHistory({ propertyToken, checkIn, checkOut, adults }) {
  return db.prepare(`SELECT nightly, total, observed_at AS observedAt FROM price_snapshots
    WHERE property_token = ? AND check_in = ? AND check_out = ? AND adults = ? ORDER BY observed_at`)
    .all(propertyToken, checkIn, checkOut, adults);
}
