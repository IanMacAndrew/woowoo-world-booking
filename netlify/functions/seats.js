const { getStore } = require('@netlify/blobs');
const { cohortsData } = require('./_pricing');

exports.handler = async (event) => {
  const cohortId = event.queryStringParameters && event.queryStringParameters.cohortId;

  const store = getStore('bookings');
  const cohortsToCheck = cohortId
    ? [cohortId]
    : cohortsData.cohorts.map((c) => c.id);

  const results = {};
  for (const id of cohortsToCheck) {
    const raw = await store.get(`seats-booked:${id}`);
    const booked = raw ? parseInt(raw, 10) : 0;
    results[id] = {
      booked,
      remaining: Math.max(0, cohortsData.maxSeats - booked),
      max: cohortsData.maxSeats,
      full: booked >= cohortsData.maxSeats
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(cohortId ? results[cohortId] : results)
  };
};
