const cohortsData = require('../../cohorts.json');

function getCohort(cohortId) {
  return cohortsData.cohorts.find((c) => c.id === cohortId) || null;
}

// Early-bird is a single global window that applies to every masterclass
// cohort equally (not tied to each cohort's own start date).
function isEarlyBirdActive(now = new Date()) {
  const w = cohortsData.earlyBirdWindow;
  if (!w) return false;
  const start = new Date(w.start + 'T00:00:00+08:00'); // Malaysia time
  const end = new Date(w.end + 'T23:59:59+08:00');
  return now >= start && now <= end;
}

function seatTierDiscount(seatCount) {
  const tier = cohortsData.seatTiers.find((t) => seatCount >= t.min && seatCount <= t.max);
  return tier ? tier.discount : 0;
}

// All prices in cents (Stripe's smallest unit for MYR).
//
// IMPORTANT: discounts are ADDITIVE off the base price, not compounded/stacked.
// This mirrors the 1-Day Deep Dive pricing model exactly — e.g. Eng Lian (50%)
// and a 10-19 delegate group discount (15%) together take 65% off base, not
// 1 - (0.5 * 0.85) = ~57.5%. Stacking multiplicatively would silently
// undercharge/overcharge relative to the published tables, so don't "simplify"
// this back to perSeat *= (1 - discount) chains.
function calculatePricing({ cohortId, seatCount, bookingProtection, now = new Date() }) {
  const cohort = getCohort(cohortId);
  if (!cohort) throw new Error('Unknown cohort: ' + cohortId);
  if (seatCount < 1 || seatCount > cohortsData.maxSeats) {
    throw new Error('Seat count must be between 1 and ' + cohortsData.maxSeats);
  }

  const basePerSeat = cohortsData.basePrice;

  const earlyBird = isEarlyBirdActive(now);
  const seatDiscount = seatTierDiscount(seatCount);

  const earlyBirdAmount = earlyBird ? Math.round(basePerSeat * cohortsData.earlyBirdDiscount) : 0;
  const seatDiscountAmount = seatDiscount > 0 ? Math.round(basePerSeat * seatDiscount) : 0;

  const perSeat = Math.max(0, basePerSeat - earlyBirdAmount - seatDiscountAmount);
  const total = perSeat * seatCount;

  // "Heavily Discounted" = total discount off base is 50% or more. Eng Lian
  // alone is exactly 50%, so any booking with early-bird applied is Heavily
  // Discounted regardless of seat-tier stacking; without early-bird, seat
  // tiers alone (max 20%) never reach 50%, so it's always Standard.
  const totalDiscountFraction = basePerSeat > 0 ? (earlyBirdAmount + seatDiscountAmount) / basePerSeat : 0;
  const discountTier = totalDiscountFraction >= (cohortsData.heavilyDiscountedThreshold || 0.5)
    ? 'heavy'
    : 'standard';

  const commissionPerSeat = Math.round(perSeat * (cohortsData.salesRepCommissionRate || 0));

  // Booking Protection: non-refundable, 8% of the total purchase price for
  // the whole group booking. Upgrades cancellation terms one tier — see
  // terms-of-service.html for the actual policy language.
  const protectionFeeRate = cohortsData.bookingProtectionFeeRate || 0;
  const bookingProtectionFee = bookingProtection ? Math.round(total * protectionFeeRate) : 0;
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
    commissionPerSeat,
    commissionTotal: commissionPerSeat * seatCount,
    bookingProtectionSelected: !!bookingProtection,
    bookingProtectionFee,
    grandTotal,
    currency: cohortsData.currency
  };
}

module.exports = { getCohort, isEarlyBirdActive, seatTierDiscount, calculatePricing, cohortsData };
