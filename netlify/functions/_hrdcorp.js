// HRD Corp Allowable Cost Matrix (ACM) — Public Focus Area AI courses.
//
// HRD Corp splits training costs into two entirely separate claim paths,
// and it's important not to conflate them anywhere in our copy or pricing:
//
//   1. COURSE FEE — what the employer pays WooWoo World directly. This is
//      the number we control, and it is capped per pax/per day. If we
//      price above the cap, the excess is simply not claimable by the
//      employer (they'd pay it out of pocket) — so every published price
//      must clear the compliance check below.
//   2. TRAINEE TRAVEL & LOGISTICS — what the employer separately claims
//      for their own staff's meals/transport/hotel, based on distance to
//      our venue. This is between the employer and HRD Corp; we don't
//      charge for it, we just need to describe it accurately so buyers
//      can plan around it.
//
// Source: "Course Fee & Logistics — HRD Corp Claims" reference supplied
// 13 Aug 2026, itself citing hrdcorp.gov.my / supportcentre.hrdcorp.gov.my.

// ---- Table 1: Course Fee maximum revenue limits (per employer company) ----
const COURSE_FEE_CAPS = {
  f2fPerPaxPerDay: 300000,   // RM3,000 in cents
  rotPerPaxPerDay: 200000,   // RM2,000 in cents (Remote Online Training)
  maxClaimableSeatsPerCompany: 9,
};

// Per-duration maximum billing per company, derived directly from the cap
// (informational — same numbers as courseFeeCapsForDuration() below).
const DURATION_LIMITS = {
  1: { label: '1-Day AI Workshop', maxBillingF2FPerCompany: 2700000, maxBillingROTPerCompany: 1800000 },
  2: { label: '2-Day AI Workshop', maxBillingF2FPerCompany: 5400000, maxBillingROTPerCompany: 3600000 },
  5: { label: '5-Day AI Workshop', maxBillingF2FPerCompany: 13500000, maxBillingROTPerCompany: 9000000 },
};

// ---- Table 2: Trainee travel & logistics claim matrix (KL & Bukit Kiara) ----
// This is what the EMPLOYER claims for their own staff, not what we charge.
const LOGISTICS_CLAIMS = [
  {
    item: 'Meal Allowance',
    rule: 'Local / outstation',
    maxClaim: 'RM100 / pax / day',
    conditions: "Applicable only if meals aren't provided by the Training Provider. Minimum 4 hours of training that day."
  },
  {
    item: 'Daily Trainee Allowance',
    rule: 'Under 100km from employer\u2019s office',
    maxClaim: 'RM250 / pax / day',
    conditions: 'Covers local transit / pocket allowance for KL and Bukit Kiara-based attendees.'
  },
  {
    item: 'Daily Trainee Allowance',
    rule: 'Over 100km (outstation)',
    maxClaim: 'RM500 / pax / day',
    conditions: 'For outstation trainees travelling to KL/Bukit Kiara. Includes room + allowance.'
  },
  {
    item: 'Hotel Rental Package',
    rule: 'Booking at the venue hotel',
    maxClaim: 'As per official invoice',
    conditions: 'Claimable by the employer if bundled directly into the approved event package.'
  },
  {
    item: 'Consumable Materials',
    rule: 'Course-specific',
    maxClaim: 'RM100 / group total',
    conditions: 'Capped at RM100 flat without itemisation. Higher claims require receipts.'
  },
  {
    item: 'Public Transport / Flight',
    rule: 'Outstation to KL',
    maxClaim: 'Actual cost on receipt',
    conditions: 'Only valid for public transport (flights, trains). Personal mileage is not eligible.'
  }
];

const STRATEGIC_NOTES = [
  {
    title: 'The Inter-District Rule',
    text: "Hosting at a premium venue in Bukit Kiara or central KL means employers whose own offices are within the Klang Valley (under 100km) cannot claim the outstation RM500/day rate. They claim the RM250/day local allowance instead, or itemise specific venue/meal receipts."
  },
  {
    title: 'The "Either/Or" Clause',
    text: 'HRD Corp allows a claim for either the flat daily trainee allowance OR an itemised meal allowance on the same training day, never both — this prevents double-dipping on food costs.'
  },
  {
    title: 'The 9-Seat Company Cap',
    text: 'HRD Corp caps course-fee claims at 9 participants per individual company on public-cohort training. A single company can send more than 9 delegates to one of our cohorts, but only the first 9 seats from that company are claimable — any beyond that are payable in full, without a claim.'
  }
];

function courseFeeCapsForDuration(days, mode = 'f2f') {
  const perDayCap = mode === 'rot' ? COURSE_FEE_CAPS.rotPerPaxPerDay : COURSE_FEE_CAPS.f2fPerPaxPerDay;
  return {
    perPaxPerDayCap: perDayCap,
    perPaxTotalCap: perDayCap * days,
    maxBillingPerCompany: perDayCap * days * COURSE_FEE_CAPS.maxClaimableSeatsPerCompany
  };
}

// Checks a per-pax course fee (in cents) against the HRD Corp cap for its
// duration. Returns { compliant, perDayRate, cap, headroom } so callers
// can both gate on it and display "X% of cap used" style messaging.
function checkCourseFeeCompliance({ pricePerPaxCents, days, mode = 'f2f' }) {
  const perDayRate = Math.round(pricePerPaxCents / days);
  const caps = courseFeeCapsForDuration(days, mode);
  return {
    compliant: pricePerPaxCents <= caps.perPaxTotalCap,
    perDayRate,
    perPaxTotalCap: caps.perPaxTotalCap,
    perPaxPerDayCap: caps.perPaxPerDayCap,
    headroomCents: caps.perPaxTotalCap - pricePerPaxCents
  };
}

module.exports = {
  COURSE_FEE_CAPS,
  DURATION_LIMITS,
  LOGISTICS_CLAIMS,
  STRATEGIC_NOTES,
  courseFeeCapsForDuration,
  checkCourseFeeCompliance
};
