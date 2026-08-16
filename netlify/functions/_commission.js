const { getStore } = require('./_blobs');
const { getCohort, getProgramme, salePhase } = require('./_pricing');

// ============================================================
// Sales Commission Scheme (approved version — replaces the old
// cumulative-tier/seeding-fee/capacity-bonus model entirely)
// ============================================================
//
// Two layers, both computed only on sales made during a cohort's own
// Early-Bird window (never Fire Sale — reps only sell in Early Bird):
//
//  (a) Same-company tier — per company, within ONE booking:
//        1-3 delegates  -> 5%
//        4-6 delegates  -> 10%
//        7-9+ delegates -> 15% (uncapped above 7)
//
//  (b) Workshop-volume bonus — the rep's CUMULATIVE delegate count sold
//      into this ONE cohort specifically (not across all their sales
//      everywhere), stacking additively on top of (a):
//        6+ delegates  in this cohort -> +5%
//        12+ delegates in this cohort -> +10%
//        18+ delegates in this cohort -> +15%
//
// Commission is calculated on the actual revenue collected for that
// booking (post customer-facing discounts), matching the same
// "additive, not compounded" philosophy used for pricing itself.

const COMPANY_TIERS = [
  { min: 1, max: 3, rate: 0.05 },
  { min: 4, max: 6, rate: 0.10 },
  { min: 7, max: 999999, rate: 0.15 },
];

const WORKSHOP_BONUS_TIERS = [
  { min: 0, max: 5, rate: 0 },
  { min: 6, max: 11, rate: 0.05 },
  { min: 12, max: 17, rate: 0.10 },
  { min: 18, max: 999999, rate: 0.15 },
];

function companyTierRate(delegateCount) {
  const tier = COMPANY_TIERS.find((t) => delegateCount >= t.min && delegateCount <= t.max);
  return tier ? tier.rate : 0;
}

function workshopBonusRate(cumulativeInCohort) {
  const tier = WORKSHOP_BONUS_TIERS.find((t) => cumulativeInCohort >= t.min && cumulativeInCohort <= t.max);
  return tier ? tier.rate : 0;
}

// Computes and records commission for a booking at the moment it's paid
// (called from stripe-webhook.js). Unlike the old scheme, this needs no
// delegate-eligibility data — it runs on seat count and revenue alone, so
// it can fire immediately at payment, not later once the delegate form is
// submitted.
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

  if (salePhase(cohort, saleDate) !== 'early-bird') {
    result.reason = 'Sale was made outside the Early-Bird window (Fire Sale and post-close sales don\u2019t earn commission)';
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
    companyTierRate: companyRate,
    workshopBonusRate: bonusRate,
    totalRate,
    commissionAmount: amount,
    repCumulativeInCohortAfter: after,
    computedAt: new Date().toISOString()
  };
  await store.setJSON(`commission:${bookingId}`, record);
  // Secondary index for the sales report: lets it list one rep's
  // commissions by prefix instead of scanning every booking in the system.
  await store.setJSON(`commission-by-rep:${repCode}:${record.computedAt}:${bookingId}`, record);

  return result;
}

module.exports = { calculateAndRecordCommission, companyTierRate, workshopBonusRate, COMPANY_TIERS, WORKSHOP_BONUS_TIERS };
