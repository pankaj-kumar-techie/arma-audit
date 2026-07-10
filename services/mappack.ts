import { fetchT } from '../lib/http';
import db from '../db';
import { dfsAuth } from '../lib/auth';
import { resolveStateName } from '../services/gbp';
import { placesTextSearch, placeWebsite, placeRatingCount, type PlaceResult } from '../lib/places';
import { scrapeMapsPack } from './gmaps';

// Neutral Google experiment-params token for Maps fallback searches.
const MAPS_G_EP = 'Egdnd3Mtd2l6IgFoKgIIAEgAUABYAHAAeACQAQCYAQCgAQCqAQC4AQPIAQCYAgCgAgCYAwCSBwCgBwCyBwC4BwDCBwDIBwCACAE';

// Which Google surface the report should match. Each maps to its own ranking
// algorithm — these surfaces are ranked INDEPENDENTLY by Google and routinely
// differ by 1-3 positions, so the user picks the one they verify against:
//   map      → google.com/maps (the Maps app/site)        → puppeteer scrape / DFS maps
//   place    → Google Search "Places" / "More places"      → DFS local_finder (full list)
//   business → Google Search "All" tab "Businesses" 3-pack  → DFS organic local_pack
export type MatchType = 'map' | 'place' | 'business';
export const DEFAULT_MATCH_TYPE: MatchType = 'map';

export const SURFACE_LABEL: Record<MatchType, string> = {
  map:      'Google Maps',
  place:    "Google Search – Places",
  business: "Google Search – Businesses",
};

export type UserLocation = { lat: number; lng: number };

// Generic trade / legal-suffix words shared across most local-business names. Matching on
// these alone produces false lead matches, so they're excluded from the "distinctive token"
// test and only used as a weak tiebreak (see lead name match below).
const GENERIC_NAME_WORDS = new Set<string>([
  'heating', 'cooling', 'air', 'conditioning', 'conditioner', 'hvac', 'heat', 'cool',
  'plumbing', 'plumber', 'mechanical', 'comfort', 'refrigeration', 'furnace', 'ac',
  'electric', 'electrical', 'service', 'services', 'repair', 'systems', 'system',
  'solutions', 'company', 'inc', 'llc', 'co', 'the', 'and', 'group', 'home', 'pro',
]);

// Builds the Google Search verification URL — short form matches what users actually type.
// business → the "All" tab (where the Businesses 3-pack lives); place → the local "Places"
// list (udm=1). A coordinate isn't expressible in a shareable search URL, so this is only a
// fallback when the data source didn't return its own location-pinned check_url.
export function buildSearchUrl(vertical: string, city: string, matchType: MatchType = 'business'): string {
  const q = encodeURIComponent(`${vertical.toLowerCase()} in ${city.toLowerCase()}`).replace(/%20/g, '+');
  return matchType === 'place'
    ? `https://www.google.com/search?q=${q}&udm=1`
    : `https://www.google.com/search?q=${q}`;
}

// Builds the Google Maps URL for the Maps scrape — includes state in query.
function buildMapsUrl(vertical: string, city: string, state: string, lat: number, lng: number): string {
  const q = encodeURIComponent(`${vertical.toLowerCase()} in ${city.toLowerCase()} ${state.toLowerCase()}`).replace(/%20/g, '+');
  return `https://www.google.com/maps/search/${q}/@${lat},${lng},11z/data=!3m1!4b1?entry=ttu&g_ep=${MAPS_G_EP}`;
}

// DataForSEO fallback — the endpoint chosen depends on which Google surface the
// caller wants to match (matchType):
//   place    → local_finder  (Google Search "Places"/"More places" full list)
//   business → organic        (the "Businesses" local_pack on the Search "All" tab)
//   map      → maps           (Google Maps — only reached when the puppeteer scrape fails)
//
// When real coordinates are available we pin the search to them via location_coordinate so
// the ranking matches what a searcher physically at that point sees (Search-local results are
// strongly proximity-personalized). Without coordinates we fall back to a broad,
// relevance-ranked national "Places" page (location_name: 'United States'), which is what a
// non-local searcher checking from outside the city sees.
async function getMapsPackFromDFS(
  vertical: string,
  city: string,
  state: string,
  matchType: MatchType,
  coords: { lat: number; lng: number } | null,
): Promise<{ places: PlaceResult[]; source: string; checkUrl: string } | null> {
  if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) return null;
  const fullState = await resolveStateName(city, state);
  const locationName = `${city},${fullState},United States`;

  // "vertical in city" WITHOUT state — matches exactly what a user types when searching.
  const shortQuery  = `${vertical.toLowerCase()} in ${city.toLowerCase()}`;
  const searchQuery = `${vertical.toLowerCase()} in ${city.toLowerCase()} ${fullState.toLowerCase()}`;
  // DataForSEO location_coordinate: "latitude,longitude,zoom". zoom≈12 ≈ city-wide.
  const locCoord = coords ? `${coords.lat},${coords.lng},12z` : undefined;
  const searchLocation = locCoord
    ? { location_coordinate: locCoord }
    : { location_name: 'United States' };

  // Build the attempt chain head-first for the requested surface, then degrade to the others
  // so a single-surface API hiccup still yields a ranking rather than a hard failure.
  const localFinder = {
    endpoint: 'serp/google/local_finder/live/advanced',
    body: { keyword: shortQuery, ...searchLocation, language_name: 'English', depth: 20 },
    label: 'dataforseo_local_finder',
    timeout: 90000,
  };
  // The "Businesses" 3-pack is an element inside the organic Search results page — depth 20 is
  // enough to render it; we parse the local_pack items it contains.
  const organicLocalPack = {
    endpoint: 'serp/google/organic/live/advanced',
    body: { keyword: shortQuery, ...searchLocation, language_name: 'English', depth: 20 },
    label: 'dataforseo_business_pack',
    timeout: 90000,
  };
  const mapsEndpoint = {
    endpoint: 'serp/google/maps/live/advanced',
    body: coords
      ? { url: buildMapsUrl(vertical, city, fullState, coords.lat, coords.lng), depth: 100, language_name: 'English' }
      : { keyword: searchQuery, location_name: locationName, language_name: 'English', depth: 100 },
    label: 'dataforseo_maps',
    timeout: 60000,
  };

  const attempts: Array<{ endpoint: string; body: Record<string, any>; label: string; timeout: number }> =
    matchType === 'business' ? [organicLocalPack, localFinder, mapsEndpoint]
    : matchType === 'map'     ? [mapsEndpoint, localFinder]
    :                           [localFinder, organicLocalPack, mapsEndpoint];

  console.log(`[MapPack] DFS plan for "${shortQuery}" (${matchType}) → ${attempts.map(a => a.label).join(' → ')}`);
  for (const { endpoint, body, label, timeout } of attempts) {
    const queryDesc = (body as any).url ?? (body as any).keyword ?? label;
    // The exact outbound request — keyword, depth, and the location param (location_coordinate
    // for a pinned/located search vs location_name for a broad national check).
    console.log(`[MapPack] → POST ${endpoint} | body=${JSON.stringify(body)}`);
    try {
      const res = await fetchT(
        `https://api.dataforseo.com/v3/${endpoint}`,
        {
          method:  'POST',
          headers: { Authorization: `Basic ${dfsAuth()}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify([body]),
        },
        timeout,
      );
      const json  = await res.json();
      const task0 = json.tasks?.[0];
      if (task0?.status_code !== 20000) {
        console.warn(`[MapPack] DFS ${label} status ${task0?.status_code}: ${task0?.status_message}`);
        continue;
      }
      // check_url is the exact Google URL DFS scraped (location pinned via uule) —
      // opening it reproduces this snapshot far better than a plain search URL.
      const checkUrl: string = task0?.result?.[0]?.check_url ?? '';
      const rawItems: any[] = task0?.result?.[0]?.items ?? [];
      const typeCounts = rawItems.reduce((m: any, i: any) => { m[i.type] = (m[i.type] ?? 0) + 1; return m; }, {});
      console.log(`[MapPack] ${label} raw ${rawItems.length} items, types:`, JSON.stringify(typeCounts));
      // maps endpoint items have type='maps_search'.
      // local_finder AND organic endpoints expose businesses as type='local_pack'
      // (the organic SERP's "Businesses" 3-pack is a local_pack element).
      // Filter to the right type so ads/featured-snippets/organic links don't inflate rankings.
      const typeFilter = endpoint.includes('/maps/') ? 'maps_search' : 'local_pack';
      const typed = rawItems.filter((i: any) => i.type === typeFilter);
      const items = (typed.length > 0 ? typed : rawItems)
        .sort((a: any, b: any) => (a.rank_group ?? 999) - (b.rank_group ?? 999));

      // Some businesses appear twice (once without place_id as a featured card, once with place_id
      // as a map pin). Deduplicate by name: keep the first-seen rank, but use the place_id from
      // whichever instance has one.
      const placeIdByName = new Map<string, string>();
      for (const i of items) {
        if (!i.title || !i.place_id) continue;
        const key = i.title.toLowerCase().trim();
        if (!placeIdByName.has(key)) placeIdByName.set(key, i.place_id);
      }

      const seen = new Set<string>();
      const places: PlaceResult[] = [];
      for (const i of items) {
        if (!i.title || i.is_paid) continue;
        const key = i.title.toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        places.push({
          place_id:           placeIdByName.get(key) ?? i.place_id ?? '',
          name:               i.title,
          rating:             i.rating?.value ?? 0,
          user_ratings_total: i.rating?.votes_count ?? 0,
        });
      }

      if (!places.length) {
        console.warn(`[MapPack] DFS ${label}: 0 results for "${queryDesc}"`);
        continue;
      }
      console.log(`[MapPack] DFS ${label}: ${places.length} unique results for "${queryDesc}"`);
      places.forEach((p, i) =>
        console.log(`  #${i + 1} "${p.name}" reviews:${p.user_ratings_total} place_id:${p.place_id || 'none'}`)
      );
      return { places, source: label, checkUrl };
    } catch (e: any) {
      console.warn(`[MapPack] DFS ${label} error:`, e.message);
    }
  }
  return null;
}

export const DEFAULT_EXCLUDED_BRANDS: string[] = [];

export interface MapPackConfig {
  excludedBrands?: string[];
  // Which Google surface to match (defaults to Maps). See MatchType.
  matchType?: MatchType;
  // The searcher's live coordinates. When provided, the ranking is pinned to this
  // exact point (matches what THIS user sees) and the shared cache is bypassed so
  // one user's location-specific result never leaks to another.
  userLocation?: UserLocation;
}

//  Lead #1    → compare with #2 (closest challenger)
//  Lead #2–4  → compare with #1
//  Lead #5–8  → compare with #3
//  Lead #9–13 → compare with #4
//  Lead #14+  → compare with #5
// Returned rank counts NON-LEAD entries: when the lead is #1, the 1st non-lead
// entry is overall #2 — so leads #1–4 all target rank 1. (Returning 2 here used
// to skip past the real #2 and pick the overall #3 as "closest challenger".)
function pickCompetitorRank(leadPos: number): number {
  if (leadPos <= 4)  return 1;
  if (leadPos <= 8)  return 3;
  if (leadPos <= 13) return 4;
  return 5;
}

// Max distance a live user location may sit from the searched city centroid before we treat
// it as a remote auditor's device and ignore it. ~160 km keeps same-metro / adjacent-town
// locations valid while rejecting another-state or another-country device coordinates (an
// agency auditing US cities from abroad must not anchor the search to its own continent).
const LIVE_LOCATION_MAX_KM = 160;

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Geocoding API — city centre lat/lng for Places location bias.
const _geocodeCache = new Map<string, { lat: number; lng: number }>();

async function geocodeCity(city: string, state: string): Promise<{ lat: number; lng: number } | null> {
  const key = `${city.toLowerCase()},${state.toLowerCase()}`;
  if (_geocodeCache.has(key)) return _geocodeCache.get(key)!;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(`${city}, ${state}`)}&key=${process.env.GOOGLE_PLACES_API_KEY}`;
    const res  = await fetchT(url, {}, 10000);
    const json = await res.json();
    if (json.status !== 'OK' || !json.results?.length) return null;
    const loc    = json.results[0].geometry.location;
    const coords = { lat: loc.lat as number, lng: loc.lng as number };
    _geocodeCache.set(key, coords);
    console.log(`[MapPack] Geocoded "${city}, ${state}" → ${coords.lat},${coords.lng}`);
    return coords;
  } catch (e: any) {
    console.warn('[MapPack] Geocode error:', e.message);
    return null;
  }
}

// Google Places API v1 text search — up to 40 results (2 pages × 20).
// Uses locationRestriction (hard boundary) at 15 km radius around city centre so the ranked
// list matches what a user sees when manually searching on Google Maps from that city.
async function searchPlaces(query: string, coords?: { lat: number; lng: number }): Promise<PlaceResult[]> {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    console.warn('[MapPack] GOOGLE_PLACES_API_KEY not set');
    return [];
  }
  // 15 km strict boundary — covers the city proper while excluding the next city over.
  const locationBias = coords ? { lat: coords.lat, lng: coords.lng, radius: 15000 } : undefined;
  const all: PlaceResult[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < 2; page++) {
    if (page > 0 && !nextToken) break;
    // strictToArea=true → locationRestriction, giving rankings closest to Google Maps local pack.
    const { results, nextPageToken } = await placesTextSearch(query, locationBias, nextToken, true);
    if (!results.length) break;
    all.push(...results);
    nextToken = nextPageToken;
    if (!nextToken) break;
  }
  return all;
}

// ─── Map Pack lookup ─────────────────────────────────────────────────────────

export type MapPackResult = {
  leadPosition: number;
  fullPack: Array<{
    position: number; name: string; rating: number; review_count: number;
    place_id: string | null; gbp_url: string | null; isLead: boolean; isCompetitor: boolean;
  }>;
  dataSource: string;
  verificationUrl: string;
  matchType: MatchType;
  surfaceLabel: string;
  // How (and whether) the submitted business was located in the pack. Used by the
  // report layer to validate lead identity before labelling a row as "YOU".
  lead: {
    found: boolean;
    matchMethod: 'place_id' | 'name_review' | 'none';
    name: string;
    rating: number;
    review_count: number;
    place_id: string | null;
  };
  competitor: {
    name: string; rating: number; review_count: number; position: number;
    domain: string; place_id: string; gbp_url: string | null;
  };
};

export async function getMapPackPosition(
  vertical: string,
  city: string,
  state: string,
  leadName: string,
  leadReviewCount: number,
  leadPlaceId: string,
  leadRating: number,
  config: MapPackConfig = {},
): Promise<{ primaryMapData: MapPackResult; leadPosition: number } | null> {
  const { excludedBrands = DEFAULT_EXCLUDED_BRANDS, matchType = DEFAULT_MATCH_TYPE, userLocation } = config;

  // Cache is keyed per surface — map/place/business rank independently and must not collide.
  const cacheKey = `${vertical.toLowerCase()}::${matchType}`;
  const surfaceLabel = SURFACE_LABEL[matchType];

  console.log(`[MapPack] Lookup "${vertical}" in "${city}, ${state}" | surface=${matchType} (${surfaceLabel}) | cacheKey="${cacheKey}"`);

  // Anchor the search to a coordinate so the ranking matches a manual search for THIS city.
  // The city centroid is the baseline — a "<vertical> in <city>" search centers there. A live
  // user location is used ONLY when it's plausibly inside the searched market; a remote
  // auditor's device far away would otherwise anchor the search to the wrong region, so it's
  // rejected in favour of the centroid. This keeps the API ranking aligned with what the
  // client sees doing the same manual search.
  const cityCentroid = await geocodeCity(city, state);
  let coords = cityCentroid;
  let usingLive = false;
  if (userLocation) {
    const km = cityCentroid ? haversineKm(userLocation, cityCentroid) : Infinity;
    if (cityCentroid && km <= LIVE_LOCATION_MAX_KM) {
      coords = userLocation;
      usingLive = true;
    } else {
      console.warn(
        `[MapPack] Ignoring live location ${userLocation.lat},${userLocation.lng} — ` +
        `${Number.isFinite(km) ? Math.round(km) + 'km' : 'unknown distance'} from the "${city}" centroid. ` +
        `Anchoring to the searched city so the ranking matches a manual "${city}, ${state}" search.`
      );
    }
  }
  console.log(
    `[MapPack] Coordinate anchor: ${coords ? `${coords.lat},${coords.lng}` : 'NONE (broad national check)'} ` +
    `(${usingLive ? 'LIVE user location' : coords ? 'city centroid' : 'unavailable'})`
  );

  // ── Cache (6-hour TTL — rankings shift intraday; keep snapshots close to what a
  // manual verification check sees). Live-location runs bypass the shared cache so a
  // result pinned to one user's GPS point is never served to another. ──────────────
  let places: PlaceResult[];
  let dataSource: string;
  let checkUrl = '';

  const cached: any = usingLive ? null : db.prepare(
    `SELECT items_json FROM mappack_cache WHERE keyword=? AND city=? AND state=? AND fetched_at>datetime('now','-6 hours')`
  ).get(cacheKey, city, state);

  if (cached) {
    const parsed = JSON.parse(cached.items_json);
    // Legacy rows stored a bare places array; current rows store { checkUrl, places }.
    places = Array.isArray(parsed) ? parsed : parsed.places;
    checkUrl = Array.isArray(parsed) ? '' : (parsed.checkUrl ?? '');
    dataSource = 'cached';
    console.log(`[MapPack] Cache HIT: "${cacheKey}" @ ${city},${state} (${places.length} results)`);
  } else {
    console.log(`[MapPack] Cache MISS${usingLive ? ' (bypassed — live location)' : ''}: fetching fresh for "${cacheKey}" @ ${city},${state}`);
    // For the Maps surface, the direct google.com/maps puppeteer scrape is the exact list a
    // prospect sees there, and the scraped URL doubles as the verification link. For the
    // Search surfaces (place/business) the ranking comes from DataForSEO, which pins the
    // location and returns the matching check_url.
    const gmaps = matchType === 'map' && coords ? await scrapeMapsPack(vertical, city, coords) : null;
    if (gmaps) {
      places = gmaps.places;
      dataSource = 'google_maps';
      checkUrl = gmaps.mapsUrl;
      places.forEach((p, i) =>
        console.log(`  #${i + 1} "${p.name}" reviews:${p.user_ratings_total} place_id:${p.place_id || 'none'}`)
      );
    } else {
      // Fallback / Search-surface primary: DataForSEO (endpoint chosen by matchType).
      const dfsResult = await getMapsPackFromDFS(vertical, city, state, matchType, coords);
      if (dfsResult) {
        places = dfsResult.places;
        dataSource = dfsResult.source;
        checkUrl = dfsResult.checkUrl;
      } else {
        // Last resort: Google Places text search (least accurate — ranks by relevance).
        const query = `${vertical} ${city}`;
        console.log(`[MapPack] ${matchType} source + DFS unavailable — falling back to Google Places for "${query}"`);
        places = await searchPlaces(query, coords ?? undefined);
        if (!places.length) {
          console.error(`[MapPack] No results for "${query}" — check GOOGLE_PLACES_API_KEY quota`);
          return null;
        }
        dataSource = 'google_places';
        console.log(`[MapPack] Google Places: ${places.length} results`);
        places.forEach((p, i) =>
          console.log(`  #${i + 1} "${p.name}" reviews:${p.user_ratings_total} place_id:${p.place_id}`)
        );
      }
    }
    // Only persist shared (non-live-location) snapshots.
    if (!usingLive) db.prepare(
      `INSERT OR REPLACE INTO mappack_cache (keyword,city,state,items_json) VALUES (?,?,?,?)`
    ).run(cacheKey, city, state, JSON.stringify({ checkUrl, places }));
  }

  // ── Find lead ────────────────────────────────────────────────────────────────
  let leadIdx = -1;
  let leadMatchMethod: 'place_id' | 'name_review' | 'none' = 'none';

  // Pass 1: exact place_id
  if (leadPlaceId) {
    leadIdx = places.findIndex(p => p.place_id === leadPlaceId);
    if (leadIdx !== -1) {
      leadMatchMethod = 'place_id';
      console.log(`[MapPack] ✓ Lead by place_id: #${leadIdx + 1} "${places[leadIdx].name}"`);
    } else {
      console.warn(`[MapPack] ✗ Lead place_id "${leadPlaceId}" not in top-${places.length} results`);
    }
  }

  // Pass 2: name + review-count fuzzy match.
  // Industry/legal-suffix words ("heating", "cooling", "llc", …) are shared by nearly every
  // business in the pack, so matching on them alone falsely tagged e.g. "Rick's Affordable
  // Heating" as "Perrysburg Plumbing & Heating". We therefore require overlap on a DISTINCTIVE
  // token (brand/owner words) and only use generic words as a weak tiebreak.
  if (leadIdx === -1) {
    const tokenize = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    const leadTokens   = tokenize(leadName);
    const distinctive  = leadTokens.filter(w => !GENERIC_NAME_WORDS.has(w));
    // "within 2% or ±3" — review counts drift between sources (1202 vs 1200) and across surfaces.
    const reviewClose = (n: number) =>
      leadReviewCount > 0 && n > 0 &&
      (Math.abs(n - leadReviewCount) <= 3 || Math.abs(n - leadReviewCount) / leadReviewCount <= 0.02);

    let bestScore = 0;
    for (let i = 0; i < places.length; i++) {
      const pTokens = new Set(tokenize(places[i].name));
      const distinctiveHits = distinctive.filter(w => pTokens.has(w)).length;
      // No distinctive overlap → not a match, regardless of shared generic words.
      if (distinctiveHits === 0) continue;
      let score = distinctiveHits * 30;
      if (leadTokens.some(w => GENERIC_NAME_WORDS.has(w) && pTokens.has(w))) score += 5; // weak tiebreak
      if (reviewClose(places[i].user_ratings_total))                        score += 60;
      if (score > bestScore) { bestScore = score; leadIdx = i; }
    }
    if (leadIdx !== -1) {
      leadMatchMethod = 'name_review';
      console.log(`[MapPack] ✓ Lead by name match: #${leadIdx + 1} "${places[leadIdx].name}" (score ${bestScore}, distinctive=[${distinctive.join(',')}])`);
    } else {
      console.warn(`[MapPack] ✗ Lead not found by name (no distinctive-token overlap for "${leadName}")`);
    }
  }

  const leadPos         = leadIdx !== -1 ? leadIdx + 1 : 99;
  const leadPlaceResult = leadIdx !== -1 ? places[leadIdx] : null;

  // ── Find competitor ──────────────────────────────────────────────────────────
  const targetRank = pickCompetitorRank(leadPos);
  console.log(`[MapPack] Lead rank #${leadPos} → competitor target rank #${targetRank}`);

  const isExcluded = (p: PlaceResult) =>
    excludedBrands.some(b => p.name.toLowerCase().includes(b.toLowerCase()));

  let compIdx = -1, validCount = 0, lastValidIdx = -1;
  for (let i = 0; i < places.length; i++) {
    // Exclude lead by index (reliable) AND by place_id when both have one (extra safety).
    // Avoid place_id-only check: local_finder items often have place_id='' which would
    // match every other empty-id item and skip the entire list.
    if (i === leadIdx) continue;
    if (leadPlaceResult?.place_id && places[i].place_id === leadPlaceResult.place_id) continue;
    if (isExcluded(places[i])) continue;
    validCount++;
    lastValidIdx = i;
    if (validCount === targetRank) { compIdx = i; break; }
  }
  if (compIdx === -1) compIdx = lastValidIdx;

  if (compIdx === -1) {
    console.error(`[MapPack] No competitor found for "${vertical} ${city}"`);
    return null;
  }

  const compPlace = places[compIdx];
  const compPos   = compIdx + 1;

  console.log(`[MapPack] ✓ Competitor rank #${compPos}: "${compPlace.name}" reviews:${compPlace.user_ratings_total} rating:${compPlace.rating}`);

  const toGbpUrl = (pid: string) => `https://www.google.com/maps/place/?q=place_id:${pid}`;

  // DFS local_finder (the primary source) frequently returns place_id='' for every
  // entry. The lead's real place_id is already known (passed in as leadPlaceId);
  // resolve a real place_id for the competitor via a Places API name search so the
  // report has a working, verifiable Maps link/domain/phone for them.
  const leadActualPid = leadPlaceResult?.place_id || leadPlaceId;

  let compPlaceId = compPlace.place_id;
  if (!compPlaceId) {
    const found = await searchPlaces(`${compPlace.name} ${city} ${state}`, coords ?? undefined);
    compPlaceId = found.find(p => p.name.toLowerCase() === compPlace.name.toLowerCase())?.place_id
      || found[0]?.place_id || '';
    if (compPlaceId) compPlace.place_id = compPlaceId;
  }

  // Competitor website
  let compDomain = '';
  if (compPlaceId) {
    try {
      const website = await placeWebsite(compPlaceId);
      if (website) compDomain = new URL(website).hostname.replace('www.', '');
    } catch { }
  }

  // fullPack: top-5 slots always including lead + competitor.
  // Identify by object reference, not place_id — DFS results frequently have empty
  // place_id for every entry, which broke both the isLead/isCompetitor flags and the
  // "always include lead + competitor" guarantee whenever they ranked outside top-5.
  const mustItems = [leadPlaceResult, compPlace].filter((p, i, arr) =>
    p && arr.indexOf(p) === i
  ) as PlaceResult[];
  const fillers = places
    .filter(p => !mustItems.includes(p))
    .slice(0, Math.max(0, 5 - mustItems.length));
  const packPlaces = [...mustItems, ...fillers].sort((a, b) => places.indexOf(a) - places.indexOf(b));

  // The scraped Maps list view sometimes omits review counts — enrich the
  // report-visible entries via Places API and write back to the cache so the
  // lookups aren't repeated on the next hit.
  const toEnrich = packPlaces.filter(p => p.place_id && (!p.user_ratings_total || !p.rating));
  if (toEnrich.length) {
    await Promise.all(toEnrich.map(async p => {
      const rc = await placeRatingCount(p.place_id);
      if (rc) { p.rating = rc.rating; p.user_ratings_total = rc.count; }
    }));
    db.prepare(`UPDATE mappack_cache SET items_json=? WHERE keyword=? AND city=? AND state=?`)
      .run(JSON.stringify({ checkUrl, places }), cacheKey, city, state);
  }

  const fullPack = packPlaces.map(place => {
    const pid = place === leadPlaceResult ? leadActualPid
      : place === compPlace ? compPlaceId
      : place.place_id;
    return {
      position:     places.indexOf(place) + 1,
      name:         place.name,
      rating:       place.rating,
      review_count: place.user_ratings_total,
      place_id:     pid || null,
      gbp_url:      pid ? toGbpUrl(pid) : null,
      isLead:       place === leadPlaceResult,
      isCompetitor: place === compPlace,
    };
  });

  const competitor = {
    name:         compPlace.name,
    rating:       compPlace.rating,
    review_count: compPlace.user_ratings_total,
    position:     compPos,
    domain:       compDomain,
    place_id:     compPlaceId,
    gbp_url:      compPlaceId ? toGbpUrl(compPlaceId) : null,
  };

  const inPack = leadPos <= 3 ? ' ✓ IN TOP-3 MAP PACK' : leadPos <= 10 ? ' (top 10)' : '';
  console.log(`[MapPack] Google Maps rank: #${leadPos}${inPack} for "${vertical} ${city}" (source: ${dataSource})`);

  // Prefer the source's own location-pinned URL (Maps scrape URL or DFS check_url —
  // reproduces the exact scraped SERP); fall back to a plain Google URL for the surface.
  const verificationUrl = checkUrl || buildSearchUrl(vertical, city, matchType);
  const lead = {
    found:        leadIdx !== -1,
    matchMethod:  leadMatchMethod,
    name:         leadPlaceResult?.name ?? leadName,
    rating:       leadPlaceResult?.rating ?? leadRating,
    review_count: leadPlaceResult?.user_ratings_total ?? leadReviewCount,
    place_id:     leadPlaceResult?.place_id || leadPlaceId || null,
  };
  const primaryMapData: MapPackResult = {
    leadPosition: leadPos, fullPack, dataSource, verificationUrl, matchType, surfaceLabel, lead, competitor,
  };
  return { primaryMapData, leadPosition: leadPos };
}

// Keep getWeightedPosition as a thin wrapper so existing callers don't break.
export async function getWeightedPosition(
  vertical: string,
  city: string,
  state: string,
  leadName: string,
  leadReviewCount: number,
  leadPlaceId: string,
  leadRating: number,
  config: MapPackConfig = {},
): Promise<{
  primaryMapData: MapPackResult;
  weightedPosition: number;
  rankingKeywords: Array<{ keyword: string; position: number | null }>;
} | null> {
  const result = await getMapPackPosition(vertical, city, state, leadName, leadReviewCount, leadPlaceId, leadRating, config);
  if (!result) return null;
  return {
    primaryMapData:  result.primaryMapData,
    weightedPosition: result.leadPosition,
    // Report the query actually sent to Google ("hvac in toledo"), not "HVAC Toledo".
    rankingKeywords: [{ keyword: `${vertical.toLowerCase()} in ${city.toLowerCase()}`, position: result.leadPosition }],
  };
}

// ─── Organic Search Position ─────────────────────────────────────────────────

export async function getOrganicPosition(
  domain: string,
  keyword: string,
  city: string,
  state: string,
): Promise<number | null> {
  if (!process.env.DATAFORSEO_LOGIN) return null;
  try {
    const fullState = await resolveStateName(city, state);
    const res = await fetchT(
      'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
      {
        method:  'POST',
        headers: { Authorization: `Basic ${dfsAuth()}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify([{
          keyword,
          location_name: `${city},${fullState},United States`,
          language_name: 'English',
          depth: 10,
        }]),
      },
      30000,
    );
    const json  = await res.json();
    const task0 = json.tasks?.[0];
    if (task0?.status_code !== 20000) {
      console.warn(`[Organic] DFS status ${task0?.status_code}: ${task0?.status_message}`);
      return null;
    }
    const items: any[] = task0?.result?.[0]?.items ?? [];
    const cleanDomain = domain.replace(/^www\./, '').toLowerCase();
    const hit = items.find((i: any) =>
      (i.domain ?? '').replace(/^www\./, '').toLowerCase() === cleanDomain ||
      (i.url ?? '').toLowerCase().includes(cleanDomain)
    );
    if (hit) {
      console.log(`[Organic] "${cleanDomain}" → organic #${hit.rank_absolute} for "${keyword}"`);
      return hit.rank_absolute ?? null;
    }
    console.log(`[Organic] "${cleanDomain}" not in top-10 organic for "${keyword}"`);
    return null;
  } catch (e: any) {
    console.warn('[Organic] error:', e.message);
    return null;
  }
}

// ─── Organic Search Snapshot (richer — for the Search page of the ARMA report) ──
// Returns each side's organic listing CONTENT (title, displayed domain, description)
// with no rank numbers — the ARMA report only shows whether a business appears on
// page one and how its listing reads, never its position, so ranks are deliberately
// not exposed here.

export interface OrganicListing {
  title: string;
  domain: string;
  description: string;
}

export interface OrganicSnapshot {
  // false → the organic SERP could not be fetched (no DFS creds / API error), so
  // "neither appears" must not be asserted. true → the SERP was read; a null listing
  // then genuinely means the business isn't on page one.
  available: boolean;
  lead: OrganicListing | null;
  competitor: OrganicListing | null;
}

export async function getOrganicSnapshot(
  leadDomain: string,
  competitorDomain: string,
  keyword: string,
  city: string,
  state: string,
): Promise<OrganicSnapshot> {
  const empty: OrganicSnapshot = { available: false, lead: null, competitor: null };
  if (!process.env.DATAFORSEO_LOGIN) return empty;
  try {
    const fullState = await resolveStateName(city, state);
    const res = await fetchT(
      'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
      {
        method:  'POST',
        headers: { Authorization: `Basic ${dfsAuth()}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify([{
          keyword,
          location_name: `${city},${fullState},United States`,
          language_name: 'English',
          depth: 20,
        }]),
      },
      30000,
    );
    const json  = await res.json();
    const task0 = json.tasks?.[0];
    if (task0?.status_code !== 20000) {
      console.warn(`[Organic] snapshot DFS status ${task0?.status_code}: ${task0?.status_message}`);
      return empty;
    }
    const items: any[] = (task0?.result?.[0]?.items ?? []).filter((i: any) => i.type === 'organic');
    const clean = (d: string) => (d ?? '').replace(/^www\./, '').toLowerCase();
    const leadD = clean(leadDomain), compD = clean(competitorDomain);
    const matches = (i: any, d: string) =>
      !!d && (clean(i.domain) === d || (i.url ?? '').toLowerCase().includes(d));

    const leadHit = items.find((i: any) => matches(i, leadD));
    const compHit = compD ? items.find((i: any) => matches(i, compD)) : null;

    console.log(`[Organic] snapshot for "${keyword}": lead "${leadD}" ${leadHit ? 'found' : 'not found'} | comp "${compD}" ${compHit ? 'found' : 'not found'}`);

    const toListing = (hit: any, fallbackDomain: string): OrganicListing => ({
      title:       hit.title ?? '',
      domain:      clean(hit.domain) || fallbackDomain,
      description: hit.description ?? hit.snippet ?? '',
    });

    return {
      available: true,
      lead:       leadHit ? toListing(leadHit, leadD) : null,
      competitor: compHit ? toListing(compHit, compD) : null,
    };
  } catch (e: any) {
    console.warn('[Organic] snapshot error:', e.message);
    return empty;
  }
}
