const { getStore } = require('./_blobs');
const { getCohort, salePhase } = require('./_pricing');

// ============================================================
// Sales Commission Scheme — flat rate (from Nov 2026)
// ============================================================
//
// Every sale made during a cohort's Early-Bird OR Final-Call window
// (never after sales close) earns a FLAT commission on the amount
// actually paid. There are no company tiers, no workshop-volume bonus
// and no minimum-fill bonus any more.
//
//   ISM (the company owner, house code)  -> 30%
//   Every other sales rep                -> 20%
//
// ISM-coded bookings now create a pending commission record for ISM, held
// and voided by exactly the same minimum-delegates rule as any rep (see
// release-commission-payouts.js) — with ONE exception: if the booking's
// company has an active Account Owner (below), the owner is paid 20% on
// that booking and ISM earns nothing on it.
//
// Commission is never paid on a booking that goes through the
// SELF_CREDIT path (Booking Contact chose an account credit instead).
//
// C-Suite / HOD exception: private single-company engagements for
// C-Suite/Dept Heads are bespoke, quoted separately, and sit entirely
// OFF this rate card.
//
// LEGACY RECORDS: commission records written before this scheme (no
// `rateScheme` field) were promised the old three-layer rate. They are
// NOT recalculated — release-commission-payouts.js still adds the old
// +5% minimum-fill bonus to those records only, so nobody's already
// pending commission changes underneath them.
//
// ============================================================
// Sales Manager override (unchanged)
// ============================================================
//
// Paid independently of, and never reducing, the rep's own commission —
// a manager earns this on every sale closed by any rep in their
// downline, calculated on the same deal value.
//
//   Team Lead       (2+ active reps reporting to this manager) -> 2%
//   Team Builder    (team's combined delegates this quarter >= 25) -> 3.5%
//   Team Excellence (team's combined delegates this quarter >= 40) -> 5%
//
// The old extra route to Team Excellence ("3+ reps each at their own 25%
// ceiling") was removed with the tiered rep rates: a flat 20% rep can no
// longer reach a 25% ceiling, so that route could never fire.
//
// Below 2 active reps there is no override at all. "Rolling quarter" is
// the calendar quarter the sale falls in. Evaluated incrementally at time
// of sale — no retroactive recalculation, no clawbacks.

const HOUSE_CODE = 'ISM';
const REP_COMMISSION_RATE = 0.20;
const ISM_COMMISSION_RATE = 0.30;
const COMMISSION_SCHEME = 'flat-v2';

// Only used by release-commission-payouts.js for records written under the
// old scheme (no rateScheme field).
const LEGACY_MINIMUM_FILL_BONUS_RATE = 0.05;

const MANAGER_MIN_ACTIVE_REPS = 2;
const MANAGER_TEAM_BUILDER_THRESHOLD = 25;
const MANAGER_TEAM_EXCELLENCE_VOLUME_THRESHOLD = 40;
const MANAGER_OVERRIDE_RATES = {
  none: 0,
  teamLead: 0.02,
  teamBuilder: 0.035,
  teamExcellence: 0.05,
};

function commissionRateFor(repCode) {
  return repCode === HOUSE_CODE ? ISM_COMMISSION_RATE : REP_COMMISSION_RATE;
}

// ============================================================
// Account Ownership (expansion sales)
// ============================================================
// A rep who lands the FIRST paid booking from a company becomes that
// company's Account Owner for 12 months from that sale. The payoff:
// if a LATER booking from the same company comes in under ISM (house
// default) or SELF_CREDIT — i.e. no other rep's code involved — the
// owner earns the flat rep rate (20%) on that booking.
//
// Deliberately does NOT fire, and never competes, when a DIFFERENT
// rep's code is used on a later booking — that rep just earns their
// own commission normally, no split, no arbitration. On an ISM-coded
// booking the owner is paid INSTEAD of ISM (ISM earns nothing on it).
//
// Company-name matching starts deliberately simple: lowercase, trim,
// collapse internal whitespace. No fuzzy matching yet.
const ACCOUNT_OWNERSHIP_WINDOW_DAYS = 365;

function normalizeCompanyName(name) {
  if (!name) return null;
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized || null;
}

// Returns the active owner record for a company, or null.
async function getActiveAccountOwner(store, companyName, now) {
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return null;
  const existing = await store.get(`company-owner:${normalized}`, { type: 'json' });
  if (existing && new Date(existing.expiresAt) > now) return existing;
  return null;
}

// Called on every paid booking, regardless of whether it's a rep sale,
// ISM, or SELF_CREDIT — the two branches below are mutually exclusive
// per booking (a booking either CLAIMS ownership or PAYS an existing
// owner; it can never do both).
async function checkAndRecordAccountOwnership({
  bookingId, cohortId, repCode, companyName, seatCount, revenue, createdAt
}) {
  const result = { ownershipClaimed: false, ownershipOverridePaid: false };

  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return result; // Can't track ownership without a company name.

  const store = getStore('bookings');
  const ownerKey = `company-owner:${normalized}`;
  const now = new Date(createdAt || Date.now());
  const existing = await getActiveAccountOwner(store, companyName, now);

  const isRepSale = repCode && repCode !== HOUSE_CODE && repCode !== 'SELF_CREDIT';

  if (isRepSale) {
    // Claim ownership only if nobody holds an active claim already — first
    // claimer keeps it until expiry, including against the same rep
    // re-selling (a no-op, not an extension of the window).
    if (!existing) {
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
  if (!existing) return result;

  const cohort = getCohort(cohortId);
  const phase = salePhase(cohort, now);
  if (phase !== 'early-bird' && phase !== 'final-call') return result;

  const rate = REP_COMMISSION_RATE;
  const amount = Math.round(revenue * rate);

  const record = {
    bookingId,
    cohortId,
    repCode: existing.ownerCode,
    companyName: companyName || null,
    seatCount,
    revenue,
    salePhaseAtSale: phase,
    rateScheme: COMMISSION_SCHEME,
    totalRate: rate,
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

// Computes and records commission for a booking at the moment it's paid
// (called from stripe-webhook.js). It runs on revenue alone, so it can
// fire immediately at payment. Payout is gated later by
// release-commission-payouts.js (cohort must reach its minimum).
async function calculateAndRecordCommission({
  bookingId, cohortId, repCode, companyName, seatCount, revenue, createdAt
}) {
  const store = getStore('bookings');
  const result = {
    repCode,
    eligible: false,
    reason: null,
    seatCount,
    totalRate: 0,
    commissionAmount: 0,
    repCumulativeInCohortAfter: null
  };

  // No code at all, or the Booking Contact chose an account credit — not a commission case.
  if (!repCode || repCode === 'SELF_CREDIT') {
    result.reason = repCode === 'SELF_CREDIT'
      ? 'Booking contact chose an account credit instead of rep commission'
      : 'No sales rep attributed to this booking';
    return result;
  }

  const isHouse = repCode === HOUSE_CODE;
  const cohort = getCohort(cohortId);
  const saleDate = new Date(createdAt);
  const phase = salePhase(cohort, saleDate);

  if (phase !== 'early-bird' && phase !== 'final-call') {
    result.reason = 'Sale was made outside the Early-Bird / Final-Call selling window';
    return result;
  }

  if (isHouse) {
    // An active Account Owner is paid 20% on this booking instead of ISM.
    const owner = await getActiveAccountOwner(store, companyName, saleDate);
    if (owner) {
      result.reason = `Company has an active Account Owner (${owner.ownerCode}) — the owner is paid on this booking instead of ISM`;
      return result;
    }
  } else {
    // Per-rep delegate ledger for the public leaderboard (reps only, not ISM).
    const ledgerKey = `rep-cohort-count:${repCode}:${cohortId}`;
    const priorRaw = await store.get(ledgerKey);
    const prior = priorRaw ? parseInt(priorRaw, 10) : 0;
    const after = prior + seatCount;
    await store.set(ledgerKey, String(after));
    result.repCumulativeInCohortAfter = after;
  }

  const rate = commissionRateFor(repCode);
  const amount = Math.round(revenue * rate);

  result.eligible = true;
  result.totalRate = rate;
  result.commissionAmount = amount;

  const record = {
    bookingId,
    cohortId,
    repCode,
    companyName: companyName || null,
    seatCount,
    revenue,
    salePhaseAtSale: phase,
    rateScheme: COMMISSION_SCHEME,
    totalRate: rate,
    commissionAmount: amount,
    payoutStatus: 'pending',
    repCumulativeInCohortAfter: result.repCumulativeInCohortAfter,
    computedAt: new Date().toISOString()
  };
  await store.setJSON(`commission:${bookingId}`, record);
  // Secondary index for the sales report: lets it list one rep's
  // commissions by prefix instead of scanning every booking in the system.
  await store.setJSON(`commission-by-rep:${repCode}:${record.computedAt}:${bookingId}`, record);

  return result;
}

function quarterKey(date) {
  const q = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()}-Q${q}`;
}

// Sums, for every rep on a given manager's team, that rep's delegate
// count from commission records computed within the given quarter —
// the "team's combined delegates this quarter" figure the Team Builder /
// Team Excellence tiers key off.
async function getTeamQuarterStats(store, managerCode, quarter) {
  const { blobs } = await store.list({ prefix: `manager-team:${managerCode}:` });
  const repCodes = blobs.map((b) => b.key.split(':')[2]).filter(Boolean);

  let teamVolume = 0;

  for (const repCode of repCodes) {
    const { blobs: repCommissions } = await store.list({ prefix: `commission-by-rep:${repCode}:` });
    for (const b of repCommissions) {
      const record = await store.get(b.key, { type: 'json' });
      if (!record || !record.computedAt) continue;
      if (record.recordType === 'ownership-override') continue; // not this rep's own selling volume
      if (quarterKey(new Date(record.computedAt)) !== quarter) continue;
      teamVolume += record.seatCount || 0;
    }
  }

  return { repCodes, teamVolume };
}

function managerOverrideTierForStats({ activeRepCount, teamVolume }) {
  if (activeRepCount < MANAGER_MIN_ACTIVE_REPS) return { tier: 'none', rate: MANAGER_OVERRIDE_RATES.none };
  if (teamVolume >= MANAGER_TEAM_EXCELLENCE_VOLUME_THRESHOLD) {
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

  if (!repCode || repCode === HOUSE_CODE || repCode === 'SELF_CREDIT') {
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
  const { teamVolume } = await getTeamQuarterStats(store, managerCode, quarter);

  const { tier, rate } = managerOverrideTierForStats({ activeRepCount, teamVolume });

  result.managerCode = managerCode;
  result.overrideTier = tier;
  result.overrideRate = rate;
  result.teamVolumeThisQuarter = teamVolume;
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
  normalizeCompanyName, commissionRateFor, quarterKey, managerOverrideTierForStats,
  HOUSE_CODE, REP_COMMISSION_RATE, ISM_COMMISSION_RATE, COMMISSION_SCHEME,
  LEGACY_MINIMUM_FILL_BONUS_RATE, ACCOUNT_OWNERSHIP_WINDOW_DAYS,
  MANAGER_MIN_ACTIVE_REPS, MANAGER_TEAM_BUILDER_THRESHOLD,
  MANAGER_TEAM_EXCELLENCE_VOLUME_THRESHOLD, MANAGER_OVERRIDE_RATES
};
