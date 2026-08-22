const { getStore } = require('./_blobs');

// Internal tool: view account-ownership records (which rep owns which
// company for the 12-month expansion-override window — see
// checkAndRecordAccountOwnership in _commission.js). Protected by
// ADMIN_SECRET (same pattern as issue-transfer-credit.js) — not real
// user auth, just enough to stop this being hit blind, since company
// names are effectively a client list.
//
// The old "company-seen" registry this file used to expose was a
// leftover from a commission model that's since been replaced —
// nothing writes to that prefix anymore, so it's been dropped here in
// favour of the ownership records that actually matter now.

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const adminSecret = event.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const store = getStore('bookings');
  const { blobs } = await store.list({ prefix: 'company-owner:' });

  const now = new Date();
  const owners = [];
  for (const b of blobs) {
    const record = await store.get(b.key, { type: 'json' });
    if (!record) continue;
    owners.push({
      ...record,
      active: new Date(record.expiresAt) > now,
    });
  }

  owners.sort((a, b) => new Date(b.firstSaleDate) - new Date(a.firstSaleDate));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: owners.length, owners })
  };
};
