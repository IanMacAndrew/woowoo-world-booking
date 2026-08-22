const { getStore } = require('./_blobs');

// Internal tool: list referrals awaiting review, and mark one paid or
// rejected. Protected by ADMIN_SECRET (same pattern as
// issue-transfer-credit.js / company-registry.js) -- not real user auth,
// just enough to stop this being hit blind.

exports.handler = async (event) => {
  const adminSecret = event.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const store = getStore('bookings');

  if (event.httpMethod === 'GET') {
    const { blobs } = await store.list({ prefix: 'referral:' });
    const referrals = [];
    for (const b of blobs) {
      const record = await store.get(b.key, { type: 'json' });
      if (record) referrals.push(record);
    }
    referrals.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referrals })
    };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }
    const { referralId, newStatus } = body;
    if (!referralId || !['paid', 'rejected'].includes(newStatus)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'referralId and a valid newStatus (paid | rejected) are required.' }) };
    }
    const record = await store.get(`referral:${referralId}`, { type: 'json' });
    if (!record) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Referral not found' }) };
    }
    record.status = newStatus;
    record.resolvedAt = new Date().toISOString();
    await store.setJSON(`referral:${referralId}`, record);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, referral: record })
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
