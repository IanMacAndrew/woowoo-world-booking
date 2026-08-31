const { getStore } = require('./_blobs');
const { workshopBonusRate, WORKSHOP_BONUS_TIERS } = require('./_commission');
const { cohortsData, getProgramme, isCohortListed, salePhase } = require('./_pricing');

const DEFAULT_MIN_SEATS = 18; // matches check-cohort-minimums.js's fallback

// Serves both the rep leaderboard AND the near-threshold cohort-progress
// view from one data fetch — deliberately one function, richer response,
// rather than two separate endpoints hitting the same stores twice.
//
// IMPORTANT ASYMMETRY, worth understanding before reading the numbers
// below: the minimum-fill team bonus (+5%) is genuinely COHORT-WIDE —
// once a cohort crosses its minimum, every rep who sold into it gets the
// bonus on all their sales there. "delegatesToMinimum" reflects that
// real shared threshold. The workshop-volume bonus (+5%/+10% at 6/12),
// by contrast, is PER REP — it's a rep's own cumulative count in that one
// cohort, not a cohort-wide pool. There's no single honest "X away for
// everyone" number for it, so repProgress lists each rep's own count and
// their own distance to their own next tier instead of pretending it's
// shared. Don't collapse this into one misleading cohort-level number.
//
// No company names anywhere in this response — this endpoint has no
// access control (same as leaderboard.js always had), and company names
// are treated as sensitive (see company-registry.js, which gates them
// behind ADMIN_SECRET). The company-name-inclusive version of this data
// goes to sales@ by email instead — see send-sales-director-report.js.

function nextWorkshopTier(count) {
  const next = WORKSHOP_BONUS_TIERS.find((t) => t.min > count);
  return next ? { threshold: next.min, delegatesNeeded: next.min - count } : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const store = getStore('bookings');

  // ---- Rep leaderboard (unchanged from before) ----
  const { blobs: repCohortBlobs } = await store.list({ prefix: 'rep-cohort-count:' });
  const totalsByRep = {};
  const bestCohortByRep = {};
  const cohortsByRep = {};
  const repCountsByCohort = {}; // cohortId -> [{repCode, count}]
  for (const b of repCohortBlobs) {
    const parts = b.key.split(':'); // rep-cohort-count:{repCode}:{cohortId}
    const repCode = parts[1];
    const cohortId = parts[2];
    const raw = await store.get(b.key);
    const count = raw ? parseInt(raw, 10) : 0;
    totalsByRep[repCode] = (totalsByRep[repCode] || 0) + count;
    cohortsByRep[repCode] = (cohortsByRep[repCode] || 0) + 1;
    bestCohortByRep[repCode] = Math.max(bestCohortByRep[repCode] || 0, count);
    if (!repCountsByCohort[cohortId]) repCountsByCohort[cohortId] = [];
    repCountsByCohort[cohortId].push({ repCode, count });
  }

  const standings = Object.entries(totalsByRep)
    .filter(([, count]) => count > 0)
    .map(([repCode, totalDelegates]) => ({
      repCode,
      totalDelegates,
      cohortsSoldInto: cohortsByRep[repCode],
      bestSingleCohortCount: bestCohortByRep[repCode],
      bestSingleCohortBonusRate: workshopBonusRate(bestCohortByRep[repCode])
    }));
  standings.sort((a, b) => b.totalDelegates - a.totalDelegates);

  // ---- Cohort progress (new) ----
  const now = new Date();
  const cohortProgress = [];
  for (const cohort of cohortsData.cohorts) {
    if (!isCohortListed(cohort, now)) continue;
    const phase = salePhase(cohort, now);
    if (phase !== 'early-bird' && phase !== 'final-call') continue; // only currently-open cohorts

    const programme = getProgramme(cohort.programme);
    const bookedRaw = await store.get(`seats-booked:${cohort.id}`);
    const booked = bookedRaw ? parseInt(bookedRaw, 10) : 0;
    const minSeats = programme.minSeats || DEFAULT_MIN_SEATS;

    const repProgress = (repCountsByCohort[cohort.id] || [])
      .map(({ repCode, count }) => ({
        repCode,
        count,
        currentBonusRate: workshopBonusRate(count),
        nextTier: nextWorkshopTier(count)
      }))
      .sort((a, b) => b.count - a.count);

    cohortProgress.push({
      cohortId: cohort.id,
      programmeName: cohort.programmeName,
      label: cohort.label,
      startDate: cohort.startDate,
      salePhase: phase,
      booked,
      minSeats,
      delegatesToMinimum: Math.max(0, minSeats - booked),
      minimumReached: booked >= minSeats,
      repProgress
    });
  }
  cohortProgress.sort((a, b) => a.delegatesToMinimum - b.delegatesToMinimum);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ standings, cohortProgress })
  };
};
