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
  if (isEarlyBirdActive(cohort.programme, saleDate)) return true;

  const windowDays = cohortsData.commissionWindowDaysBeforeEvent || 10;
  const eventStart = new Date(cohort.startDate + 'T00:00:00+08:00');
  const cutoff = new Date(eventStart.getTime() - windowDays * MS_PER_DAY);
  return saleDate >= cutoff && saleDate <= eventStart;
}

function normalizeCompanyName(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// First-time-company bonus: walks the eligible delegates in order, and for
// each one whose company has never been seen on a previous booking (nor
// already counted earlier in THIS same booking), awards the bonus once and
// records the company as seen going forward. Returns the total bonus amount
// and the list of companies newly registered by this call.
async function applyFirstTimeCompanyBonus(store, eligibleDelegates) {
  const perDelegateBonus = cohortsData.commissionFirstTimeCompanyBonusPerDelegate || 0;
  if (!perDelegateBonus || eligibleDelegates.length === 0) {
    return { bonusAmount: 0, newCompanies: [] };
  }

  const seenThisCall = new Set();
  const newCompanies = [];
  let bonusAmount = 0;

  for (const delegate of eligibleDelegates) {
    const key = normalizeCompanyName(delegate.company);
    if (!key || seenThisCall.has(key)) continue;

    const storeKey = `company-seen:${key}`;
    const existing = await store.get(storeKey);
    if (!existing) {
      bonusAmount += perDelegateBonus;
      newCompanies.push(delegate.company);
      await store.set(storeKey, new Date().toISOString());
    }
    seenThisCall.add(key);
  }

  return { bonusAmount, newCompanies };
}

// Computes and records commission for a booking once delegate details (and
// therefore eligibility) are known. Cumulative eligible-delegate count is
// tracked per sales rep code across ALL their bookings/events (delegates
// don't need to share an organisation), and the tier rate that applies is
// based on the rep's running total AFTER this booking is added — i.e. rates
// apply going forward as a rep crosses each threshold, not retroactively to
// past bookings.
//
// Event attendance is read from the snapshot taken at the moment the sale
// was PAID (stripe-webhook.js), not queried live here — this stops a rep's
// payout from drifting based on what other reps sell into the same event
// after this sale already happened.
//
// Payout shape:
//  - "seeding": event hadn't crossed the minimum attendance threshold at
//    the moment of sale. Flat RM50/eligible delegate.
//  - "commission": tiered % (+ overage bonus + early-bird bonus, capped at
//    25%) once the event had enough attendance.
//  - Capacity-fill bonus: flat RM150/eligible delegate, added on top,
//    when THIS sale is the one that pushed the event from under 80% full
//    to 80%+ full.
//  - Deep Dive floor: for Deep Dive bookings only, the seeding/tiered
//    amount (plus capacity bonus) is floored at RM150/eligible delegate,
//    so small or early Deep Dive sales are never worth next to nothing.
//  - First-time-company bonus: flat RM50/eligible delegate whose company
//    has never appeared on a previous booking — added on top, unaffected
//    by the Deep Dive floor.
async function calculateAndRecordCommission({
  bookingId, cohortId, repCode, delegates, perSeat, createdAt,
  eventAttendanceBeforeSale, eventAttendanceAfterSale
}) {
  const store = getStore('bookings');
  const result = {
    repCode,
    eligible: false,
    payoutType: null,
    reason: null,
    eligibleDelegateCount: 0,
    rate: 0,
    commissionAmount: 0,
    capacityBonusApplied: false,
    deepDiveFloorApplied: false,
    firstTimeCompanyBonusAmount: 0,
    firstTimeCompanies: [],
    repCumulativeAfter: null
  };

  if (!repCode || repCode === 'ISM') {
    result.reason = 'No sales rep attributed to this booking';
    return result;
  }

  const cohort = getCohort(cohortId);
  const programme = getProgramme(cohort.programme);
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

  const attendanceBefore = eventAttendanceBeforeSale || 0;
  const attendanceAfter = eventAttendanceAfterSale != null ? eventAttendanceAfterSale : attendanceBefore + eligibleDelegates.length;
  const eventOk = attendanceAfter > (cohortsData.commissionMinEventAttendance || 0);

  let amount = 0;

  if (!eventOk) {
    result.payoutType = 'seeding';
    amount = (cohortsData.commissionSeedingFeePerDelegate || 0) * eligibleDelegates.length;
  } else {
    result.payoutType = 'commission';
    let rate = commissionRateForCumulative(after);
    if (after > (cohortsData.commissionOverageThreshold || Infinity)) {
      rate += cohortsData.commissionOverageBonus || 0;
    }
    if (isEarlyBirdActive(cohort.programme, saleDate)) {
      rate += cohortsData.commissionEarlyBirdBonus || 0;
    }
    rate = Math.min(rate, cohortsData.commissionRateCap || rate);
    result.rate = rate;
    amount = Math.round(perSeat * eligibleDelegates.length * rate);

    // Capacity-fill bonus: only meaningful once the event has real
    // attendance, so it's evaluated in the commission path.
    const maxSeats = cohortsData.maxSeats || 30;
    const capacityThreshold = maxSeats * (cohortsData.commissionCapacityBonusThreshold || 0.8);
    if (attendanceBefore < capacityThreshold && attendanceAfter >= capacityThreshold) {
      result.capacityBonusApplied = true;
      amount += (cohortsData.commissionCapacityBonusPerDelegate || 0) * eligibleDelegates.length;
    }
  }

  // Deep Dive floor — guarantees a minimum per-delegate payout on Deep Dive
  // bookings specifically, regardless of tier/seeding math.
  if (programme.format === 'deepdive') {
    const floorAmount = (cohortsData.commissionDeepDiveFloorPerDelegate || 0) * eligibleDelegates.length;
    if (amount < floorAmount) {
      result.deepDiveFloorApplied = true;
      amount = floorAmount;
    }
  }

  // First-time-company bonus — additive, sits outside the floor so it's
  // never absorbed by it.
  const { bonusAmount, newCompanies } = await applyFirstTimeCompanyBonus(store, eligibleDelegates);
  result.firstTimeCompanyBonusAmount = bonusAmount;
  result.firstTimeCompanies = newCompanies;
  amount += bonusAmount;

  result.eligible = true;
  result.commissionAmount = amount;

  const record = {
    bookingId,
    cohortId,
    repCode,
    payoutType: result.payoutType,
    eligibleDelegateCount: eligibleDelegates.length,
    rate: result.rate,
    capacityBonusApplied: result.capacityBonusApplied,
    deepDiveFloorApplied: result.deepDiveFloorApplied,
    firstTimeCompanyBonusAmount: result.firstTimeCompanyBonusAmount,
    firstTimeCompanies: result.firstTimeCompanies,
    commissionAmount: result.commissionAmount,
    repCumulativeAfter: after,
    eventAttendanceBeforeSale: attendanceBefore,
    eventAttendanceAfterSale: attendanceAfter,
    computedAt: new Date().toISOString()
  };
  await store.setJSON(`commission:${bookingId}`, record);
  // Secondary index for the bi-weekly sales report: lets it list one rep's
  // commissions by prefix instead of scanning every booking in the system.
  await store.setJSON(`commission-by-rep:${repCode}:${record.computedAt}:${bookingId}`, record);

  return result;
}

module.exports = { calculateAndRecordCommission, commissionRateForCumulative, saleWithinCommissionWindow, normalizeCompanyName };
