const { getStore } = require('./_blobs');
const { getCohort } = require('./_pricing');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const token = (event.queryStringParameters || {}).token;
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing token' }) };
  }

  const store = getStore('bookings');
  const tokenRecord = await store.get(`delegate-form:${token}`, { type: 'json' });
  if (!tokenRecord) {
    return { statusCode: 404, body: JSON.stringify({ error: 'This link is invalid or has expired.' }) };
  }

  const roster = await store.get(`roster:${tokenRecord.bookingId}`, { type: 'json' });
  if (!roster) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Booking not found.' }) };
  }

  const cohort = getCohort(roster.cohortId);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      valid: true,
      alreadySubmitted: !!tokenRecord.used,
      seatCount: tokenRecord.seatCount,
      programmeName: cohort.programmeName,
      cohortLabel: cohort.label,
      trackLabel: cohort.trackLabel,
      bookingContactName: roster.bookingContact && roster.bookingContact.name
    })
  };
};
