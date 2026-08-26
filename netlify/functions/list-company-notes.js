const { getStore } = require('./_blobs');

// Returns all saved company notes, keyed by targetId, so the admin console
// can pre-fill each card with whatever was learned on the last call.

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const adminSecret = event.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const result = {};
  try {
    const store = getStore('campaign-company-notes');
    const { blobs } = await store.list({ prefix: 'notes:' });
    for (const b of blobs) {
      const record = await store.get(b.key, { type: 'json' });
      if (record) result[record.targetId] = record;
    }
  } catch (err) {
    console.error('Failed to list company notes:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load notes.' }) };
  }

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, notes: result }) };
};
