// report/armaLogic.ts — pure decision logic for the ARMA report (no I/O, no DB).
// Kept dependency-free (only the in-memory benchmark table) so it is directly unit-
// testable and safe to import from both the route and the regression suite.

import { findBenchmark } from '../benchmarks';

// Verticals where the buyer typically needs help NOW (emergency/"they leave" copy).
// Everything else is a considered purchase → quote/estimate/"comparing" copy. Keys
// match the canonical benchmark names returned by findBenchmark(). Kept deliberately
// narrow (only genuine emergency trades) so emergency wording never appears for a
// considered purchase like painting or insulation.
export const URGENT_NICHES = new Set<string>([
  'Plumbing', 'HVAC', 'Electrical', 'Roofing Replacement',
  'Fire & Water Damage Restoration',
]);

export const isUrgentVertical = (vertical: string): boolean =>
  URGENT_NICHES.has(findBenchmark(vertical).key);

// ─── Revenue-loss model ───────────────────────────────────────────────────────
// Originally reproduced the ARMA Lead Loss Calculator (arma-lead-loss-calculator.vercel.app)
// VERBATIM across four rows (Map, Rating, Search, Speed). The Map and Search rows depended
// on Google Maps rank / organic SERP rank — both of which the report no longer computes now
// that the competitor is manually supplied and no ranking/position data is fetched or shown.
// Only the Rating and Speed rows survive (neither depends on rank); the total is their sum,
// so it INTENTIONALLY no longer equals the standalone calculator's four-row total.
//
// The calculator's benchmark CVRs are identical to benchmarks.ts; only three avg-ticket
// values differ. We override just those three (leaving benchmarks.ts — which drives the
// lite/full reports — untouched). Any niche absent from the calculator (e.g. Insulation)
// keeps its benchmarks.ts ticket.
const CALC_TICKET_OVERRIDE: Record<string, number> = {
  'HVAC': 1950,
  'Solar Installation': 26000,
  'Siding': 12500,
};

export type ArmaLossInput = {
  traffic: number;                        // monthly website visitors
  vertical: string;
  faster: boolean;                        // lead site measured faster than the competitor
};

export type ArmaLoss = {
  base: number;                           // R = traffic × cvr × avg ticket
  rows: {
    rating: [number, number];
    speed:  [number, number];
  };
  total: [number, number];                // sum of the two ±30% bands
};

export function calcArmaLoss(input: ArmaLossInput): ArmaLoss {
  const { key, bm } = findBenchmark(input.vertical);
  const cvr    = bm.cvr / 100;
  const ticket = CALC_TICKET_OVERRIDE[key] ?? bm.avg_ticket;
  const R      = input.traffic * cvr * ticket;

  // Speed → 0.15 if your site is faster than the competitor, else 0.40 (unchanged from
  // the calculator's weighting — this row never depended on rank).
  const wSpd = input.faster ? 0.15 : 0.40;

  const midRating = R * 0.40 * 0.15;
  const midSpeed  = R * wSpd * 0.15;
  const mids      = [midRating, midSpeed];

  const band = (m: number): [number, number] => [Math.round(m * 0.7), Math.round(m * 1.3)];

  return {
    base: R,
    rows: {
      rating: band(midRating),
      speed:  band(midSpeed),
    },
    total: [
      Math.round(mids.reduce((s, m) => s + m * 0.7, 0)),
      Math.round(mids.reduce((s, m) => s + m * 1.3, 0)),
    ],
  };
}
