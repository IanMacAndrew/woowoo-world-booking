const { getStore } = require('./_blobs');
const { normalizeCompanyName } = require('./_commission');

// Logs a warm-intro referral: a rep tells us they gave a client's C-suite
// contact's referral to someone deeper in the org. If that company books
// within 90 days, it's flagged in the daily Sales Director report for a
// human to review and pay a flat bonus — see send-referral-bonus-report.js
// for the matching logic and REFERRAL_BONUS_AMOUNT_CENTS.
//
// Deliberately NOT auto-paid: self-reported referral claims are easy to
// game (a rep could log a referral for every company that looks likely to
// book anyway), and at current volume a human glance before payout costs
// little and avoids setting a bad precedent. This function only logs the
// claim — matching and payout review happen downstream.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const salesCode = (body.salesCode || '').trim().toUpperCase();
  const contactName = (body.contactName || '').trim();
  const companyName = (body.companyName || '').trim();
  const department = (body.department || '').trim();
  const note = (body.note || '').trim();

  if (!salesCode || !contactName || !companyName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Sales code, contact name, and company name are all required.' }) };
  }

  const store = getStore('bookings');

  // Same registration check used at checkout (create-checkout.js) — a
  // referral can only be logged by a code that's actually signed the
  // Sales Rep agreement, not any typed string.
  let agentRecord = null;
  try {
    agentRecord = await store.get(`sales-agent:${salesCode}`, { type: 'json' });
  } catch (err) {
    console.error('Blobs read failed (sales-agent) for', salesCode, '— rejecting referral rather than risk logging one against an unverified code:', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'Could not verify your sales code right now — please try again shortly.' }) };
  }
  if (!agentRecord) {
    return { statusCode: 400, body: JSON.stringify({ error: `Sales code "${salesCode}" isn't registered. Sign the Sales Rep agreement at /sign-up first.` }) };
  }

  const normalizedCompanyName = normalizeCompanyName(companyName);
  const referralId = `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id: referralId,
    repCode: salesCode,
    contactName,
    companyName,
    normalizedCompanyName,
    department: department || null,
    note: note || null,
    submittedAt: new Date().toISOString(),
    status: 'open', // open -> matched -> paid | rejected ; or open -> expired after 90 days with no match
  };

  await store.setJSON(`referral:${referralId}`, record);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, referralId })
  };
};
