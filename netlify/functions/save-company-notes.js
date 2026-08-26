const { getStore } = require('./_blobs');

// Free-text notes about a target company, for use on the NEXT follow-up call —
// separate from Call notes (which just get folded into the one-off follow-up
// email). This is persistent reference material: what you learned, who else
// to loop in, budget signals, objections raised, etc.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const adminSecret = event.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const targetId = (body.targetId || '').trim();
  const notes = (body.notes || '').trim();
  if (!targetId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing targetId.' }) };
  }

  try {
    const store = getStore('campaign-company-notes');
    await store.setJSON(`notes:${targetId}`, { targetId, notes, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Failed to save company notes for', targetId, err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save — please try again.' }) };
  }

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
};
