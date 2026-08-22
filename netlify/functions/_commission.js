const { getStore } = require('./_blobs');
const { getCohort, getProgramme, salePhase } = require('./_pricing');

// ============================================================
// Sales Commission Scheme (round 4 — amends the two-layer version:
// 2-tier workshop bonus instead of 3, a new minimum-fill team bonus,
// and commission now runs on Final Call sales too, not just Early Bird)
// ============================================================
//
// Layer (a) + (b) below are computed at the moment of sale, for a sale
// made during EITHER a cohort's Early-Bird OR Final-Call window (never
// after sales close):
//
//  (a) Same-company tier — per company, within ONE booking:
//        1-3 delegates  -> 5%
//        4-6 delegates  -> 10%
//        7-9+ delegates -> 15% (uncapped above 7 — this is also the rate
//                               that carries through unchanged for
//                               in-house cohorts above 9, up to the
//                               20-delegate in-house cap)
//
//  (b) Workshop-volume bonus — the rep's CUMULATIVE delegate count sold
//      into this ONE cohort specifically (not across all their sales
//      everywhere), stacking additively on top of (a):
//        6+ delegates  in this cohort -> +5%
//        12+ delegates in this cohort -> +10%
//      (the earlier 15%-at-18+ tier is removed)
//
// Layer (c) is NOT computed at time of sale — it depends on whether the
// cohort ever actually reaches its minimum, which isn't known until
// later. It's applied retroactively by release-commission-payouts.js:
//
//  (c) Minimum-fill team bonus — flat +5%, added to every commission
//      record in a cohort once that cohort is confirmed to have reached
//      its minimum go-ahead headcount. Applies to ALL of a contributing
//      rep's sales in that cohort, not just the sale that tipped it over.
//      The earlier maximum-fill +5% idea has been dropped.
//
// Commission is calculated on the actual revenue collected for that
// booking (post customer-facing discounts — the overall booked price),
// matching the same "additive, not compounded" philosophy used for
// pricing itself.
//
// Payout is gated on the cohort actually confirming its minimum — see
// release-commission-payouts.js, which runs once a cohort closes to
// sales and mirrors the same gate issue-self-credits.js already uses
// for the Booking Contact rebate. A record's `payoutStatus` starts
// 'pending' at time of sale and is later set to 'released' (bonus (c)
// added, payable) or 'void' (cohort never reached minimum, not paid).

const COMPANY_TIERS = [
  { min: 1, max: 3, rate: 0.05 },
  { min: 4, max: 6, rate: 0.10 },
  { min: 7, max: 999999, rate: 0.15 },
];

const WORKSHOP_BONUS_TIERS = [
  { min: 0, max: 5, rate: 0 },
  { min: 6, max: 11, rate: 0.05 },
  { min: 12, max: 999999, rate: 0.10 },
];

const MINIMUM_FILL_BONUS_RATE = 0.05;

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

  return result;
}

module.exports = {
  calculateAndRecordCommission, checkAndRecordAccountOwnership, normalizeCompanyName,
  companyTierRate, workshopBonusRate,
  COMPANY_TIERS, WORKSHOP_BONUS_TIERS, MINIMUM_FILL_BONUS_RATE, ACCOUNT_OWNERSHIP_WINDOW_DAYS
};
