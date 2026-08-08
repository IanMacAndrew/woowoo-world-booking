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
async function calculateAndRecordCommission({ bookingId, cohortId, repCode, delegates, perSeat, createdAt }) {
  const store = getStore('bookings');
  const result = {
    repCode,
    eligible: false,
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

  if (!(await eventMeetsAttendanceThreshold(store, cohortId))) {
    result.reason = "Event's total attendance has not yet exceeded the commission threshold";
    return result;
  }

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

  const rate = commissionRateForCumulative(after);
  const commissionAmount = Math.round(perSeat * eligibleDelegates.length * rate);

  result.eligible = true;
  result.rate = rate;
  result.commissionAmount = commissionAmount;
  result.repCumulativeAfter = after;

  await store.setJSON(`commission:${bookingId}`, {
    bookingId,
    cohortId,
    repCode,
    eligibleDelegateCount: eligibleDelegates.length,
    rate,
    commissionAmount,
    repCumulativeAfter: after,
    computedAt: new Date().toISOString()
  });

  return result;
}

module.exports = { calculateAndRecordCommission, commissionRateForCumulative, saleWithinCommissionWindow, eventMeetsAttendanceThreshold };
