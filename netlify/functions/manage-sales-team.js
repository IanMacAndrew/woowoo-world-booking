const { getStore } = require('./_blobs');

// Internal tool: list every registered sales_rep / sales_manager, and
// assign (or change) which manager a rep reports to. Protected by
// ADMIN_SECRET (same pattern as manage-referral.js / company-registry.js)
// -- not real user auth, just enough to stop this being hit blind.
//
// Needed because the managerCode field on a sales-agent record is new —
// every rep who signed up before this shipped has managerCode: null and
// needs assigning here, retroactively, one time. New reps can also set
// it themselves at signup (see sales-agent-signup.js), so this is for
// fixing that up after the fact, or for reassigning someone to a
// different manager later.

exports.handler = async (event) => {
  const adminSecret = event.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const store = getStore('bookings');

  if (event.httpMethod === 'GET') {
    const { blobs } = await store.list({ prefix: 'sales-agent:' });
    const agents = [];
    for (const b of blobs) {
      const record = await store.get(b.key, { type: 'json' });
      if (record) agents.push(record);
    }
    agents.sort((a, b) => (a.kind === 'sales_manager' ? -1 : 1) - (b.kind === 'sales_manager' ? -1 : 1) || a.salesCode.localeCompare(b.salesCode));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents })
    };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }
    const { repCode, newManagerCode } = body; // newManagerCode: string to assign, or null to unassign
    if (!repCode) {
      return { statusCode: 400, body: JSON.stringify({ error: 'repCode is required.' }) };
    }

    const repKey = `sales-agent:${repCode}`;
    const repRecord = await store.get(repKey, { type: 'json' }).catch(() => null);
    if (!repRecord) {
      return { statusCode: 404, body: JSON.stringify({ error: `No sales-agent record found for ${repCode}.` }) };
    }
    if (repRecord.kind !== 'sales_rep') {
      return { statusCode: 400, body: JSON.stringify({ error: `${repCode} is a ${repRecord.kind}, not a sales_rep — only reps report to a manager.` }) };
    }

    if (newManagerCode) {
      const managerKey = `sales-agent:${newManagerCode}`;
      const managerRecord = await store.get(managerKey, { type: 'json' }).catch(() => null);
      if (!managerRecord || managerRecord.kind !== 'sales_manager') {
        return { statusCode: 400, body: JSON.stringify({ error: `${newManagerCode} isn't a registered Sales Manager code.` }) };
      }
    }

    // Remove any existing team-index entry for this rep under their old
    // manager (if any) before writing the new one, so a rep only ever
    // shows up under one manager at a time.
    if (repRecord.managerCode && repRecord.managerCode !== newManagerCode) {
      await store.delete(`manager-team:${repRecord.managerCode}:${repCode}`).catch(() => {});
    }

    repRecord.managerCode = newManagerCode || null;
    await store.setJSON(repKey, repRecord);

    if (newManagerCode) {
      await store.setJSON(`manager-team:${newManagerCode}:${repCode}`, {
        repCode,
        managerCode: newManagerCode,
        joinedAt: new Date().toISOString(),
      });
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, repCode, managerCode: repRecord.managerCode })
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
