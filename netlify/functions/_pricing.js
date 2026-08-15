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

// Sale lifecycle for every cohort, computed purely from its own startDate —
// no per-cohort window needs setting by hand:
//
//   40+ days out : cohort is listed at all (gives reps a full 20-day
//                   Early-Bird selling window before Fire Sale starts)
//   20-39 days out: Early Bird (each format's own earlyBirdDiscount, e.g.
//                   60% for Masterclass, 50% for Deep/Deeper Dive)
//   15-19 days out: Fire Sale — flat 50% off for every format, reps earn
//                   no commission on Fire Sale sales (see _commission.js)
//   <15 days out : Closed, no further bookings. This 15-day floor is
//                   deliberate, not arbitrary — HRD Corp bans any grant
//                   modification within 14 days of an event, so closing
//                   sales at 15 leaves a 1-day safety buffer before that
//                   lock rather than running right up against it.
const SALE_PHASES = {
  get MIN_DAYS_TO_LIST() { return cohortsData.minDaysToList ?? 40; },
  get EARLY_BIRD_ENDS_DAYS_OUT() { return cohortsData.earlyBirdEndsDaysOut ?? 20; },
  get FIRE_SALE_ENDS_DAYS_OUT() { return cohortsData.fireSaleEndsDaysOut ?? 15; },
  get FIRE_SALE_DISCOUNT() { return cohortsData.fireSaleDiscount ?? 0.5; },
};

function daysUntilStart(cohort, now = new Date()) {
  const eventStart = new Date(cohort.startDate + 'T00:00:00+08:00'); // Malaysia time
  return Math.floor((eventStart.getTime() - now.getTime()) / MS_PER_DAY);
}

// 'listed' means "40+ days out" — whether a cohort should appear at all.
// A cohort already listed keeps counting down through its own lifecycle
// as time passes; this only gates first appearance, not ongoing display.
function isCohortListed(cohort, now = new Date()) {
  return daysUntilStart(cohort, now) >= SALE_PHASES.MIN_DAYS_TO_LIST;
}

// 'early-bird' | 'fire-sale' | 'closed'
function salePhase(cohort, now = new Date()) {
  const d = daysUntilStart(cohort, now);
  if (d >= SALE_PHASES.EARLY_BIRD_ENDS_DAYS_OUT) return 'early-bird';
  if (d >= SALE_PHASES.FIRE_SALE_ENDS_DAYS_OUT) return 'fire-sale';
  return 'closed';
}

function isEarlyBirdActive(cohort, now = new Date()) {
  return salePhase(cohort, now) === 'early-bird';
}

function isFireSaleActive(cohort, now = new Date()) {
  return salePhase(cohort, now) === 'fire-sale';
}

function isSaleClosed(cohort, now = new Date()) {
  return salePhase(cohort, now) === 'closed';
}

function earlyBirdCutoffDate(cohort) {
  const [y, m, d] = cohort.startDate.split('-').map(Number);
  const cutoff = new Date(Date.UTC(y, m - 1, d) - SALE_PHASES.EARLY_BIRD_ENDS_DAYS_OUT * MS_PER_DAY);
  return cutoff.toISOString().slice(0, 10);
}

function fireSaleEndDate(cohort) {
  const [y, m, d] = cohort.startDate.split('-').map(Number);
  const end = new Date(Date.UTC(y, m - 1, d) - SALE_PHASES.FIRE_SALE_ENDS_DAYS_OUT * MS_PER_DAY);
  return end.toISOString().slice(0, 10);
}

function seatTierDiscount(seatCount, programme) {
  const tiers = (programme && programme.seatTiers) || cohortsData.seatTiers;
  const tier = tiers.find((t) => seatCount >= t.min && seatCount <= t.max);
  return tier ? tier.discount : 0;
}

function getVenue(venueId) {
  if (!venueId) return null;
  return (cohortsData.venues || []).find((v) => v.id === venueId) || null;
}

// All prices in cents (Stripe's smallest unit for MYR).
//
// IMPORTANT: discounts are ADDITIVE off the base price, not compounded/stacked.
// This mirrors the 1-Day Deep Dive pricing model exactly — e.g. the early-bird
// discount (50%) and a 10-19 delegate group discount (15%) together take 65%
// off base, not 1 - (0.5 * 0.85) = ~57.5%. Stacking multiplicatively would
// silently undercharge/overcharge relative to the published tables, so don't
// "simplify" this back to perSeat *= (1 - discount) chains.
function calculatePricing({ cohortId, seatCount, bookingProtection, venueId, now = new Date() }) {
  const cohort = getCohort(cohortId);
  if (!cohort) throw new Error('Unknown cohort: ' + cohortId);

  const phase = salePhase(cohort, now);
  if (phase === 'closed') {
    throw new Error('Sales for this cohort have closed. Delegates within 15 days of the start date can no longer be added — this keeps every booking inside HRD Corp\u2019s 14-day claim window.');
  }

  const programme = getProgramme(cohort.programme);
  const maxSeats = programme.maxSeats || cohortsData.maxSeats;
  // NOTE: programme.minSeats (e.g. Masterclass's 12) is a COHORT-level fill
  // target, not a per-purchase floor — multiple companies each buying a
  // handful of seats is exactly how a cohort is meant to reach it. A single
  // checkout only ever needs at least 1 seat; whether the cohort as a whole
  // has cleared its minimum by the early-bird deadline is checked
  // separately (see checkCohortMinimums in _commission.js) and drives the
  // fire-sale rescue flow, not checkout eligibility.
  if (seatCount < 1 || seatCount > maxSeats) {
    throw new Error(`Seat count must be between 1 and ${maxSeats}`);
  }

  const basePerSeat = programme.basePrice;

  const earlyBird = phase === 'early-bird';
  const fireSale = phase === 'fire-sale';
  const seatDiscount = seatTierDiscount(seatCount, programme);

  // Fire Sale is a flat 50% off for every format, replacing (not stacking
  // with) that format's own early-bird rate — it's a distinct, simpler
  // clearance mechanism, not an extension of early-bird.
  const earlyBirdAmount = earlyBird
    ? Math.round(basePerSeat * programme.earlyBirdDiscount)
    : fireSale
      ? Math.round(basePerSeat * SALE_PHASES.FIRE_SALE_DISCOUNT)
      : 0;
  const seatDiscountAmount = seatDiscount > 0 ? Math.round(basePerSeat * seatDiscount) : 0;

  // Venue surcharge (if any) is a flat per-seat add-on for the catering/venue
  // upgrade — applied AFTER discounts, never discounted itself, since it's a
  // pass-through cost rather than part of the course fee.
  const venue = getVenue(venueId);
  const venueSurchargePerSeat = venue ? (venue.surchargePerSeat || 0) : 0;

  const perSeatBeforeVenue = Math.max(0, basePerSeat - earlyBirdAmount - seatDiscountAmount);
  const perSeat = perSeatBeforeVenue + venueSurchargePerSeat;
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
    salePhase: phase,
    earlyBirdApplied: earlyBird,
    fireSaleApplied: fireSale,
    earlyBirdAmount,
    seatDiscountApplied: seatDiscount,
    seatDiscountAmount,
    venue,
    venueSurchargePerSeat,
    discountTier,
    bookingProtectionSelected: !!bookingProtection,
    bookingProtectionFee,
    grandTotal,
    currency: cohortsData.currency
  };
}

module.exports = {
  getCohort, getProgramme, isEarlyBirdActive, isFireSaleActive, isSaleClosed,
  salePhase, isCohortListed, daysUntilStart, earlyBirdCutoffDate, fireSaleEndDate,
  seatTierDiscount, getVenue, calculatePricing, cohortsData, SALE_PHASES
};
