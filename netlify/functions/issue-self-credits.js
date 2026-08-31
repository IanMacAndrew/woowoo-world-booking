// Scheduled daily (see netlify.toml). Handles the "remove ISM -> account
// credit" choice from the Sales Code field: once a cohort is fully closed
// to new sales AND confirmed to have hit its minimum (i.e. it's genuinely
// running, not being merged/rescheduled), every booking made with the
// SELF_CREDIT marker gets an account credit issued and emailed.
//
// Credit value mirrors the same commission a sales rep would earn on an
// equivalent booking: the company-tier rate (5% for 1-3 delegates, 10%
// for 4-6, 15% for 7+) PLUS the minimum-fill team bonus (+5%) — this
// function only ever runs once minimum is already confirmed met, so that
// bonus always applies here, unlike the rep case where it's applied later
// by release-commission-payouts.js. The workshop-volume bonus layer still
// doesn't apply — it's designed around a rep's ongoing sales behaviour
// across multiple bookings into one cohort, not a single self-booking.
const { getStore } = require('./_blobs');
const { cohortsData, getProgramme, salePhase } = require('./_pricing');
const { companyTierRate, MINIMUM_FILL_BONUS_RATE } = require('./_commission');
const { sendEmail } = require('./_email');

const DEFAULT_MIN_SEATS = 18;

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  let code = 'AC-'; // Account Credit
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function issueCreditCode(creditStore, amountCents, note) {
  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = randomCode();
    const existing = await creditStore.get(code, { type: 'json' }).catch(() => null);
    if (!existing) break;
  }
  await creditStore.setJSON(code, {
    code,
    amountCents,
    note,
    status: 'unused',
    issuedAt: new Date().toISOString(),
    redeemedAt: null
  });
  return code;
}

async function sendSelfCreditEmail({ contactEmail, contactName, cohort, code, amountCents }) {
  const html = `
    <div style="font-family:sans-serif;color:#1C0333;">
      <h2>Your account credit is ready</h2>
      <p>Hi ${contactName || 'there'},</p>
      <p>${cohort.programmeName} (${cohort.label}) is confirmed to run. As you booked directly rather than through a sales rep, here's your account credit:</p>
      <p style="font-size:22px;font-weight:700;background:#F4F2F8;padding:14px 20px;border-radius:8px;display:inline-block;">${code}</p>
      <p>Worth <strong>RM ${(amountCents / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })}</strong> off a future WooWoo World booking — enter it at checkout under "Deep Dive transfer code" (it works across any of our programmes, not just Deep Dive).</p>
      <p style="color:#746F82;font-size:12px;">Questions? Reply to this email or contact sales@woowoo.world.</p>
    </div>`;

  return sendEmail({
    to: contactEmail,
    subject: `Your WooWoo World account credit: RM ${(amountCents / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })}`,
    html
  });
}

exports.handler = async () => {
  const store = getStore('bookings');
  const creditStore = getStore('transfer-credits');
  const results = [];

  for (const cohort of cohortsData.cohorts) {
    if (salePhase(cohort) !== 'closed') continue;

    const alreadyProcessed = await store.get(`self-credits-issued:${cohort.id}`);
    if (alreadyProcessed) continue;

    const programme = getProgramme(cohort.programme);
    const minSeats = programme.minSeats || DEFAULT_MIN_SEATS;
    const bookedRaw = await store.get(`seats-booked:${cohort.id}`);
    const booked = bookedRaw ? parseInt(bookedRaw, 10) : 0;

    if (booked < minSeats) {
      // Didn't lock in — handled by the merge/reschedule rescue flow
      // instead. Leave unprocessed so it's revisited if it later merges
      // into a cohort that does lock in.
      continue;
    }

    const { blobs } = await store.list({ prefix: 'roster:' });
    let issuedCount = 0;
    for (const b of blobs) {
      const roster = await store.get(b.key, { type: 'json' });
      if (!roster || roster.cohortId !== cohort.id) continue;
      if (roster.salesRepCode !== 'SELF_CREDIT') continue;
      if (!(roster.status || '').startsWith('paid')) continue;
      if (roster.selfCreditIssued) continue;

      const rate = companyTierRate(roster.pricing.seatCount) + MINIMUM_FILL_BONUS_RATE;
      const amountCents = Math.round(roster.pricing.total * rate);
      if (amountCents <= 0) continue;

      try {
        const code = await issueCreditCode(creditStore, amountCents, `Self-credit: ${cohort.id}`);
        await sendSelfCreditEmail({
          contactEmail: roster.contactEmail,
          contactName: roster.bookingContact && roster.bookingContact.name,
          cohort,
          code,
          amountCents
        });
        roster.selfCreditIssued = { code, amountCents, issuedAt: new Date().toISOString() };
        const bookingId = b.key.replace('roster:', '');
        await store.setJSON(b.key, roster);
        issuedCount++;
        results.push({ cohortId: cohort.id, bookingId, code, amountCents });
      } catch (err) {
        console.error('Self-credit issuance failed for', b.key, err);
      }
    }

    await store.set(`self-credits-issued:${cohort.id}`, new Date().toISOString());
    if (issuedCount > 0) console.log(`Issued ${issuedCount} self-credit(s) for ${cohort.id}`);
  }

  return { statusCode: 200, body: JSON.stringify({ results }) };
};
