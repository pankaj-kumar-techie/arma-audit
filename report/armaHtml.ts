// report/armaHtml.ts — ARMA "Website Report" (5-page editorial briefing).
// Reproduces the ARMA Report Reference layout, but every claim is driven by the
// live data passed in — the narrative adapts so the copy never contradicts the
// numbers on the page (e.g. it won't say "you have more reviews" when you don't).
//
// The competitor is supplied manually (competitor_url) rather than auto-selected by
// Google Maps/DataForSEO ranking, so the report carries no ranking or position data:
// there is no Discovery (map box) page, and the Search page compares listing CONTENT
// only — never rank numbers.

const esc = (s: any) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numWord = (n: number) => NUMBER_WORDS[n] ?? String(n);

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
// En-dash range to match the reference typography ("$6,562–$12,187").
const moneyRange = ([lo, hi]: [number, number]) => `${money(lo)}–${money(hi)}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface ArmaReportParams {
  date: string;                 // e.g. "MAY 11, 2026"
  city: string;
  state: string;
  vertical: string;
  organicQuery: string;          // organic search query used for the Search step

  lead: {
    name: string;
    rating: number;
    reviews: number;
    domain: string;
    speed: number | null;       // mobile PageSpeed 0-100
    reviewsShownOnHome: number;
  };
  competitor: {
    name: string;
    rating: number;
    reviews: number;
    domain: string;
    speed: number | null;
    title: string;
    description: string;
    // Manually supplied Google Maps rank — context only (e.g. "ranked #2 on Google
    // Maps"). Never computed, never paired with a lead-side rank, never used for loss.
    position: number | null;
  };

  // Urgent verticals (plumbing, HVAC, roofing, …) use emergency/"they leave" copy;
  // non-urgent (painting, insulation, remodeling, …) use quote/estimate/"comparing" copy.
  isUrgent: boolean;

  // false → the organic SERP could not be read this run (distinct from "neither appears").
  organicAvailable: boolean;
  // Presence only — no rank numbers are ever computed or shown.
  leadAppearsOrganically: boolean;
  competitorAppearsOrganically: boolean;

  // Which of the two measurable journey steps are genuine gaps for THIS business.
  activeGaps: { trust: boolean; speed: boolean };

  // Conservative monthly revenue gap — total + per-step low/high split. Inactive
  // steps come through as [0, 0] (the page then shows a "no loss here" banner).
  totalLoss: [number, number];
  gaps: {
    trust: [number, number];
    speed: [number, number];
  };
}

// ─── Shared fragments ────────────────────────────────────────────────────────

const topbar = (p: ArmaReportParams, center: string) => `<div class="topbar">
    <span class="tb-l"><b class="brand">ARMA</b> · ${center}</span>
    <span class="tb-r">${p.date}</span>
  </div>`;

const footer = (p: ArmaReportParams) =>
  `<div class="foot">PREPARED FOR ${esc(p.lead.name.toUpperCase())} INC · ${esc(p.city.toUpperCase())}, ${esc(p.state.toUpperCase())} · CONSERVATIVE ESTIMATES</div>`;

const lossBanner = (range: [number, number]) => `<div class="loss">
    <span class="loss-lbl">EST. MONTHLY LOSS</span>
    <span class="loss-val">${moneyRange(range)}<span class="loss-mo">/mo</span></span>
  </div>`;

const goodBanner = (text: string) => `<div class="loss pos">
    <span class="loss-lbl pos">NO LOSS HERE</span>
    <span class="loss-good">${esc(text)}</span>
  </div>`;

// Neither a loss nor a win — used when a measurement is unavailable, so the report
// makes no positive/negative claim and assigns no dollar figure.
const neutralBanner = (text: string) => `<div class="loss neutral">
    <span class="loss-lbl neutral">NOT MEASURED</span>
    <span class="loss-good neutral">${esc(text)}</span>
  </div>`;

const stars = (rating: number) => `<span class="star">★</span> ${rating.toFixed(1)}`;

// Tidy scraped SERP descriptions: collapse the " ; " breadcrumb separators DFS
// returns into clean middots and trim trailing "Read more" cruft.
function cleanSnippet(s: string): string {
  return String(s || '')
    .replace(/\s*;\s*/g, ' · ')
    .replace(/\s*·\s*Read more\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function reviewPhrase(lead: number, comp: number): string {
  const r = comp > 0 ? lead / comp : 99;
  if (r >= 2)    return 'twice as many';
  if (r >  1.1)  return 'more';
  if (r >= 0.9)  return 'about even';
  if (r >= 0.6)  return 'fewer';
  return 'far fewer';
}

// ─── Pages ───────────────────────────────────────────────────────────────────

function coverPage(p: ArmaReportParams, cats: string[]): string {
  const { lead, competitor } = p;
  const leadMoreRev = lead.reviews > competitor.reviews;

  // Headline reflects the real dominant story. Middle line is always the red one.
  const hl: [string, string, string] = leadMoreRev
    ? ['STRONG REVIEWS.', 'HIDDEN GAPS.', 'MONEY LEFT BEHIND.']
    : ['OUT-REVIEWED.', 'LOSING TRUST.', 'LOSING JOBS.'];

  const phrase = reviewPhrase(lead.reviews, competitor.reviews);
  const reviewTail = leadMoreRev
    ? `${phrase} — the reputation is there.`
    : phrase === 'about even'
      ? `about even, but the details on the page still favor them.`
      : `${phrase} than theirs.`;

  const gapCount = cats.length;
  const speedLabel = lead.speed == null ? 'N/A' : `${lead.speed}/100`;

  return `<section class="page">
  ${topbar(p, 'WEBSITE REPORT · ' + esc(p.city.toUpperCase()) + ', ' + esc(p.state.toUpperCase()))}
  <div class="body">
    <div class="kicker">EXCLUSIVE BRIEFING FOR ${esc(lead.name.toUpperCase())} — ${esc(p.city.toUpperCase())}, ${esc(p.state.toUpperCase())}</div>
    <h1 class="hl hl-cover">${esc(hl[0])}<br><span class="red">${esc(hl[1])}</span><br>${esc(hl[2])}</h1>
    <p class="sub">We followed your customer's path — from a Google search to a phone call — against ${esc(competitor.name)}${competitor.position != null ? ` (ranked #${competitor.position} on Google Maps)` : ''}, and flagged exactly where you lose them, and what each gap costs every month.</p>

    <hr class="rule">

    <div class="section-lbl">BY THE NUMBERS</div>
    <div class="cards">
      <div class="card">
        <div class="card-num">${speedLabel}</div>
        <div class="card-desc">Your mobile PageSpeed score for ${esc(lead.domain)} — the difference between a call and a bounce.</div>
      </div>
      <div class="card">
        <div class="card-num">${lead.reviews.toLocaleString()} vs ${competitor.reviews.toLocaleString()}</div>
        <div class="card-desc">Your reviews vs ${esc(competitor.name)}'s — ${reviewTail}</div>
      </div>
      <div class="card">
        <div class="card-num">${moneyRange(p.totalLoss)}</div>
        <div class="card-desc">Estimated revenue slipping away every month, across ${numWord(gapCount)} fixable ${gapCount === 1 ? 'gap' : 'gaps'}.</div>
      </div>
      <div class="card">
        <div class="card-num">${gapCount} ${gapCount === 1 ? 'gap' : 'gaps'}</div>
        <div class="card-desc">${cats.length ? cap(cats.join(', ')) : 'None open right now'} — measured against ${esc(competitor.name)}.</div>
      </div>
    </div>
  </div>
  ${footer(p)}
</section>`;
}

function trustPage(p: ArmaReportParams): string {
  const { lead, competitor } = p;
  const max = Math.max(lead.reviews, competitor.reviews, 1);
  const leadW = Math.round((lead.reviews / max) * 100);
  const compW = Math.round((competitor.reviews / max) * 100);
  const leadMoreRev = lead.reviews >= competitor.reviews;

  let head: string, sub: string, callout: string;
  if (leadMoreRev) {
    const ratingClause =
      lead.rating > competitor.rating ? ' — and a higher rating' :
      Math.abs(lead.rating - competitor.rating) < 0.05 ? ' — and matched their rating' : '';
    head = `YOU EARNED IT. NOW <span class="red">PROTECT IT.</span>`;
    sub = `You've collected more reviews than ${esc(competitor.name)}${ratingClause}. The reputation is there — now it needs to be the first thing a visitor sees.`;
    callout = `<b>On your homepage right now: ${lead.reviewsShownOnHome} of ${lead.reviews.toLocaleString()} reviews are shown.</b> The reputation is already won — what's left is making sure every visitor sees the proof before they decide.`;
  } else {
    const behind = competitor.reviews - lead.reviews;
    head = `THEY HAVE THE <span class="red">PROOF.</span>`;
    sub = `${esc(competitor.name)} carries ${competitor.reviews.toLocaleString()} reviews to your ${lead.reviews.toLocaleString()}. Homeowners trust the bigger number — closing that gap is the fastest trust win you have.`;
    callout = `<b>You're ${behind.toLocaleString()} reviews behind ${esc(competitor.name)}.</b> Every missing review is a customer who picked proof over a coin-flip. Closing this gap is the fastest trust win you have.`;
  }

  return `<section class="page">
  ${topbar(p, 'STEP 1 OF 3 · TRUST')}
  <div class="body">
    <div class="kicker">STEP 1 · TRUST</div>
    <h2 class="hl hl-step">${head}</h2>
    <p class="sub">${sub}</p>

    <div class="panel">
      <div class="panel-head">REVIEWS COLLECTED — YOU vs ${esc(competitor.name.toUpperCase())}</div>
      <div class="panel-body">
        <div class="rev-row">
          <div class="rev-label">
            <div class="rev-name">${esc(lead.name)}</div>
            <div class="rev-stars">${stars(lead.rating)}</div>
          </div>
          <div class="rev-track">
            <div class="rev-bar ${leadMoreRev ? 'red' : 'dark'}" style="width:${leadW}%"><span>${lead.reviews.toLocaleString()}</span></div>
          </div>
        </div>
        <div class="rev-row">
          <div class="rev-label">
            <div class="rev-name">${esc(competitor.name)}</div>
            <div class="rev-stars">${stars(competitor.rating)}</div>
          </div>
          <div class="rev-track">
            <div class="rev-bar ${leadMoreRev ? 'dark' : 'red'}" style="width:${compW}%"><span>${competitor.reviews.toLocaleString()}</span></div>
          </div>
        </div>
        <div class="callout">${callout}</div>
      </div>
    </div>

    ${p.activeGaps.trust ? lossBanner(p.gaps.trust) : goodBanner('Your reviews already lead — keep the proof front and center.')}
  </div>
  ${footer(p)}
</section>`;
}

function searchPage(p: ArmaReportParams): string {
  const { lead, competitor } = p;
  const compTitle = esc(competitor.title || `${competitor.name} — ${p.vertical} in ${p.city}`);
  const compDesc  = esc(cleanSnippet(competitor.description) || `${p.vertical} services in ${p.city}. Shown when homeowners search.`);

  const compBlock = `<div class="org-block">
          <div class="org-rank">${esc(competitor.name.toUpperCase())}'S LISTING</div>
          <div class="org-url">${esc(competitor.domain)}</div>
          <div class="org-title">${compTitle}</div>
          <div class="org-desc">${compDesc}</div>
        </div>`;

  let head: string, sub: string, body: string, banner: string;

  if (!p.organicAvailable) {
    // The organic SERP couldn't be read this run — make NO visibility claim.
    head = `SEARCH VISIBILITY <span class="red">PENDING.</span>`;
    sub = `We couldn't pull the organic search results for "${esc(p.organicQuery)}" on this run, so we're not scoring this step — and no revenue loss is assigned to it. This one is worth a quick manual check.`;
    body = `<div class="org-lead">
          <div class="org-rank">ORGANIC RESULTS — NOT AVAILABLE THIS RUN</div>
          <div class="org-title">Manual check needed</div>
          <div class="org-desc">Search "${esc(p.organicQuery)}" yourself to see how ${esc(lead.name)} and ${esc(competitor.name)} show up below the map.</div>
        </div>`;
    banner = neutralBanner('Organic visibility not measured this run — manual check needed. No loss assigned here.');
  } else if (p.competitorAppearsOrganically && !p.leadAppearsOrganically) {
    // Competitor shows up in the organic results, lead doesn't.
    head = `MISSING WHERE THEY <span class="red">SHOW UP.</span>`;
    sub = `For "${esc(p.organicQuery)}", ${esc(competitor.name)} shows up in the regular search results below the map — and you don't. That's one more surface where they get seen and you don't.`;
    body = `${compBlock}
        <div class="org-lead">
          <div class="org-rank red">${esc(lead.name.toUpperCase())} — NOT ON PAGE ONE</div>
          <div class="org-url">${esc(lead.domain)}</div>
          <div class="org-title red">${esc(lead.name)}</div>
          <div class="org-desc">No organic foothold for this search. Most clicks never look past page one.</div>
        </div>`;
    banner = neutralBanner('No dollar figure assigned to this step — but it is a visibility gap worth closing.');
  } else if (p.leadAppearsOrganically && !p.competitorAppearsOrganically) {
    // Lead shows up organically, competitor doesn't — a genuine win, don't fake a gap.
    head = `ONE PLACE YOU <span class="red">SHOW UP.</span>`;
    sub = `For "${esc(p.organicQuery)}", your site appears in the regular search results and ${esc(competitor.name)}'s doesn't. It's a surface already working in your favor.`;
    body = `<div class="org-lead win">
          <div class="org-rank green">${esc(lead.name.toUpperCase())} — ON PAGE ONE</div>
          <div class="org-url">${esc(lead.domain)}</div>
          <div class="org-title green">${esc(lead.name)}</div>
          <div class="org-desc">You show up here and they don't. Hold it — and put the energy into the reviews and speed gaps instead.</div>
        </div>`;
    banner = goodBanner(`You show up here and ${competitor.name} doesn't — no loss on this surface.`);
  } else if (p.leadAppearsOrganically && p.competitorAppearsOrganically) {
    // Both appear — a content comparison, not a ranking claim.
    head = `BOTH ON THE <span class="red">PAGE.</span>`;
    sub = `You and ${esc(competitor.name)} both show up in the regular search results for "${esc(p.organicQuery)}". Here's how their listing reads — compare it against your own the next time you search this term.`;
    body = compBlock;
    banner = goodBanner('Both businesses appear on page one — no loss assigned to this surface.');
  } else {
    // Neither business appears (directories dominate) — say so honestly.
    head = `HARD TO <span class="red">FIND.</span>`;
    sub = `For "${esc(p.organicQuery)}", page one is dominated by directories — neither you nor ${esc(competitor.name)} shows up in the regular results. That's exactly why reviews and site speed matter most.`;
    body = `<div class="org-lead">
          <div class="org-rank red">NEITHER BUSINESS ON PAGE ONE</div>
          <div class="org-desc">No organic foothold for either of you on this search.</div>
        </div>`;
    banner = neutralBanner('Neither business shows up on page one — no loss assigned here.');
  }

  return `<section class="page">
  ${topbar(p, 'STEP 2 OF 3 · SEARCH')}
  <div class="body">
    <div class="kicker">STEP 2 · SEARCH</div>
    <h2 class="hl hl-step">${head}</h2>
    <p class="sub">${sub}</p>

    <div class="panel">
      <div class="searchbar"><span class="sb-ico">&#128269;</span><span>${esc(p.organicQuery)} — organic results</span></div>
      <div class="panel-body">
        ${body}
      </div>
    </div>

    ${banner}
  </div>
  ${footer(p)}
</section>`;
}

// A null score makes NO positive or negative claim — it prompts a manual check and
// the marker is hidden (not parked at 50, which reads as a real middling score).
function speedRow(name: string, score: number | null, isUrgent: boolean): string {
  const s = score == null ? null : Math.max(0, Math.min(100, score));
  const slowCap = isUrgent
    ? 'SLOW ON MOBILE — RISKY IN AN EMERGENCY'
    : 'SLOW ON MOBILE — VISITORS LEAVE BEFORE THE QUOTE';
  const midCap = isUrgent
    ? 'ROOM TO IMPROVE — SECONDS COST CALLS'
    : 'ROOM TO IMPROVE — SECONDS COST QUOTE REQUESTS';
  const caption =
    s == null ? 'MANUAL SPEED CHECK NEEDED'
    : s < 50  ? slowCap
    : s < 80  ? midCap
    :           'FAST — LOADS BEFORE THE VISITOR LEAVES';
  return `
        <div class="sp-row">
          <div class="sp-head">
            <div class="sp-name">${esc(name)}</div>
            <div class="sp-score${s == null ? ' na' : ''}">${s == null ? 'N/A' : s}<span class="sp-out">${s == null ? '' : '/100'}</span></div>
          </div>
          <div class="gauge">
            <div class="gauge-bar${s == null ? ' muted' : ''}"></div>
            ${s == null ? '' : `<div class="gauge-mark" style="left:${s}%"></div>`}
          </div>
          <div class="sp-cap">${caption}</div>
        </div>`;
}

function speedPage(p: ArmaReportParams): string {
  const { lead, competitor } = p;
  const ls = lead.speed, cs = competitor.speed;
  const worseThanComp = ls != null && cs != null && ls < cs;
  const v = esc(p.vertical.toLowerCase());

  // Vertical-aware intent framing: urgent trades → "calls are urgent"; considered
  // purchases → "comparing quotes". Speed copy is downstream of that framing.
  const intent = p.isUrgent
    ? `Most ${v} calls are urgent — the customer taps the first site and leaves if it stalls.`
    : `Homeowners pricing ${v} open several sites at once and bounce from whichever one is slow to load.`;

  // Headline matches the intent frame; the reference "EMERGENCIES DON'T WAIT" is
  // reserved for urgent verticals only.
  const headline = p.isUrgent
    ? `EMERGENCIES DON'T <span class="red">WAIT.</span>`
    : `A SLOW SITE LOSES THE <span class="red">QUOTE.</span>`;

  let sub: string;
  if (ls == null)          sub = `${intent} We couldn't score your mobile speed this run, so we're flagging it for a manual check — and assigning no speed loss without a measured score.`;
  else if (ls < 50)        sub = `${intent} Your mobile score is in the red.`;
  else if (worseThanComp)  sub = `${intent} Your site loads — but ${esc(competitor.name)} loads faster, and on mobile the quicker site usually wins.`;
  else if (ls < 80)        sub = `${intent} Your mobile speed is middling — fine until a faster competitor is one tap away.`;
  else                     sub = `${intent} Good news: your mobile speed holds up — this is one gap you don't have.`;

  return `<section class="page">
  ${topbar(p, 'STEP 3 OF 3 · SPEED')}
  <div class="body">
    <div class="kicker">STEP 3 · SPEED</div>
    <h2 class="hl hl-step">${headline}</h2>
    <p class="sub">${sub}</p>

    <div class="panel">
      <div class="panel-head">GOOGLE PAGESPEED — MOBILE SCORE</div>
      <div class="panel-body">
        ${speedRow(lead.name, lead.speed, p.isUrgent)}
        ${speedRow(competitor.name, competitor.speed, p.isUrgent)}
      </div>
    </div>

    ${lead.speed == null
      ? neutralBanner('Mobile speed not measured this run — manual check needed. No loss assigned here.')
      : p.activeGaps.speed ? lossBanner(p.gaps.speed) : goodBanner('Your mobile speed holds up — no loss on this surface.')}
  </div>
  ${footer(p)}
</section>`;
}

function ctaPage(p: ArmaReportParams, gapCount: number): string {
  const { competitor } = p;
  return `<section class="page">
  ${topbar(p, 'YOUR NEXT MOVE')}
  <div class="body">
    <div class="kicker">CLOSE THE GAP</div>
    <h2 class="hl hl-step">TWO WAYS <span class="red">FORWARD.</span></h2>
    <p class="sub">You've seen the ${numWord(gapCount)} ${gapCount === 1 ? 'gap' : 'gaps'} and what they cost. There are two ways to close them.</p>

    <div class="ways">
      <div class="way">
        <div class="way-opt">OPTION A</div>
        <div class="way-title">DO IT YOURSELF</div>
        <div class="way-body">Every gap in this report is fixable on your own. Work through them in order — reviews, then speed — and you'll see movement within 60 days.</div>
      </div>
      <div class="way way-hot">
        <div class="way-opt">OPTION B · RECOMMENDED</div>
        <div class="way-title">GET THE FULL PLAN</div>
        <div class="way-body">A free 20-minute Zoom where we walk through exactly how to overtake ${esc(competitor.name)} — live screen-share, ask anything. No pitch, no obligation. If you want us to run it after, we'll talk price. If not, you keep everything we showed.</div>
      </div>
    </div>

    <div class="cta-btn">BOOK YOUR 20-MIN ZOOM &#10142;</div>
    <p class="cta-note">Or just reply to the email this report came in. Prepared specifically for ${esc(p.lead.name)} Inc based on data pulled ${p.date}. Figures are conservative monthly estimates — your real gap is likely larger.</p>
  </div>
  ${footer(p)}
</section>`;
}

// ─── Document ────────────────────────────────────────────────────────────────

export function generateArmaReportHTML(p: ArmaReportParams): string {
  const cats: string[] = [];
  if (p.activeGaps.trust)  cats.push('reviews');
  if (p.activeGaps.speed)  cats.push('speed');
  const gapCount = cats.length;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800&display=swap');
:root{
  --red:#ED1C24; --pink:#FDECEE; --green:#2E9E5B; --gold:#F5A623; --blue:#1A0DAB;
  --ink:#141414; --gray:#5C616B; --soft:#8A8F99; --line:#E4E6EA; --track:#EDEEF0; --mint:#EAF7EF;
}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{background:#fff;}
body{font-family:'Inter',sans-serif;color:var(--ink);-webkit-print-color-adjust:exact;print-color-adjust:exact;}
@page{margin:0;size:794px 1123px;}
.page{position:relative;width:794px;height:1123px;background:#fff;display:flex;flex-direction:column;page-break-after:always;overflow:hidden;}
.page:last-child{page-break-after:auto;}

.topbar{display:flex;justify-content:space-between;align-items:center;padding:40px 68px 14px;font-size:10px;font-weight:700;letter-spacing:.13em;color:var(--ink);border-bottom:1px solid var(--line);}
.topbar .brand{color:var(--red);font-weight:800;}
.tb-r{color:var(--soft);font-weight:600;}

.body{flex:1;padding:38px 68px 0;display:flex;flex-direction:column;}
.foot{padding:18px 68px 30px;font-size:9px;font-weight:600;letter-spacing:.1em;color:var(--soft);border-top:1px solid var(--line);margin-top:auto;}

.kicker{font-size:11px;font-weight:800;letter-spacing:.22em;color:var(--red);margin-bottom:12px;}
.hl{font-family:'Anton',sans-serif;font-weight:400;text-transform:uppercase;letter-spacing:.005em;line-height:.92;color:var(--ink);}
.hl .red{color:var(--red);}
.hl-cover{font-size:74px;margin-bottom:22px;}
.hl-step{font-size:46px;margin-bottom:14px;}
.sub{font-size:15px;line-height:1.5;color:var(--gray);max-width:600px;margin-bottom:22px;}
.sub b{color:var(--ink);font-weight:700;}

.rule{border:none;border-top:1.5px solid var(--ink);margin:6px 0 26px;}
.section-lbl{font-size:11px;font-weight:800;letter-spacing:.22em;color:var(--red);margin-bottom:18px;}

/* Cover cards */
.cards{display:grid;grid-template-columns:1fr 1fr;gap:18px;}
.card{border:1px solid var(--line);border-radius:4px;padding:30px 30px 34px;min-height:232px;display:flex;flex-direction:column;}
.card-num{font-family:'Anton',sans-serif;font-size:50px;color:var(--red);line-height:1;margin-bottom:18px;}
.card-desc{font-size:13.5px;line-height:1.5;color:var(--gray);max-width:290px;}

/* Loss / good banner */
.loss{display:flex;align-items:center;gap:26px;background:var(--pink);border-left:6px solid var(--red);border-radius:0 6px 6px 0;padding:22px 30px;width:64%;margin-top:6px;}
.loss-lbl{font-size:11px;font-weight:800;letter-spacing:.16em;color:var(--red);line-height:1.3;max-width:120px;}
.loss-val{font-family:'Anton',sans-serif;font-size:42px;color:var(--red);line-height:1;}
.loss-mo{font-size:22px;}
.loss.pos{background:var(--mint);border-left-color:var(--green);}
.loss-lbl.pos{color:var(--green);}
.loss-good{font-size:15px;font-weight:600;color:#1d7a47;line-height:1.4;max-width:330px;}
/* Neutral (not-measured) banner — grey, makes no positive/negative claim. */
.loss.neutral{background:#F3F4F6;border-left-color:var(--soft);}
.loss-lbl.neutral{color:var(--soft);}
.loss-good.neutral{color:var(--gray);font-weight:600;}

/* Panels */
.panel{border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:26px;}
.panel-head{padding:18px 26px;font-size:11px;font-weight:800;letter-spacing:.13em;color:var(--soft);border-bottom:1px solid var(--line);}
.panel-body{padding:8px 26px 24px;}
.searchbar{display:flex;align-items:center;gap:12px;padding:18px 26px;background:#F6F7F8;color:var(--gray);font-size:15px;border-bottom:1px solid var(--line);}
.sb-ico{font-size:14px;opacity:.7;}
.star{color:var(--gold);}

/* Reviews bars */
.rev-row{display:grid;grid-template-columns:200px 1fr;gap:22px;align-items:center;margin:18px 0;}
.rev-name{font-size:17px;font-weight:700;}
.rev-stars{font-size:13px;color:var(--gray);margin-top:4px;}
.rev-track{background:var(--track);border-radius:8px;height:74px;position:relative;overflow:hidden;}
.rev-bar{height:100%;border-radius:8px;display:flex;align-items:center;justify-content:flex-end;padding-right:22px;min-width:60px;}
.rev-bar.red{background:var(--red);}
.rev-bar.dark{background:var(--ink);}
.rev-bar span{font-family:'Anton',sans-serif;font-size:34px;color:#fff;}
.callout{background:#F6F7F8;border-radius:6px;padding:16px 20px;font-size:13px;line-height:1.55;color:var(--gray);margin-top:20px;}
.callout b{color:var(--ink);font-weight:700;}

/* Organic results */
.org-block{padding:18px 0 20px;border-bottom:1px solid var(--line);}
.org-rank{font-size:10.5px;font-weight:800;letter-spacing:.13em;color:var(--soft);margin-bottom:7px;}
.org-rank.red{color:var(--red);}
.org-rank.green{color:var(--green);}
.org-url{font-size:13px;color:var(--green);margin-bottom:3px;}
.org-title{font-size:19px;font-weight:700;color:var(--blue);line-height:1.25;margin-bottom:5px;}
.org-title.red{color:var(--red);}
.org-title.green{color:#1d7a47;}
.org-desc{font-size:13.5px;color:var(--gray);line-height:1.5;}
.org-lead{background:var(--pink);border-left:6px solid var(--red);border-radius:0 8px 8px 0;padding:20px 22px;margin-top:18px;}
.org-lead.win{background:var(--mint);border-left-color:var(--green);margin-top:0;margin-bottom:18px;}

/* Speed gauges */
.sp-row{margin:22px 0;}
.sp-head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px;}
.sp-name{font-size:18px;font-weight:700;}
.sp-score{font-family:'Anton',sans-serif;font-size:40px;color:var(--ink);line-height:1;}
.sp-out{font-family:'Inter';font-size:15px;font-weight:600;color:var(--soft);}
.gauge{position:relative;height:26px;}
.gauge-bar{height:26px;border-radius:13px;background:linear-gradient(90deg,#E5383B 0%,#F5A623 50%,#2E9E5B 100%);}
/* Unmeasured score → flat grey bar with no marker (never implies a middling result). */
.gauge-bar.muted{background:#E4E6EA;}
.gauge-mark{position:absolute;top:-7px;width:4px;height:40px;background:var(--ink);border-radius:2px;transform:translateX(-2px);}
.sp-score.na{color:var(--soft);font-size:28px;}
.sp-cap{font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--gray);margin-top:12px;text-transform:uppercase;}

/* CTA */
.ways{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-bottom:22px;}
.way{border:1px solid var(--line);border-radius:10px;padding:30px 30px;min-height:560px;}
/* Recommended card: solid black (reference), with a red option label and a red CTA button below. */
.way-hot{background:var(--ink);border-color:var(--ink);color:#fff;}
.way-opt{font-size:11px;font-weight:800;letter-spacing:.18em;color:var(--red);margin-bottom:18px;}
.way-hot .way-opt{color:var(--red);}
.way-title{font-family:'Anton',sans-serif;font-size:34px;color:var(--ink);margin-bottom:18px;text-transform:uppercase;}
.way-hot .way-title{color:#fff;}
.way-body{font-size:14px;line-height:1.6;color:var(--gray);max-width:300px;}
.way-hot .way-body{color:#fff;opacity:.92;}
.cta-btn{background:var(--red);color:#fff;text-align:center;font-family:'Anton',sans-serif;font-size:22px;letter-spacing:.04em;padding:24px;border-radius:8px;text-transform:uppercase;}
.cta-note{font-size:11px;line-height:1.6;color:var(--soft);margin-top:18px;max-width:640px;}
</style></head><body>
${coverPage(p, cats)}
${trustPage(p)}
${searchPage(p)}
${speedPage(p)}
${ctaPage(p, gapCount)}
</body></html>`;
}
