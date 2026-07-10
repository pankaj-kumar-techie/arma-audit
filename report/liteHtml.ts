const esc = (s: any) =>
  String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function pickHeadline(leadPos: number, compName: string, leadReviews: number, compReviews: number, compPos: number): string {
  if (leadPos === 1 && leadReviews < compReviews) return `Strong Reviews. Fragile Lead. Protect Your #1.`;
  if (leadPos === 1) return `#1 on Maps. Here's What Keeps It That Way.`;
  if (leadPos <= 3 && leadReviews < compReviews * 0.5) return `Close Rank. Review Gap. Revenue Leak.`;
  if (leadPos <= 3) return `One Spot Away. Thousands at Stake.`;
  if (leadPos > 10) return `Invisible Where It Counts.`;
  if (leadPos >= 7)  return `Buried While ${compName.split(' ')[0]} Gets the Calls.`;
  return `Sitting at #${leadPos}. ${compName.split(' ')[0]} Holds #${compPos}.`;
}

function formatHl(h: string): string {
  const parts = h.replace(/\.$/, '').split('. ').filter(Boolean);
  if (parts.length > 1) {
    const last = parts.pop()!;
    return `${parts.join('. ')}.<br><span class="yl">${last}</span>`;
  }
  const words = h.replace(/\.$/, '').split(' ');
  const split = words.length <= 4 ? words.length - 2 : words.length - 3;
  return `${words.slice(0, split).join(' ')}<br><span class="yl">${words.slice(split).join(' ')}</span>`;
}

export interface LiteReportParams {
  lead: {
    name: string;
    rating: number;
    review_count: number;
    place_id: string;
    gbp_url: string | null;
    position: number;
    organic_position?: number | null;
    phone: string;
    address: string;
    owner: string;
    service_area: string;
  };
  competitor: {
    name: string;
    rating: number;
    review_count: number;
    position: number;
    domain: string;
    place_id?: string;
    gbp_url?: string | null;
    phone: string;
    owner: string;
    service_area: string;
  };
  city: string;
  state: string;
  vertical: string;
  revenue: { loss_low_usd: number; loss_high_usd: number; monthly_loss: number };
  fullPack: any[];
  rankingKeywords: Array<{ keyword: string; position: number | null }>;
  verificationUrl: string;
  // Human label for the matched surface ("Google Maps" | "Google Search – Places" |
  // "Google Search – Businesses"). Optional — falls back to deriving from verificationUrl.
  surfaceLabel?: string;
  coldEmail: { subject: string; body: string };
}

export function generateLiteReportHTML(p: LiteReportParams): string {
  const { lead, competitor, city, state, vertical, revenue, fullPack, verificationUrl, coldEmail } = p;

  const date        = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase();
  const clientName  = esc(lead.name.toUpperCase());
  const compName    = esc(competitor.name);
  const cityEsc     = esc(city);
  const stateEsc    = esc(state);
  const verticalEsc = esc(vertical);
  const leadNameEsc = esc(lead.name);

  const fmt = (v: string | undefined, fallback = 'Not specified') =>
    v && v.trim() && v.trim().toLowerCase() !== 'null' ? esc(v) : fallback;

  // The rank is measured on whichever Google surface produced verificationUrl: Google
  // Maps (…/maps/…) or the local results inside Google Search (…/search?…&udm=…). These
  // two surfaces are ranked by Google independently and legitimately differ by a
  // position or two. The report's label, verification link, and the number it cites must
  // all describe the SAME surface — otherwise a client who happens to check the *other*
  // surface sees a different position and (reasonably) concludes the report is wrong.
  // That mismatch was the source of "the positions don't match" complaints.
  const onMaps       = /google\.com\/maps/.test(verificationUrl);
  // Prefer the explicit surface label from the selected matchType; fall back to deriving it
  // from the verification URL for older callers that don't pass one.
  const surfaceLabel = p.surfaceLabel ?? (onMaps ? 'Google Maps' : "Google's local search results");
  const rankNote     = `Note: ${surfaceLabel} results are personalized by your location, signed-in account, and time of day — and Google Maps, the Search "Places" list, and the Search "Businesses" pack are each ranked separately, so a manual check on a different surface can land a position or two off. This is a live snapshot, not a fixed score.`;

  const headline  = pickHeadline(lead.position, competitor.name, lead.review_count, competitor.review_count, competitor.position);
  const isTop     = lead.position === 1;
  // The challenger's edge: review volume when they have more reviews, rating otherwise.
  const compEdge  = (competitor.review_count || 0) > (lead.review_count || 0)
    ? `${(competitor.review_count||0).toLocaleString()} reviews vs your ${(lead.review_count||0).toLocaleString()}`
    : `a ${(competitor.rating||0).toFixed(1)}★ rating vs your ${(lead.rating||0).toFixed(1)}★`;
  const heroSub   = isTop
    ? `We checked your ${surfaceLabel} footprint for '${verticalEsc}' in ${cityEsc}. You hold #1 — but ${esc(competitor.name.split(' ')[0])} is right behind at #${competitor.position} with ${compEdge}. Here's what's keeping you there — and what could knock you off.`
    : `We followed your customer's path — from Google search to phone call — and flagged where you lose them.`;
  const gapCopy   = isTop
    ? `You currently hold #1 for '${verticalEsc}' searches in ${cityEsc}. But ${compName} at #${competitor.position} has ${compEdge} — a narrow lead. Without active optimization, that position flips fast. Protecting it is worth an estimated $${revenue.loss_low_usd.toLocaleString()}–$${revenue.loss_high_usd.toLocaleString()}/month in recurring revenue.`
    : `${compName} at #${competitor.position} captures the majority of '${verticalEsc} ${cityEsc}' searches. Being at #${lead.position > 20 ? '>20' : lead.position} means most of those calls go elsewhere — an estimated $${revenue.loss_low_usd.toLocaleString()}–$${revenue.loss_high_usd.toLocaleString()}/month in missed revenue.`;
  const fix03Title = isTop
    ? `A Plan to Defend Your #1 Spot &amp; Widen the Lead on ${compName.split(' ')[0]}`
    : `A Clear Plan to Close the $${Math.round(revenue.monthly_loss / 1000)}k/Month Gap`;

  // Build exactly 5 pack entries — lead and competitor always included
  const displayPack: any[] = (() => {
    let entries = [...fullPack];
    const hasComp = entries.some(e => e.isCompetitor);
    if (!hasComp && competitor.place_id) {
      entries.push({
        position: competitor.position, name: competitor.name,
        rating: competitor.rating, review_count: competitor.review_count,
        place_id: competitor.place_id, isLead: false, isCompetitor: true,
      });
    }
    entries.sort((a, b) => a.position - b.position);
    if (entries.length > 5) {
      const must   = entries.filter(e => e.isLead || e.isCompetitor);
      const others = entries.filter(e => !e.isLead && !e.isCompetitor);
      entries = [...must, ...others.slice(0, 5 - must.length)].sort((a, b) => a.position - b.position);
    }
    return entries;
  })();

  const mapRows = displayPack.map((e: any) => {
    const prevPos = displayPack[displayPack.indexOf(e) - 1]?.position ?? 0;
    const gap = prevPos > 0 && e.position > prevPos + 1
      ? `<div style="opacity:.3;font-size:11px;text-align:center;padding:3px 0;letter-spacing:.1em;color:#777;">· · ·</div>` : '';
    const cls = e.isLead ? ' you' : '';
    const tag = e.isLead
      ? `<div class="you-tag">← YOU</div>`
      : e.isCompetitor ? `<div class="you-tag" style="color:var(--yellow);">← THEM</div>` : '';
    return gap + `<div class="map-row"><div class="mp${cls}">#${e.position}</div><div class="mn">${esc(e.name)}${tag}</div><div class="mm">${(e.rating||0).toFixed(1)}★ · ${(e.review_count||0).toLocaleString()}</div></div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=Playfair+Display:ital,wght@0,700;0,900;1,700&display=swap');
:root{--red:#D0202E;--yellow:#F5C518;--black:#000;--white:#fff;--gl:#F8F9FA;--gm:#E9ECEF;--gd:#343A40;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Outfit',sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact;color:var(--black);background:var(--white);line-height:1.4;}
.page{width:794px;height:1123px;display:flex;flex-direction:column;background:var(--white);page-break-after:always;overflow:hidden;}
@page{margin:0;size:794px 1123px;}
.tb{background:var(--black);color:var(--white);display:flex;justify-content:space-between;align-items:center;padding:12px 40px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;flex-shrink:0;}
.brand{color:var(--red);}
.body{flex:1;padding:36px 52px 0;display:flex;flex-direction:column;}
.kicker{font-size:10px;font-weight:900;color:var(--red);text-transform:uppercase;letter-spacing:.22em;margin-bottom:10px;}
.hero-hl{font-size:58px;font-weight:900;line-height:.97;letter-spacing:-.03em;margin-bottom:16px;color:var(--black);}
.yl{background:var(--yellow);padding:2px 10px;}
.hero-sub{font-family:'Playfair Display',serif;font-style:italic;font-size:15px;line-height:1.5;margin-bottom:18px;color:var(--gd);}
.footer{border-top:1px solid var(--gm);padding:13px 52px;display:flex;justify-content:space-between;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--gd);letter-spacing:.06em;flex-shrink:0;}
.cover-kicker-label{font-size:11px;font-weight:900;color:var(--red);text-transform:uppercase;letter-spacing:.22em;margin-bottom:2px;}
.cover-kicker-name{font-size:13px;font-weight:700;color:var(--black);margin-bottom:20px;letter-spacing:.02em;}
.cover-divider{border:none;border-top:1.5px solid var(--black);margin:16px 0 20px;}
.cover-2col{display:grid;grid-template-columns:1fr 1fr;gap:24px;}
.bn-wrap{}
.bn-section-lbl{font-size:10px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;margin-bottom:14px;color:var(--black);}
.bn-item{display:flex;flex-direction:column;margin-bottom:16px;}
.bn-val{font-size:36px;font-weight:900;color:var(--red);line-height:1;}
.bn-val.black{color:var(--black);}
.bn-lbl{font-family:'Playfair Display',serif;font-style:italic;font-size:12px;color:var(--gd);margin-top:3px;line-height:1.3;}
.inside-wrap{border-left:1px solid var(--gm);padding-left:20px;}
.inside-section-lbl{font-size:10px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;margin-bottom:12px;color:var(--black);}
.inside-item{font-size:12px;color:var(--gd);padding:7px 0;border-bottom:0.5px solid var(--gm);line-height:1.4;}
.inside-item:last-child{border-bottom:none;}
.inside-item strong{color:var(--black);font-weight:700;}
.map-list{background:var(--black);color:var(--white);border-radius:8px;padding:18px 22px;margin-bottom:16px;}
.map-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid #1f1f1f;}
.map-row:last-child{border-bottom:none;}
.mp{font-size:20px;font-weight:900;color:#444;min-width:32px;}
.mp.you{color:var(--red);}
.mn{font-size:13px;font-weight:700;flex:1;padding:0 10px;}
.mm{font-size:11px;color:#777;text-align:right;}
.you-tag{font-size:9px;font-weight:900;color:var(--yellow);letter-spacing:.1em;margin-top:1px;}
.math{background:var(--yellow);padding:14px 18px;border-radius:6px;margin-bottom:16px;}
.math-lbl{font-size:10px;font-weight:900;letter-spacing:.18em;text-transform:uppercase;margin-bottom:4px;}
.math-txt{font-size:12px;font-weight:600;line-height:1.5;}
.fix{background:var(--gl);padding:16px 18px;border-left:5px solid var(--red);display:flex;gap:12px;align-items:flex-start;margin-bottom:9px;}
.fn{font-size:24px;font-weight:900;color:var(--red);opacity:.2;line-height:1;min-width:28px;}
.ft{font-size:14px;font-weight:800;margin-bottom:3px;}
.fb{font-size:11px;color:var(--gd);line-height:1.5;}
.lbl{font-size:10px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:var(--gd);}
</style></head><body>

<!-- PAGE 1 -->
<div class="page">
  <div class="tb"><span><span class="brand">ARMA</span> · QUICK AUDIT BRIEF · ${clientName}</span><span>${date}</span></div>
  <div class="body">
    <div class="cover-kicker-label">Quick Audit Brief</div>
    <div class="cover-kicker-name">For ${leadNameEsc.toUpperCase()} — ${cityEsc.toUpperCase()}, ${stateEsc.toUpperCase()}</div>

    <div class="hero-hl">${formatHl(headline)}</div>
    <div class="hero-sub">${heroSub}</div>

    <hr class="cover-divider">

    <div class="cover-2col">
      <!-- Left: big numbers -->
      <div class="bn-wrap">
        <div class="bn-section-lbl">Your Numbers</div>
        <div class="bn-item">
          <div class="bn-val">#${lead.position > 20 ? '>20' : lead.position}</div>
          <div class="bn-lbl">${surfaceLabel} rank for '${verticalEsc}' in ${cityEsc}</div>
        </div>
        ${lead.organic_position ? `<div class="bn-item">
          <div class="bn-val">#${lead.organic_position}</div>
          <div class="bn-lbl">organic Google search rank<br>for '${verticalEsc} ${cityEsc}'</div>
        </div>` : ''}
        <div class="bn-item">
          <div class="bn-val">${(lead.review_count || 0).toLocaleString()}</div>
          <div class="bn-lbl">your Google reviews<br>vs. ${(competitor.review_count || 0).toLocaleString()} for #${competitor.position} ${esc(competitor.name.split(' ')[0])}</div>
        </div>
        <div class="bn-item">
          <div class="bn-val">$${Math.round(revenue.monthly_loss / 1000)}k</div>
          <div class="bn-lbl">${isTop ? 'monthly revenue at risk<br>if position drops to #2–3' : 'estimated monthly revenue gap<br>based on search volume &amp; avg ticket'}</div>
        </div>
        <div class="bn-item">
          <div class="bn-val black">${(lead.rating || 0).toFixed(1)}★</div>
          <div class="bn-lbl">your Google rating</div>
        </div>
      </div>

      <!-- Right: business details + competitor -->
      <div class="inside-wrap">
        <div class="inside-section-lbl">Your Business</div>
        <div class="inside-item"><strong>Owner</strong><br>${fmt(lead.owner)}</div>
        <div class="inside-item"><strong>Phone</strong><br>${fmt(lead.phone)}</div>
        <div class="inside-item"><strong>Service Area</strong><br>${fmt(lead.service_area, 'Not clearly specified')}</div>

        <div class="inside-section-lbl" style="margin-top:20px;">${isTop ? 'Closest Challenger' : `Your #${competitor.position} Competitor`}</div>
        <div class="inside-item"><strong>${compName}</strong><br>Ranked #${competitor.position} on ${surfaceLabel}</div>
        <div class="inside-item">${(competitor.review_count || 0).toLocaleString()} reviews · ${(competitor.rating || 0).toFixed(1)}★</div>
      </div>
    </div>
  </div>
  <div class="footer"><span>STRICTLY CONFIDENTIAL · PREPARED BY ARMA AGENCY</span><span>PAGE 1 OF 2</span></div>
</div>

<!-- PAGE 2 -->
<div class="page">
  <div class="tb"><span><span class="brand">ARMA</span> · ${clientName}</span><span>MAP PACK · WHAT'S NEXT</span></div>
  <div class="body">
    <div class="kicker">Step 1 · Where You Stand Right Now</div>
    <div class="hero-hl" style="font-size:38px;margin-bottom:12px;">The Map Pack<br><span class="yl">${cityEsc} · ${verticalEsc}</span></div>
    <p class="hero-sub">Every search for '${verticalEsc}' in ${cityEsc} shows this list. This is where your customers choose.</p>

    <div class="map-list">
      ${mapRows}
    </div>
    <p style="font-size:10px;color:#999;margin:-8px 0 14px;">See this list yourself: <a href="${esc(verificationUrl)}" style="color:#999;">open the exact "${verticalEsc} in ${cityEsc}" search on ${surfaceLabel}</a>. ${rankNote}</p>

    <div class="math">
      <div class="math-lbl">${isTop ? 'What Losing This Spot Costs' : 'What This Gap Costs'}</div>
      <div class="math-txt">${gapCopy}</div>
    </div>

    <div class="lbl" style="margin-bottom:10px;">What the Full Audit Covers</div>
    <div class="fix"><div class="fn">01</div><div><div class="ft">${isTop ? `What's Keeping You at #1 — and What Could Push You Down` : `Why ${compName} Outranks You — and the Exact Fixes`}</div><div class="fb">${isTop ? `A full comparison of your Google profile vs. ${compName} at #${competitor.position}. We identify every gap they could exploit to take your spot — before they do.` : `A page-by-page breakdown of every gap on your site and Google profile vs. the #${competitor.position} competitor. Specific, numbered action steps — not vague advice.`}</div></div></div>
    <div class="fix"><div class="fn">02</div><div><div class="ft">Website Speed, Trust &amp; Conversion Analysis</div><div class="fb">We test your site the same way your customer's phone does. You'll see exactly where visitors drop off before ever calling — and how to fix it fast.</div></div></div>
    <div class="fix"><div class="fn">03</div><div><div class="ft">${fix03Title}</div><div class="fb">${esc(coldEmail.body)}</div></div></div>
  </div>
  <div class="footer"><span>PREPARED FOR ${clientName} · ${cityEsc}, ${stateEsc}</span><span>PAGE 2 OF 2</span></div>
</div>

</body></html>`;
}
