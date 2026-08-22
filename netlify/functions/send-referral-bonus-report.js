// Scheduled daily (see netlify.toml). Matches open referrals (logged via
// refer.html / log-referral.js) against paid bookings by normalized
// company name, within a 90-day window of the referral being logged.
// A match does NOT trigger any payment automatically — it moves the
// referral to 'matched' and includes it in the email to sales@ for a
// human to review and pay the flat bonus manually. See log-referral.js
// for why this stays manual rather than automated.
const { getStore } = require('./_blobs');
const { normalizeCompanyName } = require('./_commission');
const { sendEmail } = require('./_email');
const cohortsData = require('../../cohorts.json');

const REFERRAL_WINDOW_DAYS = 90;
const REFERRAL_BONUS_AMOUNT_CENTS = cohortsData.referralBonusAmountCents ?? 20000; // RM200 default

exports.handler = async () => {
  const store = getStore('bookings');
  const now = new Date();

  const { blobs: referralBlobs } = await store.list({ prefix: 'referral:' });
  const openReferrals = [];
  for (const b of referralBlobs) {
    const record = await store.get(b.key, { type: 'json' });
    if (record && record.status === 'open') openReferrals.push(record);
  }

  if (openReferrals.length === 0) {
    return { statusCode: 200, body: 'Nothing to check — no open referrals' };
  }

  // Pull every paid booking once, rather than re-scanning per referral.
  const { blobs: rosterBlobs } = await store.list({ prefix: 'roster:' });
  const paidBookings = [];
  for (const b of rosterBlobs) {
    const roster = await store.get(b.key, { type: 'json' });
    if (!roster) continue;
    if (roster.status !== 'paid' && roster.status !== 'paid_awaiting_delegates') continue;
    paidBookings.push(roster);
  }

  const newlyMatched = [];
  const newlyExpired = [];

  for (const referral of openReferrals) {
    const submittedAt = new Date(referral.submittedAt);
    const windowEnd = new Date(submittedAt.getTime() + REFERRAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const match = paidBookings.find((roster) => {
      const bookedAt = new Date(roster.createdAt);
      return normalizeCompanyName(roster.companyName) === referral.normalizedCompanyName
        && bookedAt >= submittedAt
        && bookedAt <= windowEnd;
    });

    if (match) {
      referral.status = 'matched';
      referral.matchedAt = now.toISOString();
      referral.matchedBookingCompanyName = match.companyName;
      referral.matchedBookingRepCode = match.salesRepCode || 'ISM';
      referral.matchedBookingCreatedAt = match.createdAt;
      await store.setJSON(`referral:${referral.id}`, referral);
      newlyMatched.push(referral);
    } else if (now > windowEnd) {
      referral.status = 'expired';
      await store.setJSON(`referral:${referral.id}`, referral);
      newlyExpired.push(referral);
    }
  }

  // Still-open "awaiting your review" list -- everything currently
  // 'matched' (from this run or any earlier one) that nobody has marked
  // paid or rejected yet via admin-referrals.html. Listed in full every
  // day so nothing falls through the cracks if one email gets missed.
  const { blobs: allReferralBlobs } = await store.list({ prefix: 'referral:' });
  const awaitingReview = [];
  for (const b of allReferralBlobs) {
    const record = await store.get(b.key, { type: 'json' });
    if (record && record.status === 'matched') awaitingReview.push(record);
  }
  awaitingReview.sort((a, b) => new Date(a.matchedAt) - new Date(b.matchedAt));

  if (awaitingReview.length === 0 && newlyExpired.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ newlyMatched: 0, awaitingReview: 0, expired: newlyExpired.length }) };
  }

  const amountRM = (REFERRAL_BONUS_AMOUNT_CENTS / 100).toFixed(2);
  const row = (r, isNew) => `
    <tr style="border-bottom:1px solid #E9ECF2; ${isNew ? 'background:#FEF6E9;' : ''}">
      <td style="padding:8px 10px 8px 0;">${isNew ? '<strong>NEW</strong> ' : ''}${r.repCode}</td>
      <td style="padding:8px 10px;">${r.contactName}${r.department ? ` (${r.department})` : ''}</td>
      <td style="padding:8px 10px;">${r.companyName}</td>
      <td style="padding:8px 10px;">${new Date(r.submittedAt).toISOString().slice(0, 10)}</td>
      <td style="padding:8px 10px;">${new Date(r.matchedBookingCreatedAt).toISOString().slice(0, 10)} (booked under ${r.matchedBookingRepCode})</td>
    </tr>`;

  const newlyMatchedIds = new Set(newlyMatched.map((r) => r.id));
  const rows = awaitingReview.map((r) => row(r, newlyMatchedIds.has(r.id))).join('');

  const html = `
    <div style="font-family:sans-serif;color:#1C0333;max-width:900px;">
      <h2>Referral bonus review</h2>
      <p style="color:#5C566B;font-size:13px;">Referrals whose named company has since booked within the 90-day window — a candidate for the flat RM${amountRM} referral bonus. Nothing here is paid automatically. Verify the referral genuinely led to the sale, then mark it paid or rejected at <a href="https://book.woowoo.world/admin-referrals">book.woowoo.world/admin-referrals</a>.</p>
      ${newlyMatched.length > 0 ? `<p style="color:#97711F;font-size:13px;font-weight:600;">${newlyMatched.length} new match${newlyMatched.length === 1 ? '' : 'es'} since yesterday, highlighted below.</p>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="border-bottom:2px solid #1C0333;text-align:left;">
          <th style="padding:6px 10px 6px 0;">Rep</th>
          <th style="padding:6px 10px;">Contact</th>
          <th style="padding:6px 10px;">Company</th>
          <th style="padding:6px 10px;">Referred</th>
          <th style="padding:6px 10px;">Booked</th>
        </tr>
        ${rows}
      </table>
      ${newlyExpired.length > 0 ? `<p style="color:#8F8A9C;font-size:12px;margin-top:16px;">${newlyExpired.length} older referral${newlyExpired.length === 1 ? '' : 's'} passed the 90-day window with no matching booking and ${newlyExpired.length === 1 ? 'has' : 'have'} been closed out automatically — no action needed.</p>` : ''}
      <p style="color:#B0ABBB;font-size:11px;margin-top:16px;">Sent daily. Every unresolved match is listed every day until marked paid or rejected.</p>
    </div>`;

  await sendEmail({
    to: cohortsData.salesReportRecipient || 'sales@woowoo.world',
    subject: `Referral bonus review — ${awaitingReview.length} awaiting${newlyMatched.length > 0 ? `, ${newlyMatched.length} new` : ''}`,
    html
  });

  return { statusCode: 200, body: JSON.stringify({ newlyMatched: newlyMatched.length, awaitingReview: awaitingReview.length, expired: newlyExpired.length }) };
};
