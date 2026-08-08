const { getStore } = require('./_blobs');
const { getCohort, getProgramme, isEarlyBirdActive, cohortsData } = require('./_pricing');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function commissionRateForCumulative(eligibleCumulative) {
  const tier = cohortsData.commissionTiers.find((t) => eligibleCumulative >= t.min && eligibleCumulative <= t.max);
  return tier ? tier.rate : 0;
}

// Timing gate: the SALE must have happened either during the programme's
// early-bird window, or within N days before the event's start date.
function saleWithinCommissionWindow(cohort, saleDate) {
  const programme = getProgramme(cohort.programme);
  if (isEarlyBirdActive(cohort.programme, saleDate)) return true;

  const windowDays = cohortsData.commissionWindowDaysBeforeEvent || 10;
  const eventStart = new Date(cohort.startDate + 'T00:00:00+08:00');
  const cutoff = new Date(eventStart.getTime() - windowDays * MS_PER_DAY);
  return saleDate >= cutoff && saleDate <= eventStart;
}

// Event-size gate: this specific event/cohort's total confirmed attendance
// (across ALL bookings, not just this one) must exceed the threshold before
// ANY commission counts on it — checked against the seats-booked counter
// that's already maintained by the webhook.
async function eventMeetsAttendanceThreshold(store, cohortId) {
  const raw = await store.get(`seats-booked:${cohortId}`);
  const totalSeats = raw ? parseInt(raw, 10) : 0;
  return totalSeats > (cohortsData.commissionMinEventAttendance || 0);
}

// Computes and records commission for a booking once delegate details (and
// therefore eligibility) are known. Cumulative eligible-delegate count is
// tracked per sales rep code across ALL their bookings/events (delegates
// don't need to share an organisation), and the tier rate that applies is
// based on the rep's running total AFTER this booking is added — i.e. rates
// apply going forward as a rep crosses each threshold, not retroactively to
// past bookings.
//
// Two payout paths:
//  - "seeding": the event hasn't yet crossed the minimum attendance
//    threshold. Pays a flat per-delegate fee regardless of tier, so an
//    early trailblazing sale on a new event isn't worth nothing.
//  - "commission": normal tiered-percentage payout once the event has
//    enough attendance. Base tier + the >30-cumulative overage bonus +
//    the early-bird bonus are additive, but the total is hard-capped
//    (commissionRateCap) to protect margin as event costs rise.
// Both paths require: a real (non-default) sales rep code, at least one
// eligible (C-Suite/dept-head) delegate on the booking, and the sale itself
// falling within the early-bird window or the pre-event window.
async function calculateAndRecordCommission({ bookingId, cohortId, repCode, delegates, perSeat, createdAt }) {
  const store = getStore('bookings');
  const result = {
    repCode,
    eligible: false,
    payoutType: null,
    reason: null,
    eligibleDelegateCount: 0,
    rate: 0,
    commissionAmount: 0,
    repCumulativeAfter: null
  };

  if (!repCode || repCode === 'ISM') {
    result.reason = 'No sales rep attributed to this booking';
    return result;
  }

  const cohort = getCohort(cohortId);
  const saleDate = new Date(createdAt);

  if (!saleWithinCommissionWindow(cohort, saleDate)) {
    result.reason = 'Sale was made outside the early-bird window and outside the 10-day pre-event window';
    return result;
  }

  const eligibleDelegates = (delegates || []).filter((d) => d.eligible);
  result.eligibleDelegateCount = eligibleDelegates.length;
  if (eligibleDelegates.length === 0) {
    result.reason = 'No delegates on this booking were marked C-Suite / department head';
    return result;
  }

  const ledgerKey = `rep-eligible-count:${repCode}`;
  const priorRaw = await store.get(ledgerKey);
  const prior = priorRaw ? parseInt(priorRaw, 10) : 0;
  const after = prior + eligibleDelegates.length;
  await store.set(ledgerKey, String(after));
  result.repCumulativeAfter = after;

  const eventOk = await eventMeetsAttendanceThreshold(store, cohortId);

  if (!eventOk) {
    // Seeding path: flat fee, event hasn't hit the attendance threshold yet.
    const seedingFeePerDelegate = cohortsData.commissionSeedingFeePerDelegate || 0;
    result.eligible = true;
    result.payoutType = 'seeding';
    result.commissionAmount = seedingFeePerDelegate * eligibleDelegates.length;
  } else {
    // Commission path: tiered rate + overage bonus + early-bird bonus, capped.
    let rate = commissionRateForCumulative(after);
    if (after > (cohortsData.commissionOverageThreshold || Infinity)) {
      rate += cohortsData.commissionOverageBonus || 0;
    }
    if (isEarlyBirdActive(cohort.programme, saleDate)) {
      rate += cohortsData.commissionEarlyBirdBonus || 0;
    }
    rate = Math.min(rate, cohortsData.commissionRateCap || rate);

    result.eligible = true;
    result.payoutType = 'commission';
    result.rate = rate;
    result.commissionAmount = Math.round(perSeat * eligibleDelegates.length * rate);
  }

  await store.setJSON(`commission:${bookingId}`, {
    bookingId,
    cohortId,
    repCode,
    payoutType: result.payoutType,
    eligibleDelegateCount: eligibleDelegates.length,
    rate: result.rate,
    commissionAmount: result.commissionAmount,
    repCumulativeAfter: after,
    computedAt: new Date().toISOString()
  });

  return result;
}

module.exports = { calculateAndRecordCommission, commissionRateForCumulative, saleWithinCommissionWindow, eventMeetsAttendanceThreshold };
