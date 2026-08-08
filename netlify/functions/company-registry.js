const { getStore } = require('./_blobs');

// Internal tool: view the company-seen registry that powers the
// first-time-company commission bonus. Protected by ADMIN_SECRET (same
// pattern as issue-transfer-credit.js) — not real user auth, just enough
// to stop this being hit blind, since company names are effectively a
// client list.

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const adminSecret = event.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const store = getStore('bookings');
  const { blobs } = await store.list({ prefix: 'company-seen:' });

  const companies = [];
  for (const b of blobs) {
    const record = await store.get(b.key, { type: 'json' });
    if (!record) continue;
    companies.push({ name: record.name, firstSeenAt: record.firstSeenAt });
  }

  companies.sort((a, b) => new Date(b.firstSeenAt) - new Date(a.firstSeenAt));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: companies.length, companies })
  };
};
