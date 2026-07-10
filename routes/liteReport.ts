import { Router, Request, Response } from 'express';
import { asyncHandler, normalizeUrl, fetchPageText } from '../lib/http';
import { getLeadGBP, getGBPReviewInsights, getGBPPostsPerWeek, getPlacePhone } from '../services/gbp';
import { getMonthlyTraffic } from '../services/traffic';
import { getWeightedPosition, getOrganicPosition, type MatchType } from '../services/mappack';
import { getBuyerIntentKeywords, findBenchmark, calculateRevenueLoss } from '../benchmarks';
import { generateColdEmail, extractLeadInsights } from '../analysis/claude';
import { generateLiteReportHTML } from '../report/liteHtml';
import { renderPDF } from '../report/pdf';
import db from '../db';

const router = Router();

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { url: rawUrl, city, state, vertical, format, matchType: rawMatchType, lat, lng } = req.body;
  if (!rawUrl || !city || !state) return res.status(400).json({ error: "url, city, state required" });
  const url = normalizeUrl(rawUrl);

  // Which Google surface to match against (UI selector). Defaults to Maps.
  const matchType: MatchType =
    rawMatchType === 'place' || rawMatchType === 'business' || rawMatchType === 'map' ? rawMatchType : 'map';
  // Optional live location (UI geolocation) — pins Search-surface rankings to the
  // searcher's exact point so the report matches what they personally see.
  const userLocation =
    typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat, lng }
      : undefined;

  const domain = new URL(url).hostname.replace('www.', '');
  const bizName = domain.split('.')[0].replace(/-/g, ' ');
  const niche = vertical || "Home Services";

  const [gbp, traffic] = await Promise.all([
    getLeadGBP(bizName, city, state, domain),
    getMonthlyTraffic(domain),
  ]);

  const matchName   = gbp.real_name && gbp.real_name.length > 2 ? gbp.real_name : bizName;

  // The MARKET being audited = exactly what the user searched (e.g. "Rossford, OH"). The
  // map-pack ranking, organic position, report copy and cold email are all ABOUT this market,
  // so it must match the manual Google search the user runs. We deliberately do NOT substitute
  // the lead's GBP-registered city here: a business registered in neighbouring Perrysburg can
  // still be audited for the Rossford market, and silently swapping the city made the API rank
  // a different town than the one the user searched — the root cause of the position gap.
  const marketCity  = city;
  const marketState = state;

  // The lead's own GBP-registered location — used ONLY for business-specific GBP enrichment
  // (reviews, posts), which must look the business up where it actually operates.
  const gbpCity  = (gbp as any).gbp_city  && (gbp as any).gbp_city.length  > 1 ? (gbp as any).gbp_city  : city;
  const gbpState = (gbp as any).gbp_state && (gbp as any).gbp_state.length > 1 ? (gbp as any).gbp_state : state;
  if (gbpCity.toLowerCase() !== marketCity.toLowerCase())
    console.log(`[LiteReport] Lead's GBP city is "${gbpCity}, ${gbpState}" — auditing the SUBMITTED market "${marketCity}, ${marketState}" to match the manual search.`);

  // Always fetch fresh competitor + positions from real Google APIs.
  // The full report reads competitor fields from the DB row written here, so lite→full is consistent.
  const weighted = await getWeightedPosition(
    niche, marketCity, marketState, matchName, gbp.review_count, gbp.place_id, gbp.rating,
    { matchType, userLocation }
  );

  if (!weighted) return res.status(502).json({
    error: "Could not fetch map pack rankings. Check DATAFORSEO_LOGIN/PASSWORD (primary) and GOOGLE_PLACES_API_KEY (fallback). See server logs for the exact failure.",
    keywords_tried: getBuyerIntentKeywords(niche),
    search_location: `${marketCity}, ${marketState}`,
  });

  const { primaryMapData, weightedPosition, rankingKeywords } = weighted;
  const competitor = primaryMapData.competitor;

  console.log(`[LiteReport] Competitor: "${competitor.name}" #${competitor.position} · ${competitor.rating}★ · ${competitor.review_count} reviews (source: ${primaryMapData.dataSource})`);

  // The rank was measured on the surface the user selected (map/place/business). Label all
  // copy to match that surface so a client verifying on a *different* one isn't misled
  // (these surfaces are ranked independently — see report/liteHtml.ts).
  const surfaceLabel = primaryMapData.surfaceLabel;

  // Safeguard: a real local business almost always appears somewhere in the top-20 for its
  // own category. If the lead isn't found at all, the vertical is probably wrong for this
  // business (e.g. an insulation company audited under the wrong niche) — flag it loudly so
  // the report isn't sent as a bogus "you're invisible" before someone double-checks.
  const leadNotFound = weightedPosition >= 99;
  if (leadNotFound)
    console.warn(`[LiteReport] ⚠ "${matchName}" NOT FOUND in the "${niche} in ${marketCity}" pack (rank >20). If this business clearly operates in ${marketCity}, the vertical "${niche}" is likely wrong — verify the category before sending this report.`);

  const { key: niche_matched } = findBenchmark(niche);
  const revenue     = calculateRevenueLoss(traffic || 200, niche);
  const realName    = gbp.real_name && gbp.real_name.length > 2 ? gbp.real_name : bizName;
  const leadPhone   = (gbp as any).phone   || '';
  const leadAddress = (gbp as any).address || '';

  const compUrl = competitor.domain ? `https://${competitor.domain}` : null;

  const primaryKw = rankingKeywords[0]?.keyword ?? niche.toLowerCase();

  // Parallel: lead review insights, GBP posts, lead page text, competitor phone, competitor page text, organic position
  const [reviewInsights, gbpPostsPerWeek, leadPageText, competitorPhone, compPageText, organicPosition] = await Promise.all([
    // GBP enrichment looks the business up where it actually operates → GBP city.
    getGBPReviewInsights(gbp.place_id, matchName, gbpCity, gbpState).catch(() => null),
    getGBPPostsPerWeek(realName, gbpCity, gbpState, gbp.place_id).catch(() => null),
    fetchPageText(url).catch(() => ''),
    getPlacePhone(competitor.place_id).catch(() => ''),
    compUrl ? fetchPageText(compUrl).catch(() => '') : Promise.resolve(''),
    // Organic rank is about the audited market. primaryKw already ends in "in <city>", so
    // pass it as-is — appending " in <city>" again produced "... in rossford in Rossford".
    getOrganicPosition(domain, primaryKw, marketCity, marketState).catch(() => null),
  ]);

  // Claude Haiku extracts owner + service area from homepage text for BOTH lead and competitor
  const [leadInsights, compInsights] = await Promise.all([
    extractLeadInsights(leadPageText, marketCity, marketState).catch(() => ({ owner: '', serviceArea: 'Not clearly specified' })),
    extractLeadInsights(compPageText, marketCity, marketState).catch(() => ({ owner: '', serviceArea: 'Not clearly specified' })),
  ]);

  const lead = {
    name:                realName,
    rating:              gbp.rating,
    review_count:        gbp.review_count,
    place_id:            gbp.place_id,
    gbp_url:             gbp.place_id ? `https://www.google.com/maps/place/?q=place_id:${gbp.place_id}` : null,
    position:            weightedPosition,
    organic_position:    organicPosition ?? null,
    position_by_keyword: rankingKeywords,
    phone:               leadPhone,
    address:             leadAddress,
    owner:               leadInsights.owner,
    service_area:        leadInsights.serviceArea,
  };

  const competitorFull = {
    ...competitor,
    phone:        competitorPhone,
    owner:        compInsights.owner,
    service_area: compInsights.serviceArea,
    gbp_url:      competitor.place_id
      ? `https://www.google.com/maps/place/?q=place_id:${competitor.place_id}`
      : null,
  };

  const coldEmail = await generateColdEmail({
    leadName:           realName,
    city:               marketCity,
    state:              marketState,
    vertical:           niche,
    leadPosition:       weightedPosition,
    leadReviews:        gbp.review_count,
    leadRating:         gbp.rating,
    competitorName:     competitor.name,
    competitorPosition: competitor.position,
    competitorReviews:  competitor.review_count,
    monthlyLoss:        revenue.monthly_loss,
    reviewInsights,
    gbpPostsPerWeek,
  }).catch(() => ({
    subject: `${realName} — quick visibility check for ${marketCity}`,
    body: weightedPosition === 1
      ? `${realName} holds the #1 spot on Google Maps for '${niche}' in ${marketCity} right now — but ${competitor.name} is right behind at #${competitor.position} with ${competitor.review_count} reviews vs your ${gbp.review_count}. One algorithm update or review push from them and that position flips. I put together a short brief on what's protecting your lead — and what's not. Reply and I'll send the full breakdown.`
      : `I ran a quick Google Maps check on ${realName} and found you at #${weightedPosition} while ${competitor.name} holds #${competitor.position} — a gap worth roughly $${revenue.monthly_loss.toLocaleString()}/month in missed calls. I put together a short brief with the numbers (attached). If you'd like the full audit with the exact steps to close that gap, just reply and I'll send it over.`,
  }));

  const liteReport = {
    domain, city: marketCity, state: marketState, vertical: niche, niche_matched,
    search_location: `${marketCity}, ${marketState}`,
    lead,
    competitor: competitorFull,
    fullPack: primaryMapData.fullPack,
    traffic_monthly: traffic,
    revenue,
    review_insights: reviewInsights
      ? { ...reviewInsights, snippets: reviewInsights.snippets.slice(0, 3) }
      : null,
    position_data_source: primaryMapData.dataSource,
    match_type:           matchType,
    surface_label:        surfaceLabel,
    used_live_location:   !!userLocation,
    ranking_method:       "google_maps_snapshot",
    ranking_keywords:     rankingKeywords,
    verification_url:     primaryMapData.verificationUrl,
    ...(leadNotFound ? { data_quality_warning: `"${matchName}" was not found in the top-20 for "${niche} in ${marketCity}". The vertical is likely wrong for this business — verify the category before sending.` } : {}),
    gap_summary: `${realName} at #${weightedPosition > 20 ? '>20' : weightedPosition} vs ${competitor.name} at #${competitor.position} in ${marketCity} (live ${surfaceLabel} snapshot — open verification_url to see the exact same search; Maps and the local pack in Google Search rank separately and shift with time/searcher location).`,
    cold_email: coldEmail,
  };

  // Persist to DB — the full report reads competitor_* fields from this row for consistency
  db.prepare(`INSERT OR REPLACE INTO leads
    (domain,business_name,city,state,vertical,niche_matched,primary_keyword,
    lead_gbp_rating,lead_review_count,lead_map_position,lead_gbp_place_id,
    competitor_name,competitor_domain,competitor_gbp_id,competitor_rating,competitor_review_count,competitor_position,
    traffic_monthly,lite_report_data,lite_report_generated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(domain, realName, marketCity, marketState, niche, niche_matched,
      rankingKeywords.map(k => k.keyword).join(', '),
      gbp.rating, gbp.review_count, weightedPosition, gbp.place_id,
      competitor.name, competitor.domain, competitor.place_id,
      competitor.rating, competitor.review_count, competitor.position,
      traffic, JSON.stringify(liteReport));

  // ?format=json returns the raw JSON for debugging / API consumers
  if (format === 'json' || req.query.format === 'json') {
    return res.json(liteReport);
  }

  const html = generateLiteReportHTML({
    lead,
    competitor: competitorFull,
    city:       marketCity,
    state:      marketState,
    vertical:   niche,
    revenue,
    fullPack:   primaryMapData.fullPack,
    rankingKeywords,
    verificationUrl: primaryMapData.verificationUrl,
    surfaceLabel,
    coldEmail,
  });

  const pdf = await renderPDF(html);
  res.contentType('application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ARMA_LiteCheck_${domain}.pdf"`);
  res.send(pdf);
}));

export default router;
