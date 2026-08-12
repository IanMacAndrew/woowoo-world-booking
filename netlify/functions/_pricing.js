const cohortsData = require('../../cohorts.json');

function getCohort(cohortId) {
  return cohortsData.cohorts.find((c) => c.id === cohortId) || null;
}

function getProgramme(programmeKey) {
  const p = cohortsData.programmes[programmeKey];
  if (!p) throw new Error('Unknown programme: ' + programmeKey);
  return p;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Early-bird rule, applied identically to every cohort/event: it's
// available with no start restriction, and switches off automatically
// N days (earlyBirdDaysBeforeEvent, default 15) before that specific
// cohort's own date. Computed from each cohort's startDate rather than a
// stored window, so a new cohort (a fresh Bootcamp date, a weekday
// top-up) gets the correct cutoff automatically without anyone having to
// remember to compute and set it by hand.
function isEarlyBirdActive(cohort, now = new Date()) {
  const daysBefore = cohortsData.earlyBirdDaysBeforeEvent ?? 15;
  const eventStart = new Date(cohort.startDate + 'T00:00:00+08:00'); // Malaysia time
  const cutoff = new Date(eventStart.getTime() - daysBefore * MS_PER_DAY + (23 * 60 + 59) * 60 * 1000); // end of that cutoff day
  return now <= cutoff;
}

function earlyBirdCutoffDate(cohort) {
  const daysBefore = cohortsData.earlyBirdDaysBeforeEvent ?? 15;
  const [y, m, d] = cohort.startDate.split('-').map(Number);
  // Pure calendar-date subtraction — Date.UTC here is just neutral scratch
  // space for the arithmetic, not a real timezone-aware instant, so no
  // day is lost converting back to a Y-M-D string afterward.
  const cutoff = new Date(Date.UTC(y, m - 1, d) - daysBefore * MS_PER_DAY);
  return cutoff.toISOString().slice(0, 10);
}

function seatTierDiscount(seatCount) {
  const tier = cohortsData.seatTiers.find((t) => seatCount >= t.min && seatCount <= t.max);
  return tier ? tier.discount : 0;
}

// All prices in cents (Stripe's smallest unit for MYR).
//
// IMPORTANT: discounts are ADDITIVE off the base price, not compounded/stacked.
// This mirrors the 1-Day Deep Dive pricing model exactly — e.g. the early-bird
// discount (50%) and a 10-19 delegate group discount (15%) together take 65%
// off base, not 1 - (0.5 * 0.85) = ~57.5%. Stacking multiplicatively would
// silently undercharge/overcharge relative to the published tables, so don't
// "simplify" this back to perSeat *= (1 - discount) chains.
function calculatePricing({ cohortId, seatCount, bookingProtection, now = new Date() }) {
  const cohort = getCohort(cohortId);
  if (!cohort) throw new Error('Unknown cohort: ' + cohortId);
  if (seatCount < 1 || seatCount > cohortsData.maxSeats) {
    throw new Error('Seat count must be between 1 and ' + cohortsData.maxSeats);
  }

  const programme = getProgramme(cohort.programme);
  const basePerSeat = programme.basePrice;

  const earlyBird = isEarlyBirdActive(cohort, now);
  const seatDiscount = seatTierDiscount(seatCount);

  const earlyBirdAmount = earlyBird ? Math.round(basePerSeat * programme.earlyBirdDiscount) : 0;
  const seatDiscountAmount = seatDiscount > 0 ? Math.round(basePerSeat * seatDiscount) : 0;

  const perSeat = Math.max(0, basePerSeat - earlyBirdAmount - seatDiscountAmount);
  const total = perSeat * seatCount;

  // "Heavily Discounted" = total discount off base is 50% or more. Early-bird
  // alone is exactly 50%, so any booking with early-bird applied is Heavily
  // Discounted regardless of seat-tier stacking; without early-bird, seat
  // tiers alone (max 20%) never reach 50%, so it's always Standard.
  const totalDiscountFraction = basePerSeat > 0 ? (earlyBirdAmount + seatDiscountAmount) / basePerSeat : 0;
  const discountTier = totalDiscountFraction >= (cohortsData.heavilyDiscountedThreshold || 0.5)
    ? 'heavy'
    : 'standard';

  const bookingProtectionFee = bookingProtection ? Math.round(total * (cohortsData.bookingProtectionFeeRate || 0)) : 0;
  const grandTotal = total + bookingProtectionFee;

  return {
    cohort,
    basePerSeat,
    perSeat,
    seatCount,
    total,
    earlyBirdApplied: earlyBird,
    earlyBirdAmount,
    seatDiscountApplied: seatDiscount,
    seatDiscountAmount,
    discountTier,
    bookingProtectionSelected: !!bookingProtection,
    bookingProtectionFee,
    grandTotal,
    currency: cohortsData.currency
  };
}

module.exports = { getCohort, getProgramme, isEarlyBirdActive, earlyBirdCutoffDate, seatTierDiscount, calculatePricing, cohortsData };
