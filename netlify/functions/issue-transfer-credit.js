const { getStore } = require('./_blobs');

// Internal tool: staff issue a transfer credit after manually verifying a
// Deep Dive Stripe payment (Deep Dive uses static Payment Links, so there's
// no automatic link between a Deep Dive purchase and this system yet — see
// public/admin-issue-credit.html for the form that calls this).
//
// Protected by ADMIN_SECRET (set in Netlify env vars) — not real user auth,
// just enough to stop this endpoint being hit blind. Keep the secret private.

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  let code = 'DD-';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const adminSecret = event.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { amountCents, note } = payload;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { statusCode: 400, body: 'amountCents must be a positive integer (RM in cents)' };
  }

  const store = getStore('transfer-credits');
  let code;
  // Guard against the (very unlikely) random collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    code = randomCode();
    const existing = await store.get(code, { type: 'json' }).catch(() => null);
    if (!existing) break;
  }

  const record = {
    code,
    amountCents,
    note: note || '',
    status: 'unused', // 'unused' | 'redeemed'
    issuedAt: new Date().toISOString(),
    redeemedAt: null
  };
  await store.setJSON(code, record);

  return {
    statusCode: 200,
    body: JSON.stringify({ code, amountCents })
  };
};
