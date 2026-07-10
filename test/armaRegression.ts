// test/armaRegression.ts — ARMA report regression suite.
//
// The report moved from an auto-selected competitor (picked by Google Maps/DataForSEO
// ranking) to a manually supplied competitor_url. As a result the report no longer
// computes or shows any ranking/position data: there is no Discovery (map box) page,
// and the Search page compares listing CONTENT only (title/description), never rank
// numbers. This suite locks the current 5-page structure (Cover, Trust, Search, Speed,
// Next Move) and the specific report-logic guards that remain relevant (PageSpeed N/A
// handling, organic-presence states, vertical-aware wording).
//
// Run:  npx ts-node test/armaRegression.ts          (structural + copy checks)
//       npx ts-node test/armaRegression.ts --pdf     (also render a real PDF)

import { generateArmaReportHTML, type ArmaReportParams } from '../report/armaHtml';
import { isUrgentVertical } from '../report/armaLogic';

const BASELINE_PAGE_COUNT = 5;

let failures = 0;
let checks = 0;
function ok(cond: boolean, msg: string) {
  checks++;
  if (!cond) { failures++; console.error(`  ✗ ${msg}`); }
}
const has  = (h: string, s: string) => h.includes(s);
const pageCount = (h: string) => (h.match(/<section class="page">/g) || []).length;

// ─── Reference scenario ────────────────────────────────────────────────────────
const reference: ArmaReportParams = {
  date: 'MAY 11, 2026',
  city: 'Bronx', state: 'NY', vertical: 'Plumbing',
  organicQuery: 'plumber Bronx',
  lead: {
    name: 'Empire Sewer and Water', rating: 4.8, reviews: 182,
    domain: 'empireplumbers.com', speed: 41, reviewsShownOnHome: 0,
  },
  competitor: {
    name: 'Bronx Plumbing Pros', rating: 4.6, reviews: 89,
    domain: 'bronxplumbingpros.com', speed: 88,
    title: 'Bronx Plumbing Pros — 24/7 Emergency Plumbing',
    description: 'Same-day service across the Bronx. Licensed & insured...',
    position: null,
  },
  isUrgent: true,
  organicAvailable: true,
  leadAppearsOrganically: false,
  competitorAppearsOrganically: true,
  activeGaps: { trust: true, speed: true },
  totalLoss: [1270, 2358],
  gaps: { trust: [635, 1179], speed: [635, 1179] },
};

// Deep-clone helper so scenarios don't mutate the reference.
const clone = (o: ArmaReportParams): ArmaReportParams => JSON.parse(JSON.stringify(o));

// ─── 1. Reference fidelity (layout, copy, CTA design baseline) ────────────────
function testReferenceBaseline() {
  console.log('• Reference baseline (structure + copy)');
  const h = generateArmaReportHTML(reference);

  ok(pageCount(h) === BASELINE_PAGE_COUNT, `renders exactly ${BASELINE_PAGE_COUNT} pages (got ${pageCount(h)})`);

  // No ranking/position data anywhere in the document.
  ok(!has(h, 'MAP BOX') && !/RESULT #\d/.test(h) && !/#\d+ IN THE/.test(h), 'no ranking/position copy present');

  // Cover
  ok(has(h, 'STRONG REVIEWS.') && has(h, 'HIDDEN GAPS.') && has(h, 'MONEY LEFT BEHIND.'), 'cover headline reflects the lead having more reviews');
  ok(has(h, '$1,270–$2,358'), 'cover total-loss range (en-dash) matches reference');
  ok(has(h, '182') && has(h, '89'), 'cover review counts present');
  ok(has(h, '41/100'), 'cover shows the lead PageSpeed score, not a map position');
  // Trust — lead has more reviews than the manual competitor here.
  ok(has(h, 'YOU EARNED IT. NOW') && has(h, 'PROTECT IT.'), 'trust headline matches lead-ahead-on-reviews branch');
  // Search
  ok(has(h, 'MISSING WHERE THEY') && has(h, 'SHOW UP.'), 'search headline matches competitor-only-visible branch');
  ok(has(h, "BRONX PLUMBING PROS'S LISTING"), 'search shows competitor listing content, no rank number');
  // Speed
  ok(has(h, "EMERGENCIES DON'T") && has(h, 'WAIT.'), 'speed headline matches reference (urgent)');
  ok(has(h, 'SLOW ON MOBILE — RISKY IN AN EMERGENCY'), 'speed slow caption (urgent) present');
  // CTA — the design details the reference locks in.
  ok(has(h, 'DO IT YOURSELF') && has(h, 'GET THE FULL PLAN'), 'CTA options present');
  ok(has(h, 'BOOK YOUR 20-MIN ZOOM'), 'CTA button label present');
  ok(has(h, '.way-hot{background:var(--ink)'), 'recommended card is BLACK (reference)');
  ok(has(h, '.cta-btn{background:var(--red)'), 'CTA button is RED (reference)');
  ok(!has(h, 'ranked #'), 'no competitor rank shown when competitor_position is not supplied');
}

// ─── 2. Manually supplied competitor rank — context label only ────────────────
function testCompetitorPositionContext() {
  console.log('• Competitor rank — manual context label, no lead-side rank, no loss change');
  const p = clone(reference);
  p.competitor.position = 2;
  const h = generateArmaReportHTML(p);
  ok(has(h, 'ranked #2 on Google Maps'), 'cover shows the manually supplied competitor rank as context');
  ok(!/RESULT #\d/.test(h) && !has(h, 'MAP BOX'), 'still no ranking analysis/sections beyond the single context label');
  ok(h.split('ranked #2 on Google Maps').length - 1 === 1, 'the rank label appears exactly once (context only, not sprinkled)');
}

// ─── 3. Trust page — fewer reviews than the manual competitor ─────────────────
function testTrustBehindOnReviews() {
  console.log('• Trust — lead has fewer reviews than the manual competitor');
  const p = clone(reference);
  p.lead.reviews = 60; p.competitor.reviews = 89; // fewer reviews than competitor
  p.activeGaps.trust = true; p.gaps.trust = [635, 1179];
  const h = generateArmaReportHTML(p);
  ok(has(h, 'THEY HAVE THE') && has(h, 'PROOF.'), 'trust headline switches to "they have the proof" framing');
  ok(has(h, 'EST. MONTHLY LOSS'), 'loss banner shown when behind on reviews');
}

// ─── 4. PageSpeed N/A — no positive/negative claim, no speed loss ─────────────
function testSpeedUnavailable() {
  console.log('• PageSpeed N/A — neutral, no loss');
  const p = clone(reference);
  p.lead.speed = null;
  p.activeGaps.speed = false; p.gaps.speed = [0, 0]; // route assigns no loss when speed is null
  const h = generateArmaReportHTML(p);
  ok(has(h, 'MANUAL SPEED CHECK NEEDED'), 'shows "manual speed check needed"');
  ok(has(h, 'Mobile speed not measured'), 'neutral (not-measured) banner shown');
  ok(!has(h, 'Your mobile speed holds up — no loss on this surface.'), 'does NOT claim speed "holds up" when unmeasured');
  ok(has(h, 'assigning no speed loss'), 'states no speed loss assigned');
  ok(has(h, '>N/A<'), 'score renders as N/A');
}

// ─── 5. Organic-visibility states are distinct (presence only, no ranks) ──────
function testOrganicStates() {
  console.log('• Organic search — four distinct presence states');

  // (a) data unavailable
  const a = clone(reference);
  a.organicAvailable = false; a.leadAppearsOrganically = false; a.competitorAppearsOrganically = false;
  const ha = generateArmaReportHTML(a);
  ok(has(ha, 'SEARCH VISIBILITY') && has(ha, 'PENDING.'), '(a) unavailable → "search visibility pending"');
  ok(has(ha, 'Organic visibility not measured'), '(a) unavailable → neutral banner, no loss');
  ok(!has(ha, 'MISSING WHERE'), '(a) unavailable does not fall through to a presence claim');

  // (b) competitor appears, lead doesn't (the reference case)
  ok(has(generateArmaReportHTML(reference), 'MISSING WHERE THEY'), '(b) competitor-only → "missing where they show up"');

  // (c) lead appears, competitor doesn't
  const c = clone(reference);
  c.leadAppearsOrganically = true; c.competitorAppearsOrganically = false;
  const hc = generateArmaReportHTML(c);
  ok(has(hc, 'ONE PLACE YOU') && has(hc, 'SHOW UP.'), '(c) lead-only → "one place you show up"');
  ok(has(hc, "doesn't — no loss") || has(hc, 'no loss on this surface'), '(c) lead-only → win banner, no loss');

  // (d) both appear
  const d = clone(reference);
  d.leadAppearsOrganically = true; d.competitorAppearsOrganically = true;
  const hd = generateArmaReportHTML(d);
  ok(has(hd, 'BOTH ON THE') && has(hd, 'PAGE.'), '(d) both → "both on the page"');
  ok(has(hd, 'Both businesses appear on page one'), '(d) both → neutral/no-loss framing, content-only comparison');

  // (e) neither appears
  const e = clone(reference);
  e.leadAppearsOrganically = false; e.competitorAppearsOrganically = false;
  const he = generateArmaReportHTML(e);
  ok(has(he, 'HARD TO') && has(he, 'FIND.'), '(e) neither → "hard to find"');
  ok(has(he, 'Neither business shows up on page one'), '(e) neither → neutral banner, no loss');
}

// ─── 6. Vertical-aware wording ────────────────────────────────────────────────
function testVerticalWording() {
  console.log('• Vertical-aware wording (urgent vs non-urgent)');
  // Urgent → emergency language (covered by reference), verify again explicitly.
  ok(has(generateArmaReportHTML(reference), "EMERGENCIES DON'T"), 'urgent vertical uses emergency headline');

  // Non-urgent (e.g. Painting) → quote/estimate language, no "emergency".
  const p = clone(reference);
  p.vertical = 'Painting'; p.isUrgent = false;
  p.organicQuery = 'painting contractor Bronx';
  const h = generateArmaReportHTML(p);
  ok(!has(h, "EMERGENCIES DON'T"), 'non-urgent vertical drops the emergency headline');
  ok(has(h, 'QUOTE.'), 'non-urgent vertical uses quote/estimate headline');
  ok(has(h, 'pricing painting') || has(h, 'comparing') || has(h, 'quotes'), 'non-urgent uses "comparing quotes" framing');
  // The slow caption should be quote-oriented if the score is low.
  const slow = clone(p); slow.lead.speed = 40;
  ok(has(generateArmaReportHTML(slow), 'BEFORE THE QUOTE'), 'non-urgent slow caption is quote-oriented');

  ok(isUrgentVertical('Plumbing') && isUrgentVertical('plumber'), 'plumbing is urgent');
  ok(isUrgentVertical('HVAC') && isUrgentVertical('Roofing') && isUrgentVertical('Electrical'), 'hvac/roofing/electrical urgent');
  ok(!isUrgentVertical('Insulation Contractors'), 'insulation is NOT urgent');
  ok(!isUrgentVertical('Painting') && !isUrgentVertical('Kitchen Remodeling'), 'painting/remodeling NOT urgent');
}

// ─── Optional: render a real PDF and sanity-check it ───────────────────────────
async function testPdfRender() {
  console.log('• PDF render (real Chromium)');
  const { renderPDF } = await import('../report/pdf');
  const pdf = await renderPDF(generateArmaReportHTML(reference));
  ok(pdf.subarray(0, 5).toString() === '%PDF-', 'output is a valid PDF');
  ok(pdf.length > 15000, `PDF is non-trivial in size (${pdf.length} bytes)`);
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  ok(pages === 0 || pages === BASELINE_PAGE_COUNT, `PDF page count matches baseline where detectable (found ${pages})`);
}

async function main() {
  console.log(`\nARMA report regression — manual-competitor baseline (${BASELINE_PAGE_COUNT} pages)\n`);
  testReferenceBaseline();
  testCompetitorPositionContext();
  testTrustBehindOnReviews();
  testSpeedUnavailable();
  testOrganicStates();
  testVerticalWording();
  if (process.argv.includes('--pdf')) await testPdfRender();

  console.log(`\n${failures === 0 ? '✓ PASS' : '✗ FAIL'} — ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('Regression harness crashed:', e); process.exit(1); });
