const { getStore } = require('./_blobs');
const { sendEmail } = require('./_email');
const targetData = require('../../data/klang-valley-targets.json');

// Sends a single personalized campaign email to a target company contact,
// AFTER a phone call has captured their real email — this list only has
// phone numbers, there are no CEO emails to cold-email blind. Every send
// is one admin-triggered action, not a bulk blast, and every send is
// checked against a suppression list first so an unsubscribe sticks.

const CAMPAIGN_FROM_EMAIL = process.env.CAMPAIGN_FROM_EMAIL; // e.g. "Omar at WooWoo World <campaigns@mail.woowoo.world>"
const SITE_URL = process.env.SITE_URL || 'https://book.woowoo.world';

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function campaignEmailHtml({ target, email, callNotes }) {
  const firstName = (target.ceoName || '').split(' ')[0] || 'there';
  return `
    <div style="font-family:sans-serif;color:#1C0333;max-width:560px;">
      <p>Hi ${firstName},</p>
      <p>Good speaking with you just now about ${target.company}'s leadership team and where AI fits into your strategy for the year ahead.</p>
      <p>As mentioned, WooWoo World runs Strategy Led AI workshops here in Klang Valley — HRD Corp claimable, live cohorts with real companies in your own vertical rather than a generic online course. Formats range from a 1-day Deep Dive to a 5-week Masterclass for full organisational re-engineering.</p>
      <p>We're currently booking cohorts through February — a few dates are close to filling.</p>
      <p style="margin:24px 0;">
        <a href="${SITE_URL}" style="background:#C79529;color:#1C0333;padding:12px 22px;text-decoration:none;font-weight:bold;border-radius:6px;">See dates &amp; pricing</a>
      </p>
      ${callNotes ? `<p style="color:#746F82;font-size:13px;">Following up on: ${callNotes}</p>` : ''}
      <p>Happy to answer anything directly — just reply to this email.</p>
      <p>Best,<br>Omar<br>WooWoo World<br><a href="https://www.woowooworld.co" style="color:#1C0333;">www.woowooworld.co</a></p>
      <hr style="border:none;border-top:1px solid #E9ECF2;margin:24px 0;">
      <p style="color:#8F8A9C;font-size:11px;">
        WooWoo World, Malaysia. You're receiving this because we spoke by phone about AI training for ${target.company}.
        <a href="${SITE_URL}/.netlify/functions/unsubscribe?email=${encodeURIComponent(email)}" style="color:#8F8A9C;">Unsubscribe</a>
      </p>
    </div>`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const adminSecret = event.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (!CAMPAIGN_FROM_EMAIL) {
    return { statusCode: 503, body: JSON.stringify({ error: 'Campaign sending domain not configured yet (CAMPAIGN_FROM_EMAIL missing) — verify the subdomain in Resend first.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const targetId = (body.targetId || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const callNotes = (body.callNotes || '').trim();

  const target = (targetData.targets || []).find(t => t.id === targetId);
  if (!target) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown target company.' }) };
  }
  if (!isValidEmail(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
  }

  const suppressionStore = getStore('campaign-suppression');
  try {
    const suppressed = await suppressionStore.get(`suppressed:${email}`, { type: 'json' });
    if (suppressed) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, suppressed: true, error: 'This address has unsubscribed — not sending.' }) };
    }
  } catch (err) {
    console.error('Suppression check failed, sending anyway:', err);
  }

  await sendEmail({
    to: email,
    from: CAMPAIGN_FROM_EMAIL,
    subject: `Following up — AI training for ${target.company}'s leadership team`,
    html: campaignEmailHtml({ target, email, callNotes })
  });

  try {
    const sentStore = getStore('campaign-sent');
    await sentStore.setJSON(`sent:${targetId}:${Date.now()}`, {
      targetId, company: target.company, email, callNotes, sentAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Failed to log campaign send (email still sent):', err);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  };
};
