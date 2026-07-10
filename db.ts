// db.ts
import Database from 'better-sqlite3';
import path from 'path';

// Vercel's filesystem is read-only except /tmp, and audits.db (gitignored) isn't
// part of the deployment bundle — open it from /tmp there so the app can boot.
// Note: /tmp is ephemeral, so leads/cache data won't persist across cold starts on Vercel.
const dbPath = process.env.VERCEL ? '/tmp/audits.db' : path.join(__dirname, 'audits.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    domain                   TEXT PRIMARY KEY,
    business_name            TEXT,
    city                     TEXT,
    state                    TEXT,
    vertical                 TEXT,
    niche_matched            TEXT,
    primary_keyword          TEXT,
    lead_gbp_rating          REAL,
    lead_review_count        INTEGER,
    lead_map_position        INTEGER,
    lead_gbp_place_id        TEXT,
    competitor_name          TEXT,
    competitor_domain        TEXT,
    competitor_gbp_id        TEXT,
    competitor_rating        REAL,
    competitor_review_count  INTEGER,
    competitor_position      INTEGER,
    traffic_monthly          INTEGER,
    lite_report_data         TEXT,
    lite_report_generated_at DATETIME,
    full_report_generated_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS mappack_cache (
    keyword      TEXT NOT NULL,
    city         TEXT NOT NULL,
    state        TEXT NOT NULL,
    items_json   TEXT NOT NULL,
    fetched_at   DATETIME DEFAULT (datetime('now')),
    PRIMARY KEY (keyword, city, state)
  );

  CREATE TABLE IF NOT EXISTS pagespeed_cache (
    domain        TEXT NOT NULL,
    strategy      TEXT NOT NULL CHECK(strategy IN ('mobile','desktop')),
    score         INTEGER,
    lcp           TEXT,
    cls           TEXT,
    inp           INTEGER,
    ttfb          INTEGER,
    raw_json      TEXT,
    fetched_at    DATETIME DEFAULT (datetime('now')),
    PRIMARY KEY (domain, strategy)
  );
`);

// Remove old-format mappack_cache entries (format was "Electrical Dallas Texas"; 3+ words).
// Single or two-word keywords like "hvac contractor" are valid and must not be deleted.
db.prepare(`DELETE FROM mappack_cache WHERE keyword LIKE '% % %'`).run();

// ─── One-time migrations ─────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, run_at DATETIME DEFAULT (datetime('now')))`);

// Migration v1: flush cache built with "keyword in city" DFS queries (double-location keyword).
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_bare_keyword'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_bare_keyword')`).run();
  console.log('[DB] Migration: flushed mappack_cache (stale double-location keyword format)');
}

// Migration v2: flush cache built with zoom=14 (too narrow) or no location_coordinate.
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_zoom11'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_zoom11')`).run();
  console.log('[DB] Migration: flushed mappack_cache (zoom=11)');
}

// Migration v3: flush all DFS / multi-keyword cache.
// Engine now uses Google Places only, single query "vertical city" (e.g. "HVAC Toledo").
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_single_keyword_places'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_single_keyword_places')`).run();
  console.log('[DB] Migration: flushed mappack_cache (now Google Places only, single keyword)');
}

// Migration v4: flush mappack_cache — switching to DataForSEO Maps SERP (proximity-ranked) as
// primary source. Google Places text search results were off by 5-7 positions vs real Maps.
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_use_dfs_maps'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_use_dfs_maps')`).run();
  console.log('[DB] Migration: flushed mappack_cache (switching to DataForSEO Maps SERP)');
}

// Migration v6: flush cache — switching to Local Finder endpoint ("HVAC Toledo" Google Search)
// and deduplicating ghost entries that inflated rank numbers by 2.
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_local_finder'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_local_finder')`).run();
  console.log('[DB] Migration: flushed mappack_cache (switching to DataForSEO Local Finder + dedup)');
}

// Migration v7: flush compound-key cache entries (keyword stored as "hvac|toledo|ohio").
// Cache key is now just vertical.toLowerCase() — city+state are separate columns.
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_compound_key'`).get()) {
  db.prepare(`DELETE FROM mappack_cache WHERE keyword LIKE '%|%'`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_compound_key')`).run();
  console.log('[DB] Migration: flushed mappack_cache (compound keyword → simple vertical key)');
}

// Migration v8: flush cache — switching local_finder back as primary source.
// local_finder scrapes Google Search Places tab (matches manual verification).
// Previous Maps-only cache entries are stale and from the wrong surface.
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_local_finder_primary'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_local_finder_primary')`).run();
  console.log('[DB] Migration: flushed mappack_cache (local_finder as primary source)');
}

// Migration v9: flush cache — local_finder keyword changed to short form (no state).
// "hvac in toledo" + location_coordinate matches exactly what users type manually.
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_short_keyword'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_short_keyword')`).run();
  console.log('[DB] Migration: flushed mappack_cache (short keyword for local_finder)');
}

// Migration v10: flush cache — local_finder location switched from city-anchored
// (location_coordinate / city location_name → "near me" proximity pack) to
// location_name: 'United States' (broad relevance-ranked Places page). This matches
// manual verification checks performed from outside the lead's city.
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_us_location'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_us_location')`).run();
  console.log('[DB] Migration: flushed mappack_cache (local_finder location_name → United States)');
}

// Migration v11: flush cache — primary source switched to direct Google Maps scrape
// (services/gmaps.ts). Cached local_finder rows are from the Search Places tab, a
// different surface with different ordering.
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_gmaps_scrape'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_gmaps_scrape')`).run();
  console.log('[DB] Migration: flushed mappack_cache (direct Google Maps scrape as primary source)');
}

// Migration v12: flush cache — Maps scrape switched from direct /maps/search/ URL
// navigation to typing the query into the search box. URL navigation returned a
// server-rendered ranking that no real browser reproduces (reordered #2–#7 vs
// manual checks); the typed interactive search matches what users actually see.
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_typed_search'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_typed_search')`).run();
  console.log('[DB] Migration: flushed mappack_cache (typed-search Maps scrape)');
}

// Migration v13: flush cache — the Maps scrape now waits for the results feed to stop
// re-ranking before reading it (Google streams a transient order for a few seconds after
// results render). Cached rows were captured mid-rerank and can be off by 1-2 positions.
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_stabilized_feed'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_stabilized_feed')`).run();
  console.log('[DB] Migration: flushed mappack_cache (stabilized feed read)');
}

// Migration v14: flush cache — the cache key now embeds the match surface
// ("vertical::map" | "vertical::place" | "vertical::business"), since map/place/business
// rank independently. Old rows are keyed by bare "vertical" and would be served for the
// wrong surface, so drop them all.
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='flush_mappack_match_type'`).get()) {
  db.prepare(`DELETE FROM mappack_cache`).run();
  db.prepare(`INSERT INTO migrations (name) VALUES ('flush_mappack_match_type')`).run();
  console.log('[DB] Migration: flushed mappack_cache (per-surface cache key: map/place/business)');
}

// Migration v5: drop redundant lead_id column (was always equal to domain).
if (!db.prepare(`SELECT 1 FROM migrations WHERE name='drop_lead_id_column'`).get()) {
  const cols: any[] = db.prepare(`PRAGMA table_info(leads)`).all();
  if (cols.some(c => c.name === 'lead_id')) {
    db.exec(`
      CREATE TABLE leads_new (
        domain                   TEXT PRIMARY KEY,
        business_name            TEXT,
        city                     TEXT,
        state                    TEXT,
        vertical                 TEXT,
        niche_matched            TEXT,
        primary_keyword          TEXT,
        lead_gbp_rating          REAL,
        lead_review_count        INTEGER,
        lead_map_position        INTEGER,
        lead_gbp_place_id        TEXT,
        competitor_name          TEXT,
        competitor_domain        TEXT,
        competitor_gbp_id        TEXT,
        competitor_rating        REAL,
        competitor_review_count  INTEGER,
        competitor_position      INTEGER,
        traffic_monthly          INTEGER,
        lite_report_data         TEXT,
        lite_report_generated_at DATETIME,
        full_report_generated_at DATETIME
      );
      INSERT INTO leads_new SELECT domain,business_name,city,state,vertical,niche_matched,primary_keyword,
        lead_gbp_rating,lead_review_count,lead_map_position,lead_gbp_place_id,
        competitor_name,competitor_domain,competitor_gbp_id,competitor_rating,competitor_review_count,competitor_position,
        traffic_monthly,lite_report_data,lite_report_generated_at,full_report_generated_at
      FROM leads;
      DROP TABLE leads;
      ALTER TABLE leads_new RENAME TO leads;
    `);
    console.log('[DB] Migration: dropped lead_id column from leads table');
  }
  db.prepare(`INSERT INTO migrations (name) VALUES ('drop_lead_id_column')`).run();
}

export default db;