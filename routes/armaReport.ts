import { Router, Request, Response } from 'express';
import { asyncHandler, normalizeUrl, fetchT } from '../lib/http';
import { getLeadGBP } from '../services/gbp';
import { getMonthlyTraffic } from '../services/traffic';
import { getOrganicSnapshot } from '../services/mappack';
import { getPageSpeed } from '../services/pagespeed';
import { getBuyerIntentKeywords } from '../benchmarks';
import { generateArmaReportHTML, type ArmaReportParams } from '../report/armaHtml';
import { isUrgentVertical, calcArmaLoss } from '../report/armaLogic';
import { renderPDF } from '../report/pdf';

const router = Router();

// Rough "how many of your reviews are surfaced on the homepage" check. A plain HTML
// fetch (no Puppeteer): 0 when no live-review widget or testimonial cards are found —
// the common case this report calls out — otherwise a small representative count.
async function countHomepageReviews(url: string): Promise<number> {
  try {
    const res = await fetchT(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ARMA-Audit/1.0)' } }, 12000);
    if (!res.ok) return 0;
    const html = (await res.text()).toLowerCase();
    const hasWidget = /elfsight|embedsocial|trustindex|sociablekit|reviewsonmywebsite|shapo|featurable|data-google-reviews|reviews?-widget|widget-reviews?/.test(html);
    const cards = (html.match(/class="[^"]*(testimonial|review-card|review-item|review_item|review-box)[^"]*"/g) ?? []).length;
    if (hasWidget) return Math.max(cards, 3);
    return cards;
  } catch {
    return 0;
  }
}

// Domain + a readable name guess derived straight from a URL — used for both the lead
// and the manually supplied competitor so their GBP lookups are symmetric.
function deriveBizIdentity(url: string): { domain: string; nameGuess: string } {
  const domain = new URL(url).hostname.replace('www.', '');
  return { domain, nameGuess: domain.split('.')[0].replace(/-/g, ' ') };
}

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const {
    url: rawUrl, city, state, vertical, format,
    competitor_url: rawCompetitorUrl, competitor_position: rawCompetitorPosition,
  } = req.body;
  if (!rawUrl || !city || !state || !rawCompetitorUrl) {
    return res.status(400).json({ error: 'url, city, state, competitor_url required' });
  }

  const url          = normalizeUrl(rawUrl);
  const competitorUrl = normalizeUrl(rawCompetitorUrl);
  const niche         = vertical || 'Home Services';
  // Manually supplied — context only (e.g. "ranked #2 on Google Maps"). Never fetched,
  // never paired against a lead-side rank, never used in the loss calculation.
  const competitorPosition =
    typeof rawCompetitorPosition === 'number' && Number.isFinite(rawCompetitorPosition) && rawCompetitorPosition > 0
      ? Math.round(rawCompetitorPosition)
      : null;

  const { domain, nameGuess: bizName }         = deriveBizIdentity(url);
  const { domain: compDomain, nameGuess: compBizName } = deriveBizIdentity(competitorUrl);

  const [gbp, compGbp, traffic] = await Promise.all([
    getLeadGBP(bizName, city, state, domain),
    getLeadGBP(compBizName, city, state, compDomain),
    getMonthlyTraffic(domain),
  ]);

  const realName       = gbp.real_name && gbp.real_name.length > 2 ? gbp.real_name : bizName;
  const competitorName  = compGbp.real_name && compGbp.real_name.length > 2 ? compGbp.real_name : compBizName;

  // Buyer-intent phrasing for the organic search mockup.
  const kws          = getBuyerIntentKeywords(niche);
  const organicQuery = `${kws[0]} ${city}`;

  const [speedLead, speedComp, organic, reviewsShownOnHome] = await Promise.all([
    getPageSpeed(url, 'mobile').catch(() => ({ score: null })),
    getPageSpeed(competitorUrl, 'mobile').catch(() => ({ score: null })),
    getOrganicSnapshot(domain, compDomain, organicQuery, city, state).catch(() => ({ available: false, lead: null, competitor: null })),
    countHomepageReviews(url),
  ]);

  const leadSpeed = (speedLead as any).score ?? null;
  const compSpeed = (speedComp as any).score ?? null;

  // Which of the two measurable steps are genuine gaps for THIS business — drives both
  // the copy and which steps carry a dollar loss. No invented gaps. Map/search ranking
  // is no longer computed (competitor is manual, no Google Maps/DataForSEO ranking
  // lookup is performed), so only Trust and Speed carry a loss figure.
  const activeGaps = {
    trust: !(gbp.review_count > compGbp.review_count && gbp.rating >= compGbp.rating && reviewsShownOnHome > 0),
    speed: leadSpeed != null && (leadSpeed < 80 || (compSpeed != null && leadSpeed < compSpeed)),
  };

  const loss = calcArmaLoss({
    traffic: traffic || 200,
    vertical: niche,
    faster: leadSpeed != null && compSpeed != null && leadSpeed >= compSpeed,
  });

  const params: ArmaReportParams = {
    date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase(),
    city, state, vertical: niche,
    organicQuery,
    lead: {
      name:               realName,
      rating:             gbp.rating,
      reviews:            gbp.review_count,
      domain,
      speed:              leadSpeed,
      reviewsShownOnHome,
    },
    competitor: {
      name:               competitorName,
      rating:             compGbp.rating,
      reviews:            compGbp.review_count,
      domain:             compDomain,
      speed:              compSpeed,
      title:              organic.competitor?.title ?? '',
      description:        organic.competitor?.description ?? '',
      position:           competitorPosition,
    },
    isUrgent:                     isUrgentVertical(niche),
    organicAvailable:             organic.available,
    leadAppearsOrganically:       organic.available && !!organic.lead,
    competitorAppearsOrganically: organic.available && !!organic.competitor,
    activeGaps,
    totalLoss: loss.total,
    gaps: {
      trust: loss.rows.rating,
      speed: loss.rows.speed,
    },
  };

  if (format === 'json' || req.query.format === 'json') return res.json(params);

  const html = generateArmaReportHTML(params);
  const pdf  = await renderPDF(html);
  res.contentType('application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ARMA_Report_${domain}.pdf"`);
  res.send(pdf);
}));

export default router;
