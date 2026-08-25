const { getStore } = require('./_blobs');
const { sendEmail } = require('./_email');

const OPS_NOTIFICATION_EMAIL = process.env.OPS_NOTIFICATION_EMAIL;

// Captures interest for the two "Coming Soon" formats (Drive Time Briefing,
// Bootcamp) that aren't bookable yet. Just logs the lead to Blobs and pings
// ops — no confirmation-page flow needed, the front end shows an inline
// success state. Same fail-open philosophy as the rest of checkout: a
// Blobs write failure still returns 200 so the visitor isn't shown an error
// for something that isn't their fault, but it's logged loudly so it gets
// noticed.

const PROGRAMME_NAMES = {
  briefing: 'Drive Time Briefing',
  bootcamp: 'Strategy Led Bootcamp'
};

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

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

  const programme = (body.programme || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const name = (body.name || '').trim();

  if (!PROGRAMME_NAMES[programme]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown programme.' }) };
  }
  if (!isValidEmail(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
  }

  const programmeName = PROGRAMME_NAMES[programme];
  const record = {
    id: `wl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    programme,
    programmeName,
    email,
    name: name || null,
    submittedAt: new Date().toISOString()
  };

  try {
    const store = getStore('waitlist');
    await store.setJSON(`waitlist:${programme}:${record.id}`, record);
  } catch (err) {
    console.error('Blobs write failed for waitlist signup — proceeding anyway (not the visitor\'s problem):', err);
  }

  if (OPS_NOTIFICATION_EMAIL) {
    try {
      await sendEmail({
        to: OPS_NOTIFICATION_EMAIL,
        subject: `Waitlist signup — ${programmeName}`,
        html: `<div style="font-family:sans-serif;color:#1C0333;">
          <h2>New waitlist signup</h2>
          <p><strong>${programmeName}</strong></p>
          <p>${name ? name + ' &lt;' + email + '&gt;' : email}</p>
          <p style="color:#746F82;font-size:12px;">Logged ${record.submittedAt}</p>
        </div>`
      });
    } catch (err) {
      console.error('Waitlist ops notification email failed:', err);
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  };
};
