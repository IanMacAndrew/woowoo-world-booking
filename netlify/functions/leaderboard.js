const { getStore, connect } = require('./_blobs');
const { cohortsData, getProgramme, isCohortListed, salePhase } = require('./_pricing');

const DEFAULT_MIN_SEATS = 18; // matches check-cohort-minimums.js's fallback

// Serves both the rep leaderboard AND the cohort-progress view from one
// data fetch — deliberately one function, richer response, rather than two
// separate endpoints hitting the same stores twice.
//
// Commission is a flat rate now (see _commission.js), so there are no bonus
// thresholds to show. Cohort progress is about the one number that still
// matters to every rep: how close each open cohort is to its minimum
// headcount, which is what releases commission for everyone who sold into it.
//
// No company names anywhere in this response — this endpoint has no
// access control, and company names are treated as sensitive (see
// company-registry.js, which gates them behind ADMIN_SECRET). The
// company-name-inclusive version of this data goes to sales@ by email
// instead — see send-sales-director-report.js.

exports.handler = async (event) => {
  connect(event);
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
      bestSingleCohortCount: bestCohortByRep[repCode]
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
        count
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
