const { getStore } = require('./_blobs');
const { getCohort, getProgramme, salePhase } = require('./_pricing');

// ============================================================
// Sales Commission Scheme — "Strategy Led AI" two-tier structure
// (Sales Rep + Sales Manager override), replacing the prior
// rep-only 10/20/30% scheme.
// ============================================================
//
// Layer (a) + (b) below are computed at the moment of sale, for a sale
// made during EITHER a cohort's Early-Bird OR Final-Call window (never
// after sales close):
//
//  (a) Same-company tier — per company, within ONE booking:
//        1-5 delegates    -> 5%
//        6-9 delegates    -> 10%
//        10-15+ delegates -> 15% (uncapped above 15 — also the rate
//                                 that carries through unchanged for
//                                 in-house cohorts, up to the
//                                 20-delegate in-house cap)
//
//  (b) Workshop-volume bonus — the rep's CUMULATIVE delegate count sold
//      into this ONE cohort specifically (not across all their sales
//      everywhere), stacking additively on top of (a):
//        6+ delegates  in this cohort -> +3%
//        12+ delegates in this cohort -> +6%
//        18+ delegates in this cohort -> +10%
//
// Layer (c) is NOT computed at time of sale — it depends on whether the
// cohort ever actually reaches its minimum (now 18 delegates, uniform
// across every public format — see programme.minSeats in cohorts.json),
// which isn't known until later. It's applied retroactively by
// release-commission-payouts.js:
//
//  (c) Minimum-fill team bonus — flat +5%, added to every commission
//      record in a cohort once that cohort is confirmed to have reached
//      its minimum go-ahead headcount (18). Applies to ALL of a
//      contributing rep's sales in that cohort, not just the sale that
//      tipped it over.
//
// Rep ceiling: 15% + 10% + 5% = 30%.
//
// C-Suite / HOD exception: private single-company engagements for
// C-Suite/Dept Heads are bespoke, quoted separately, and sit entirely
// OFF this rate card — none of the tiers, the 18-delegate minimum, or
// the manager override below apply to them. Every such deal must clear
// its own profit floor on its own quote; see MARGIN_REPORT.md for the
// numbers behind the standard formats.
//
// ============================================================
// Sales Manager override (new)
// ============================================================
//
// Paid independently of, and never reducing, the rep's own commission
// above — a manager earns this on every sale closed by any rep in
// their downline, calculated on the same deal value.
//
//   Team Lead       (2+ active reps reporting to this manager) -> 2%
//   Team Builder    (team's combined delegates this quarter >= 25) -> 3.5%
//   Team Excellence (team's combined delegates this quarter >= 40,
//                    OR 3+ of the manager's reps have each landed at
//                    least one sale this quarter at the full company +
//                    workshop rate, 15%+10%=25%) -> 5%
//
// Below 2 active reps, there's no override at all (not even the 2%
// floor) — the whole point of Team Lead is recognising the step-up
// into actually managing a team.
//
// "Rolling quarter" is implemented as the calendar quarter the sale
// falls in (Jan-Mar / Apr-Jun / Jul-Sep / Oct-Dec), not a trailing
// 90-day window — simpler to reason about and to show a manager
// ("this quarter's number"). Flag to revisit if a true trailing window
// was actually intended.
//
// The Team Excellence "3+ reps at their own ceiling" path deliberately
// checks each rep's 25% (company tier + workshop bonus, both fully
// within the rep's own control at the moment of sale) rather than the
// eventual 30% that includes the minimum-fill bonus — that bonus is a
// cohort-level outcome only known later (see Layer (c) above), and
// waiting for it here would mean either delaying every manager's
// override determination until cohorts close, or clawing back an
// already-paid override, both of which the rep-side design already
// deliberately avoids. A rep who's hit their 25% ceiling on a sale has
// done everything within their own control; the min-fill bonus on top
// is the same team-outcome bonus every rep in the cohort shares.
//
// Like the rep's own workshop bonus, this is evaluated incrementally
// at time of sale using the team's cumulative state as of that moment
// — no retroactive recalculation, no clawbacks. Team volume climbing
// over the course of a quarter means a manager's override rate on
// their team's sales can only go up as the quarter progresses, never
// down.

const COMPANY_TIERS = [
  { min: 1, max: 5, rate: 0.05 },
  { min: 6, max: 9, rate: 0.10 },
  { min: 10, max: 999999, rate: 0.15 },
];

const WORKSHOP_BONUS_TIERS = [
  { min: 0, max: 5, rate: 0 },
  { min: 6, max: 11, rate: 0.03 },
  { min: 12, max: 17, rate: 0.06 },
  { min: 18, max: 999999, rate: 0.10 },
];

const MINIMUM_FILL_BONUS_RATE = 0.05;

const REP_OWN_CEILING_RATE = 0.15 + 0.10; // 25% — top company tier + top workshop bonus, the part fully within a rep's own control at time of sale
const MANAGER_MIN_ACTIVE_REPS = 2;
const MANAGER_TEAM_BUILDER_THRESHOLD = 25;
const MANAGER_TEAM_EXCELLENCE_VOLUME_THRESHOLD = 40;
const MANAGER_TEAM_EXCELLENCE_ELITE_REP_COUNT = 3;
const MANAGER_OVERRIDE_RATES = {
  none: 0,
  teamLead: 0.02,
  teamBuilder: 0.035,
  teamExcellence: 0.05,
};

// ============================================================
// Account Ownership (expansion sales)
// ============================================================
// A rep who lands the FIRST paid booking from a company becomes that
// company's Account Owner for 12 months from that sale. The payoff:
// if a LATER booking from the same company comes in under ISM (house
// default) or SELF_CREDIT — i.e. no other rep's code involved — the
// owner earns the company-tier rate (5/10/15%, seat-count-based, NO
// workshop-bonus or minimum-fill layer) on that booking.
//
// Deliberately does NOT fire, and never competes, when a DIFFERENT
// rep's code is used on a later booking — that rep just earns their
// own commission normally, no split, no arbitration. The owner is
// only ever paid in the exact case where otherwise nobody would be —
// a direct/self-credit booking — which is what makes this a pure
// incentive to nurture the account rather than a source of channel
// conflict between reps.
//
// Company-name matching starts deliberately simple: lowercase, trim,
// collapse internal whitespace. No fuzzy matching yet — revisit only
// if reps report real false misses ("Acme Sdn Bhd" vs "ACME").
const ACCOUNT_OWNERSHIP_WINDOW_DAYS = 365;

function normalizeCompanyName(name) {
  if (!name) return null;
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized || null;
}

// Called on every paid booking, regardless of whether it's a rep sale,
// ISM, or SELF_CREDIT — the two branches below are mutually exclusive
// per booking (a booking either CLAIMS ownership or PAYS an existing
// owner; it can never do both, since a rep-coded booking and an
// ISM/SELF_CREDIT booking are different bookings by definition).
async function checkAndRecordAccountOwnership({
  bookingId, cohortId, repCode, companyName, seatCount, revenue, createdAt
}) {
  const result = { ownershipClaimed: false, ownershipOverridePaid: false };

  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return result; // Can't track ownership without a company name.

  const store = getStore('bookings');
  const ownerKey = `company-owner:${normalized}`;
  const existing = await store.get(ownerKey, { type: 'json' });
  const now = new Date(createdAt || Date.now());
  const existingActive = existing && new Date(existing.expiresAt) > now;

  const isRepSale = repCode && repCode !== 'ISM' && repCode !== 'SELF_CREDIT';

  if (isRepSale) {
    // Claim ownership only if nobody holds an active claim already — first
    // claimer keeps it until expiry, including against the same rep
    // re-selling (a no-op, not an extension of the window).
    if (!existingActive) {
      const expiresAt = new Date(now.getTime() + ACCOUNT_OWNERSHIP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      await store.setJSON(ownerKey, {
        ownerCode: repCode,
        companyName,
        normalizedCompanyName: normalized,
        firstSaleBookingId: bookingId,
        firstSaleDate: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      result.ownershipClaimed = true;
    }
    return result;
  }

  // ISM / SELF_CREDIT booking — pay the active owner, if any.
  if (!existingActive) return result;

  const cohort = getCohort(cohortId);
  const phase = salePhase(cohort, now);
  if (phase !== 'early-bird' && phase !== 'final-call') return result;

  const companyRate = companyTierRate(seatCount);
  const amount = Math.round(revenue * companyRate);

  const record = {
    bookingId,
    cohortId,
    repCode: existing.ownerCode,
    companyName: companyName || null,
    seatCount,
    revenue,
    salePhaseAtSale: phase,
    companyTierRate: companyRate,
    workshopBonusRate: 0,
    minimumFillBonusRate: 0,
    totalRate: companyRate,
    commissionAmount: amount,
    payoutStatus: 'pending',
    recordType: 'ownership-override',
    ownershipTriggerBookingRepCode: repCode, // the ISM/SELF_CREDIT booking that triggered this
    computedAt: now.toISOString(),
  };
  const primaryKey = `commission:${bookingId}:ownership-override`;
  await store.setJSON(primaryKey, record);
  await store.setJSON(`commission-by-rep:${existing.ownerCode}:${record.computedAt}:${bookingId}:ownership-override`, record);

  result.ownershipOverridePaid = true;
  result.ownerCode = existing.ownerCode;
  result.commissionAmount = amount;
  return result;
}

function companyTierRate(delegateCount) {
  const tier = COMPANY_TIERS.find((t) => delegateCount >= t.min && delegateCount <= t.max);
  return tier ? tier.rate : 0;
}

function workshopBonusRate(cumulativeInCohort) {
  const tier = WORKSHOP_BONUS_TIERS.find((t) => cumulativeInCohort >= t.min && cumulativeInCohort <= t.max);
  return tier ? tier.rate : 0;
}

// Computes and records commission for a booking at the moment it's paid
// (called from stripe-webhook.js). It runs on seat count and revenue
// alone, so it can fire immediately at payment — no delegate-eligibility
// data needed. The minimum-fill bonus is deliberately NOT included here;
// see release-commission-payouts.js for that.
async function calculateAndRecordCommission({
  bookingId, cohortId, repCode, companyName, seatCount, revenue, createdAt
}) {
  const store = getStore('bookings');
  const result = {
    repCode,
    eligible: false,
    reason: null,
    seatCount,
    companyTierRate: 0,
    workshopBonusRate: 0,
    totalRate: 0,
    commissionAmount: 0,
    repCumulativeInCohortAfter: null
  };

  // No rep attributed (house default / self-credit path) — not a commission case.
  if (!repCode || repCode === 'ISM' || repCode === 'SELF_CREDIT') {
    result.reason = repCode === 'SELF_CREDIT'
      ? 'Booking contact chose an account credit instead of rep commission'
      : 'No sales rep attributed to this booking';
    return result;
  }

  const cohort = getCohort(cohortId);
  const saleDate = new Date(createdAt);
  const phase = salePhase(cohort, saleDate);

  if (phase !== 'early-bird' && phase !== 'final-call') {
    result.reason = 'Sale was made outside the Early-Bird / Final-Call selling window';
    return result;
  }

  // Workshop bonus: this rep's cumulative delegate count in THIS cohort specifically.
  const ledgerKey = `rep-cohort-count:${repCode}:${cohortId}`;
  const priorRaw = await store.get(ledgerKey);
  const prior = priorRaw ? parseInt(priorRaw, 10) : 0;
  const after = prior + seatCount;
  await store.set(ledgerKey, String(after));
  result.repCumulativeInCohortAfter = after;

  const companyRate = companyTierRate(seatCount);
  const bonusRate = workshopBonusRate(after);
  const totalRate = companyRate + bonusRate;
  const amount = Math.round(revenue * totalRate);

  result.eligible = true;
  result.companyTierRate = companyRate;
  result.workshopBonusRate = bonusRate;
  result.totalRate = totalRate;
  result.commissionAmount = amount;

  const record = {
    bookingId,
    cohortId,
    repCode,
    companyName: companyName || null,
    seatCount,
    revenue,
    salePhaseAtSale: phase,
    companyTierRate: companyRate,
    workshopBonusRate: bonusRate,
    minimumFillBonusRate: 0,
    totalRate,
    commissionAmount: amount,
    payoutStatus: 'pending',
    repCumulativeInCohortAfter: after,
    computedAt: new Date().toISOString()
  };
  await store.setJSON(`commission:${bookingId}`, record);
  // Secondary index for the sales report: lets it list one rep's
  // commissions by prefix instead of scanning every booking in the system.
  await store.setJSON(`commission-by-rep:${repCode}:${record.computedAt}:${bookingId}`, record);

  result.repOwnCeilingReached = totalRate >= REP_OWN_CEILING_RATE;

  return result;
}

function quarterKey(date) {
  const q = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()}-Q${q}`;
}

// Sums, for every rep on a given manager's team, that rep's delegate
// count from commission records computed within the given quarter —
// this is the "team's combined delegates this quarter" figure the
// Team Builder / Team Excellence tiers key off. Also returns how many
// distinct reps on the team have hit their own 25% ceiling (company +
// workshop bonus) on at least one sale in the quarter, for the
// alternate Team Excellence path.
async function getTeamQuarterStats(store, managerCode, quarter) {
  const { blobs } = await store.list({ prefix: `manager-team:${managerCode}:` });
  const repCodes = blobs.map((b) => b.key.split(':')[2]).filter(Boolean);

  let teamVolume = 0;
  const elitesThisQuarter = new Set();

  for (const repCode of repCodes) {
    const { blobs: repCommissions } = await store.list({ prefix: `commission-by-rep:${repCode}:` });
    for (const b of repCommissions) {
      const record = await store.get(b.key, { type: 'json' });
      if (!record || !record.computedAt) continue;
      if (record.recordType === 'ownership-override') continue; // not this rep's own selling volume
      if (quarterKey(new Date(record.computedAt)) !== quarter) continue;

      teamVolume += record.seatCount || 0;
      if ((record.totalRate || 0) >= REP_OWN_CEILING_RATE) {
        elitesThisQuarter.add(repCode);
      }
    }
  }

  return { repCodes, teamVolume, eliteRepCount: elitesThisQuarter.size };
}

function managerOverrideTierForStats({ activeRepCount, teamVolume, eliteRepCount }) {
  if (activeRepCount < MANAGER_MIN_ACTIVE_REPS) return { tier: 'none', rate: MANAGER_OVERRIDE_RATES.none };
  if (teamVolume >= MANAGER_TEAM_EXCELLENCE_VOLUME_THRESHOLD || eliteRepCount >= MANAGER_TEAM_EXCELLENCE_ELITE_REP_COUNT) {
    return { tier: 'teamExcellence', rate: MANAGER_OVERRIDE_RATES.teamExcellence };
  }
  if (teamVolume >= MANAGER_TEAM_BUILDER_THRESHOLD) {
    return { tier: 'teamBuilder', rate: MANAGER_OVERRIDE_RATES.teamBuilder };
  }
  return { tier: 'teamLead', rate: MANAGER_OVERRIDE_RATES.teamLead };
}

// Computes and records the Sales Manager override for a sale, if the
// selling rep has an active manager on file. Runs independently of
// calculateAndRecordCommission above — never reduces the rep's own
// commission, and is skipped silently (not an error) if the rep has no
// manager, or their manager code doesn't resolve to an active
// sales_manager record (e.g. a manager who's left).
async function calculateAndRecordManagerOverride({
  bookingId, cohortId, repCode, companyName, seatCount, revenue, createdAt
}) {
  const result = { eligible: false, reason: null, managerCode: null, overrideTier: 'none', overrideRate: 0, overrideAmount: 0 };

  if (!repCode || repCode === 'ISM' || repCode === 'SELF_CREDIT') {
    result.reason = 'No sales rep attributed to this booking';
    return result;
  }

  const store = getStore('bookings');
  const repRecord = await store.get(`sales-agent:${repCode}`, { type: 'json' }).catch(() => null);
  const managerCode = repRecord && repRecord.managerCode;
  if (!managerCode) {
    result.reason = 'Rep has no manager on file';
    return result;
  }

  const managerRecord = await store.get(`sales-agent:${managerCode}`, { type: 'json' }).catch(() => null);
  if (!managerRecord || managerRecord.kind !== 'sales_manager' || managerRecord.status === 'inactive') {
    result.reason = 'Manager code does not resolve to an active sales manager';
    return result;
  }

  const cohort = getCohort(cohortId);
  const saleDate = new Date(createdAt);
  const phase = salePhase(cohort, saleDate);
  if (phase !== 'early-bird' && phase !== 'final-call') {
    result.reason = 'Sale was made outside the Early-Bird / Final-Call selling window';
    return result;
  }

  const { blobs: teamBlobs } = await store.list({ prefix: `manager-team:${managerCode}:` });
  const activeRepCount = teamBlobs.length;

  const quarter = quarterKey(saleDate);
  const { teamVolume, eliteRepCount } = await getTeamQuarterStats(store, managerCode, quarter);

  const { tier, rate } = managerOverrideTierForStats({ activeRepCount, teamVolume, eliteRepCount });

  result.managerCode = managerCode;
  result.overrideTier = tier;
  result.overrideRate = rate;
  result.teamVolumeThisQuarter = teamVolume;
  result.eliteRepCountThisQuarter = eliteRepCount;
  result.activeRepCount = activeRepCount;

  if (rate <= 0) {
    result.reason = `Team has fewer than ${MANAGER_MIN_ACTIVE_REPS} active reps`;
    return result;
  }

  const amount = Math.round(revenue * rate);
  result.eligible = true;
  result.overrideAmount = amount;

  const record = {
    bookingId,
    cohortId,
    managerCode,
    triggeringRepCode: repCode,
    companyName: companyName || null,
    seatCount,
    revenue,
    salePhaseAtSale: phase,
    quarter,
    overrideTier: tier,
    overrideRate: rate,
    overrideAmount: amount,
    // Aliases so code written against the rep-commission record shape
    // (send-sales-reports.js's money/percent line, any generic summing)
    // works unchanged for this record type too.
    totalRate: rate,
    commissionAmount: amount,
    teamVolumeThisQuarter: teamVolume,
    eliteRepCountThisQuarter: eliteRepCount,
    activeRepCount,
    payoutStatus: 'pending',
    recordType: 'manager-override',
    computedAt: new Date().toISOString(),
  };
  await store.setJSON(`commission:${bookingId}:manager-override`, record);
  await store.setJSON(`commission-by-rep:${managerCode}:${record.computedAt}:${bookingId}:manager-override`, record);

  return result;
}

module.exports = {
  calculateAndRecordCommission, checkAndRecordAccountOwnership, calculateAndRecordManagerOverride,
  normalizeCompanyName, companyTierRate, workshopBonusRate, quarterKey, managerOverrideTierForStats,
  COMPANY_TIERS, WORKSHOP_BONUS_TIERS, MINIMUM_FILL_BONUS_RATE, ACCOUNT_OWNERSHIP_WINDOW_DAYS,
  REP_OWN_CEILING_RATE, MANAGER_MIN_ACTIVE_REPS, MANAGER_TEAM_BUILDER_THRESHOLD,
  MANAGER_TEAM_EXCELLENCE_VOLUME_THRESHOLD, MANAGER_TEAM_EXCELLENCE_ELITE_REP_COUNT, MANAGER_OVERRIDE_RATES
};
