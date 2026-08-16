const { getStore } = require('./_blobs');
const { workshopBonusRate } = require('./_commission');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const store = getStore('bookings');
  // Ledger keys are per-cohort: rep-cohort-count:{repCode}:{cohortId}
  const { blobs } = await store.list({ prefix: 'rep-cohort-count:' });

  const totalsByRep = {};
  const bestCohortByRep = {};
  const cohortsByRep = {};
  for (const b of blobs) {
    const parts = b.key.split(':'); // rep-cohort-count:{repCode}:{cohortId}
    const repCode = parts[1];
    const raw = await store.get(b.key);
    const count = raw ? parseInt(raw, 10) : 0;
    totalsByRep[repCode] = (totalsByRep[repCode] || 0) + count;
    cohortsByRep[repCode] = (cohortsByRep[repCode] || 0) + 1;
    bestCohortByRep[repCode] = Math.max(bestCohortByRep[repCode] || 0, count);
  }

  // The workshop-volume bonus is earned per cohort, not accumulated
  // globally — so "current best" is this rep's highest single-cohort
  // count, and the bonus rate that actually applies to.
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

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ standings })
  };
};
