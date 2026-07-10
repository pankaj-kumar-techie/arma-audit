import { Router, Request, Response } from 'express';
import { asyncHandler, normalizeUrl } from '../lib/http';
import { getPageSpeed } from '../services/pagespeed';
import { placesTextSearch } from '../lib/places';
import { dfsAuth } from '../lib/auth';
import { resolveStateName, getLeadGBP } from '../services/gbp';
import { getWeightedPosition, type MatchType } from '../services/mappack';
import { captureConsole } from '../lib/trace';
import { fetchT } from '../lib/http';
import db from '../db';

// Same tokens as services/mappack.ts — must be kept in sync.
const MAPS_G_EP = 'Egdnd3Mtd2l6IgFoKgIIAEgAUABYAHAAeACQAQCYAQCgAQCqAQC4AQPIAQCYAgCgAgCYAwCSBwCgBwCyBwC4BwDCBwDIBwCACAE';

function buildSearchUrl(vertical: string, city: string): string {
  const q = encodeURIComponent(`${vertical.toLowerCase()} in ${city.toLowerCase()}`).replace(/%20/g, '+');
  return `https://www.google.com/search?q=${q}&udm=1`;
}

const router = Router();

// Live map pack debug — shows rankings for a vertical so you can verify against Google Maps manually.
// Primary source: DataForSEO SERP Maps (same as the main audit engine).
// Fallback:       Google Places API v1 text search (approximate, not guaranteed Map Pack order).
// Usage: GET /mappack-debug?vertical=Roofing&city=Anchorage&state=AK
// Optional: &bust=1  (clears the 24h cache and forces a fresh live fetch)
router.get('/mappack-debug', asyncHandler(async (req: Request, res: Response) => {
  const { vertical, city, state, bust } = req.query as Record<string, string>;
  if (!vertical || !city || !state) return res.status(400).json({ error: 'vertical, city, state required' });

  // Cache key is vertical.toLowerCase() — same as the main mappack engine.
  const cacheKey = vertical.toLowerCase();

  if (bust === '1') {
    db.prepare('DELETE FROM mappack_cache WHERE keyword=? AND city=? AND state=?').run(cacheKey, city, state);
    console.log(`[Debug] Cache cleared for "${vertical}" @ ${city}`);
  }

  // ── Try reading from the shared cache first ──────────────────────────────
  // The cache is populated by DFS / Google Places during real audit runs — reading it
  // here shows EXACTLY what the engine used for the most recent report.
  const cached: any = db.prepare(
    `SELECT items_json, fetched_at FROM mappack_cache
     WHERE keyword=? AND city=? AND state=? AND fetched_at>datetime('now','-24 hours')`
  ).get(cacheKey, city, state);

  if (cached) {
    const places: any[] = JSON.parse(cached.items_json);
    return res.json({
      vertical,
      city,
      state,
      source: `cache (fetched ${cached.fetched_at})`,
      note:   'Cached data from the audit engine — these ranks are exactly what was used in the last report.',
      count:  places.length,
      positions: places.map((p: any, i: number) => ({
        rank:       (p.rank_group ?? i + 1),
        name:       p.name,
        rating:     p.rating ?? 0,
        reviews:    p.user_ratings_total ?? 0,
        place_id:   p.place_id ?? null,
        maps_url:   p.place_id ? `https://www.google.com/maps/place/?q=place_id:${p.place_id}` : null,
        data_source: p.rank_group != null ? 'dataforseo_maps' : 'google_places',
      })),
    });
  }

  // ── Cache miss: try DFS live (local_finder → maps fallback) ─────────────
  if (process.env.DATAFORSEO_LOGIN) {
    const fullState = await resolveStateName(city, state);

    // Geocode for Maps fallback URL.
    let mapsCoords: { lat: number; lng: number } | null = null;
    try {
      const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(`${city}, ${state}`)}&key=${process.env.GOOGLE_PLACES_API_KEY}`;
      const geoRes = await fetchT(geoUrl, {}, 10000);
      const geoJson = await geoRes.json();
      if (geoJson.status === 'OK' && geoJson.results?.length) {
        const loc = geoJson.results[0].geometry.location;
        mapsCoords = { lat: loc.lat, lng: loc.lng };
      }
    } catch { /* no coords */ }

    const searchQuery = `${vertical.toLowerCase()} in ${city.toLowerCase()} ${fullState.toLowerCase()}`;
    const shortQuery  = `${vertical.toLowerCase()} in ${city.toLowerCase()}`;
    const searchUrl = buildSearchUrl(vertical, city);
    const q = encodeURIComponent(searchQuery).replace(/%20/g, '+');
    const mapsUrl = mapsCoords
      ? `https://www.google.com/maps/search/${q}/@${mapsCoords.lat},${mapsCoords.lng},11z/data=!3m1!4b1?entry=ttu&g_ep=${MAPS_G_EP}`
      : null;

    const dfsAttempts = [
      // local_finder: scrapes Google Search Places tab (udm=1) — matches manual verification.
      // Uses short keyword (no state) + location_coordinate for accurate geo-scoped results.
      // Items from this endpoint have type='local_pack' (confirmed from live API).
      {
        endpoint: 'serp/google/local_finder/live/advanced',
        body: mapsCoords
          ? { keyword: shortQuery, location_coordinate: `${mapsCoords.lat},${mapsCoords.lng}`, language_name: 'English', depth: 10 }
          : { keyword: shortQuery, location_name: `${city},${fullState},United States`, language_name: 'English', depth: 10 },
        typeFilter: 'local_pack',
        label: 'dataforseo_local_finder',
        timeout: 90000,
      },
      // Maps: fallback — reliable, returns place_ids, but different surface from Google Search
      {
        endpoint: 'serp/google/maps/live/advanced',
        body: mapsUrl ? { url: mapsUrl, depth: 100, language_name: 'English' } : { keyword: searchQuery, location_name: `${city},${fullState},United States`, language_name: 'English', depth: 100 },
        typeFilter: 'maps_search',
        label: 'dataforseo_maps',
        timeout: 60000,
      },
    ];

    for (const { endpoint, body, typeFilter, label, timeout } of dfsAttempts) {
      try {
        const dfsRes = await fetchT(
          `https://api.dataforseo.com/v3/${endpoint}`,
          { method: 'POST', headers: { Authorization: `Basic ${dfsAuth()}`, 'Content-Type': 'application/json' }, body: JSON.stringify([body]) },
          timeout,
        );
        const dfsJson = await dfsRes.json();
        const task0   = dfsJson.tasks?.[0];
        if (task0?.status_code !== 20000) {
          console.warn(`[Debug] DFS ${label} status ${task0?.status_code}: ${task0?.status_message}`);
          continue;
        }
        const rawItems: any[] = task0?.result?.[0]?.items ?? [];
        const typeCounts = rawItems.reduce((m: any, i: any) => { m[i.type] = (m[i.type] ?? 0) + 1; return m; }, {});
        console.log(`[Debug] ${label} raw items: ${rawItems.length}, types:`, JSON.stringify(typeCounts));
        const typed = rawItems.filter((i: any) => i.type === typeFilter);
        const items: any[] = (typed.length > 0 ? typed : rawItems.filter((i: any) => i.title && !i.is_paid))
          .filter((i: any) => i.title && !i.is_paid)
          .sort((a: any, b: any) => (a.rank_group ?? 999) - (b.rank_group ?? 999));

        if (items.length > 0) {
          const verifyUrl = (body as any).url ?? searchUrl;
          return res.json({
            vertical, city, state,
            source:     label,
            verify_url: verifyUrl,
            note:       `Open verify_url in an incognito window — the ranked list will match these results exactly.`,
            count:      items.length,
            positions: items.map((p: any) => ({
              rank:     p.rank_group ?? '?',
              name:     p.title ?? '',
              rating:   p.rating?.value ?? 0,
              reviews:  p.rating?.votes_count ?? 0,
              place_id: p.place_id ?? null,
              maps_url: p.place_id ? `https://www.google.com/maps/place/?q=place_id:${p.place_id}` : null,
            })),
          });
        }
        console.warn(`[Debug] DFS ${label}: 0 typed results`);
      } catch (e: any) {
        console.warn(`[Debug] DFS ${label} error:`, e.message);
      }
    }
  }

  // ── Final fallback: Google Places API v1 text search ────────────────────
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return res.status(500).json({ error: 'Neither DATAFORSEO_LOGIN nor GOOGLE_PLACES_API_KEY is set' });
  }

  // Geocode city so we can pass a location restriction — gives rankings closest to
  // what a user sees when manually searching on Google Maps from that city.
  let coords: { lat: number; lng: number } | undefined;
  try {
    const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(`${city}, ${state}`)}&key=${process.env.GOOGLE_PLACES_API_KEY}`;
    const geoRes = await fetchT(geoUrl, {}, 10000);
    const geoJson = await geoRes.json();
    if (geoJson.status === 'OK' && geoJson.results?.length) {
      const loc = geoJson.results[0].geometry.location;
      coords = { lat: loc.lat, lng: loc.lng };
    }
  } catch { /* fallback: no location bias */ }

  const locationBias = coords ? { lat: coords.lat, lng: coords.lng, radius: 15000 } : undefined;
  const allResults: any[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < 2; page++) {
    if (page > 0 && !nextToken) break;
    // Same query + strictToArea=true as the main mappack engine for consistent results.
    const { results, nextPageToken } = await placesTextSearch(
      `${vertical} ${city}`,
      locationBias,
      nextToken,
      true,
    );
    if (!results.length) break;
    allResults.push(...results);
    nextToken = nextPageToken;
    if (!nextToken) break;
  }

  res.json({
    vertical,
    city,
    state,
    source: 'google_places_v1_live',
    note:   `Google Places text search (RELEVANCE order, 15 km restriction around ${city} centre) — closely matches Google Maps local pack. For exact Map Pack positions, set DATAFORSEO_LOGIN.`,
    count:  allResults.length,
    positions: allResults.map((p: any, i: number) => ({
      rank:     i + 1,
      name:     p.name,
      rating:   p.rating ?? 0,
      reviews:  p.user_ratings_total ?? 0,
      place_id: p.place_id ?? null,
      maps_url: p.place_id ? `https://www.google.com/maps/place/?q=place_id:${p.place_id}` : null,
    })),
  });
}));

// Live PageSpeed check — bypasses cache
// Usage: GET /pagespeed-check?url=https://example.com
router.get('/pagespeed-check', asyncHandler(async (req: Request, res: Response) => {
  const { url, strategy = 'mobile', bust } = req.query as Record<string, string>;
  if (!url) return res.status(400).json({ error: 'url required. Example: /pagespeed-check?url=https://example.com' });
  if (strategy !== 'mobile' && strategy !== 'desktop') return res.status(400).json({ error: 'strategy must be mobile or desktop' });

  const bustCache = bust === '1' || bust === 'true';
  const [mobile, desktop] = await Promise.all([
    getPageSpeed(url, 'mobile', bustCache),
    getPageSpeed(url, 'desktop', bustCache),
  ]);
  res.json({
    url,
    tested_at: new Date().toISOString(),
    mobile:  { score: mobile.score,  lcp: mobile.lcp,  cls: mobile.cls,  is_fallback: mobile.is_fallback,  cached: mobile.cached  },
    desktop: { score: desktop.score, lcp: desktop.lcp, cls: desktop.cls, is_fallback: desktop.is_fallback, cached: desktop.cached },
    note: mobile.is_fallback || desktop.is_fallback
      ? 'One or more scores could not be fetched from the API. Check server logs for the specific error.'
      : 'Scores are from the Google PageSpeed Insights API — same source as pagespeed.web.dev.',
  });
}));

router.get('/health', (_req: Request, res: Response) => {
  const leads  = (db.prepare('SELECT COUNT(*) as c FROM leads').get() as any).c;
  const cached = (db.prepare(`SELECT COUNT(*) as c FROM mappack_cache WHERE fetched_at>datetime('now','-24 hours')`).get() as any).c;
  res.json({ status: 'ok', leads_in_db: leads, mappack_cache_live: cached });
});

router.get('/cache-status', (_req: Request, res: Response) => {
  const rows = db.prepare(
    `SELECT keyword, city, state, fetched_at,
      ROUND((julianday('now') - julianday(fetched_at)) * 24, 1) as age_hours
     FROM mappack_cache ORDER BY fetched_at DESC`
  ).all();
  res.json({ count: rows.length, entries: rows });
});

router.delete('/cache-clear', (req: Request, res: Response) => {
  const { keyword, city, state } = req.query as Record<string, string>;
  if (keyword && city && state) {
    const { changes } = db.prepare(
      `DELETE FROM mappack_cache WHERE keyword=? AND city=? AND state=?`
    ).run(keyword, city, state);
    return res.json({ cleared: changes, entry: `${keyword} / ${city}, ${state}` });
  }
  const { changes } = db.prepare(`DELETE FROM mappack_cache`).run();
  res.json({ cleared: changes, message: 'All map pack cache entries deleted' });
});

// ─── Pipeline Trace (Developer debug tool) ───────────────────────────────────
// Runs the REAL ranking pipeline (GBP lookup → map-pack lookup for the chosen surface)
// exactly as /lite-report does, but captures every console line the engine emits and
// returns it alongside the resolved parameters. The point: whatever the system extracts
// — the exact queries/URLs/coords/raw counts/ranking decisions — is handed back in a
// copy-pasteable log so a mismatch can be diagnosed from real data rather than guesses.
//
// POST /debug/trace  { url, city, state, vertical?, matchType?, lat?, lng? }
router.post('/debug/trace', asyncHandler(async (req: Request, res: Response) => {
  const started = Date.now();
  const { url: rawUrl, city, state, vertical, matchType: rawMatchType, lat, lng } = req.body ?? {};
  if (!rawUrl || !city || !state) return res.status(400).json({ error: 'url, city, state required' });

  const url      = normalizeUrl(rawUrl);
  const domain   = new URL(url).hostname.replace('www.', '');
  const bizName  = domain.split('.')[0].replace(/-/g, ' ');
  const niche    = vertical || 'Home Services';
  const matchType: MatchType =
    rawMatchType === 'place' || rawMatchType === 'business' || rawMatchType === 'map' ? rawMatchType : 'map';
  const userLocation =
    typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng } : undefined;

  const { result, logs } = await captureConsole(async () => {
    console.log(`[Trace] ▶ START url=${url} domain=${domain} bizName="${bizName}" niche="${niche}"`);
    console.log(`[Trace] params: matchType=${matchType} liveLocation=${userLocation ? `${userLocation.lat},${userLocation.lng}` : 'none'} submitted="${city}, ${state}"`);

    const gbp = await getLeadGBP(bizName, city, state, domain);
    const matchName   = gbp.real_name && gbp.real_name.length > 2 ? gbp.real_name : bizName;
    // Audit the SUBMITTED market (what the user searches manually), not the lead's GBP city.
    const marketCity  = city;
    const marketState = state;
    const gbpCity  = (gbp as any).gbp_city  && (gbp as any).gbp_city.length  > 1 ? (gbp as any).gbp_city  : city;
    const gbpState = (gbp as any).gbp_state && (gbp as any).gbp_state.length > 1 ? (gbp as any).gbp_state : state;
    console.log(`[Trace] GBP resolved: name="${matchName}" place_id=${gbp.place_id || 'NONE'} rating=${gbp.rating} reviews=${gbp.review_count} | GBP city="${gbpCity}, ${gbpState}"`);
    console.log(`[Trace] Auditing SUBMITTED market "${marketCity}, ${marketState}" (the manual-search location)${gbpCity.toLowerCase() !== marketCity.toLowerCase() ? ` — note lead's GBP city differs ("${gbpCity}, ${gbpState}")` : ''}.`);

    const weighted = await getWeightedPosition(
      niche, marketCity, marketState, matchName, gbp.review_count, gbp.place_id, gbp.rating,
      { matchType, userLocation },
    );

    const pmd = weighted?.primaryMapData;
    return {
      gbp: {
        matched_name: matchName, place_id: gbp.place_id || null,
        rating: gbp.rating, review_count: gbp.review_count,
        market_city: marketCity, market_state: marketState,
        gbp_city: gbpCity, gbp_state: gbpState,
        gbp_city_differs: gbpCity.toLowerCase() !== marketCity.toLowerCase(),
      },
      ranking: weighted ? {
        lead_position:   weighted.weightedPosition,
        data_source:     pmd!.dataSource,
        surface_label:   pmd!.surfaceLabel,
        match_type:      pmd!.matchType,
        verification_url: pmd!.verificationUrl,
        ranking_keywords: weighted.rankingKeywords,
        competitor: pmd!.competitor,
        full_pack: pmd!.fullPack,
      } : null,
    };
  });

  res.json({
    ok: !!result.ranking,
    params: {
      url, domain, submitted_city: city, submitted_state: state,
      vertical: niche, match_type: matchType,
      live_location: userLocation ?? null,
      used_live_location: !!userLocation,
    },
    gbp: result.gbp,
    ranking: result.ranking,
    timing_ms: Date.now() - started,
    log_count: logs.length,
    logs,  // [{ t, level, msg }] — the full engine trace, in order
  });
}));

export default router;
