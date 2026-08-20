const { getStore } = require('./_blobs');
const { getCohort, cohortsData } = require('./_pricing');
const { sendEmail } = require('./_email');

const PERIOD_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CHECKPOINT_KEY = 'sales-report-last-period-end';
// First payout period starts the day the first Deep Dive runs — nothing to
// report before the business has any live bookings.
const FALLBACK_PERIOD_START = '2026-08-29T00:00:00+08:00';

function repDisplayName(repCode) {
  const name = (cohortsData.salesReps || {})[repCode];
  return name ? `${name} (${repCode})` : repCode;
}

function money(cents) {
  return 'RM ' + ((cents || 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });
}

async function buildSaleSection(commission) {
  const cohort = getCohort(commission.cohortId);
  const store = getStore('bookings');
  const roster = await store.get(`roster:${commission.bookingId}`, { type: 'json' });
  const delegates = (roster && roster.delegates) || [];

  const delegateRows = delegates
    .map((d) => `<tr><td style="padding:3px 8px 3px 0;">${d.name}</td><td style="padding:3px 8px;">${d.position}</td><td style="padding:3px 0;">${d.company}</td></tr>`)
    .join('');

  const notes = [];
  notes.push(`${Math.round(commission.companyTierRate * 100)}% company tier (${commission.seatCount} delegate${commission.seatCount === 1 ? '' : 's'})`);
  if (commission.workshopBonusRate > 0) notes.push(`+${Math.round(commission.workshopBonusRate * 100)}% workshop-volume bonus (${commission.repCumulativeInCohortAfter} cumulative in this cohort)`);
  if (commission.minimumFillBonusRate > 0) notes.push(`+${Math.round(commission.minimumFillBonusRate * 100)}% minimum-fill team bonus (cohort confirmed)`);

  return `
    <div style="border-top:0.5px solid #D4D6DC;padding-top:12px;margin-bottom:12px;">
      <p style="font-size:12px;font-weight:600;color:#8F8A9C;text-transform:uppercase;letter-spacing:0.04em;margin:0 0 6px;">Sale — ${cohort.programmeName}</p>
      <table style="font-size:13px;width:100%;border-collapse:collapse;">
        <tr><td style="color:#5C566B;padding:2px 0;width:34%;">Cohort</td><td style="padding:2px 0;">${cohort.label}${cohort.trackLabel ? ' · ' + cohort.trackLabel : ''}</td></tr>
        <tr><td style="color:#5C566B;padding:2px 0;">Venue</td><td style="padding:2px 0;">${cohort.venue}</td></tr>
        <tr><td style="color:#5C566B;padding:2px 0;">Venue contact</td><td style="padding:2px 0;">${cohort.venueContact ? `${cohort.venueContact.name} · ${cohort.venueContact.phone} · ${cohort.venueContact.email}` : 'TBC'}</td></tr>
        <tr><td style="color:#5C566B;padding:2px 0;">Venue sales rep</td><td style="padding:2px 0;">${cohort.venueSalesRep ? `${cohort.venueSalesRep.name} · ${cohort.venueSalesRep.phone} · ${cohort.venueSalesRep.email}` : 'TBC'}</td></tr>
        <tr><td style="color:#5C566B;padding:2px 0;">Company</td><td style="padding:2px 0;">${commission.companyName || '—'}</td></tr>
        <tr><td style="color:#5C566B;padding:2px 0;">Delegates</td><td style="padding:2px 0;">${commission.seatCount}</td></tr>
        <tr><td style="color:#5C566B;padding:2px 0;">Commission</td><td style="padding:2px 0;font-weight:600;">${money(commission.commissionAmount)} (${Math.round(commission.totalRate * 100)}%)</td></tr>
      </table>
      ${delegateRows ? `<table style="font-size:12px;width:100%;border-collapse:collapse;margin-top:6px;color:#5C566B;">
        <tr><th style="text-align:left;padding:2px 8px 2px 0;">Delegate</th><th style="text-align:left;padding:2px 8px;">Position</th><th style="text-align:left;padding:2px 0;">Company</th></tr>
        ${delegateRows}
      </table>` : '<p style="font-size:11px;color:#B0ABBB;margin:6px 0 0;">Delegate names not yet submitted.</p>'}
      ${notes.length ? `<p style="font-size:12px;color:#8F8A9C;margin:6px 0 0;">${notes.join(' · ')}</p>` : ''}
      <p style="font-size:11px;color:#B0ABBB;margin:4px 0 0;">Booking reference: ${commission.bookingId}</p>
    </div>`;
}

async function sendReportForRep(repCode, commissions, periodStart, periodEnd) {
  const sections = await Promise.all(commissions.map(buildSaleSection));
  const total = commissions.reduce((sum, c) => sum + (c.commissionAmount || 0), 0);
  const fmt = (d) => new Date(d).toLocaleDateString('en-MY', { day: 'numeric', month: 'long', year: 'numeric' });

  const html = `
    <div style="font-family:sans-serif;color:#1C0333;max-width:640px;">
      <p style="text-align:center;font-size:12px;color:#97711F;margin:0 0 4px;">WooWoo World</p>
      <h2 style="text-align:center;margin:0 0 4px;">Sales payout for ${repDisplayName(repCode)}</h2>
      <p style="text-align:center;font-size:13px;color:#5C566B;margin:0 0 4px;">Period: ${fmt(periodStart)} \u2013 ${fmt(periodEnd)}</p>
      <p style="text-align:center;font-size:11px;color:#8F8A9C;margin:0 0 20px;">Released this period — every cohort below has confirmed its minimum go-ahead headcount.</p>
      ${sections.join('')}
      <div style="border-top:1px solid #1C0333;padding-top:12px;display:flex;justify-content:space-between;">
        <strong>Total payable this period</strong>
        <strong>${money(total)}</strong>
      </div>
    </div>`;

  return sendEmail({
    to: cohortsData.salesReportRecipient || 'sales@woowoo.world',
    subject: `Sales payout for ${repDisplayName(repCode)} — ${fmt(periodStart)} to ${fmt(periodEnd)}`,
    html
  });
}

exports.handler = async () => {
  const store = getStore('bookings');

  const checkpointRaw = await store.get(CHECKPOINT_KEY);
  const periodStart = checkpointRaw ? new Date(checkpointRaw) : new Date(FALLBACK_PERIOD_START);
  const now = new Date();

  // Self-pacing: this function is safe to trigger daily. It only actually
  // sends once a full 14-day period has elapsed since the last one sent,
  // then advances its own checkpoint — so it doesn't depend on cron
  // expressions lining up with a specific fortnightly anchor date.
  if (now.getTime() - periodStart.getTime() < PERIOD_DAYS * MS_PER_DAY) {
    return { statusCode: 200, body: 'Not due yet' };
  }
  const periodEnd = new Date(periodStart.getTime() + PERIOD_DAYS * MS_PER_DAY);

  // Windowed on payoutDecidedAt (when release-commission-payouts.js
  // released it), NOT on when the sale was made — a commission only
  // becomes payable once its cohort is confirmed to have hit minimum,
  // which can be well after the sale itself. 'pending' records (cohort
  // hasn't closed to sales yet) and 'void' ones (cohort never reached
  // minimum) are never included in a payable total here.
  const { blobs } = await store.list({ prefix: 'commission-by-rep:' });
  const byRep = {};
  for (const b of blobs) {
    const record = await store.get(b.key, { type: 'json' });
    if (!record || record.payoutStatus !== 'released' || !record.payoutDecidedAt) continue;
    const decidedAt = new Date(record.payoutDecidedAt);
    if (decidedAt < periodStart || decidedAt >= periodEnd) continue;
    const repCode = record.repCode;
    (byRep[repCode] = byRep[repCode] || []).push(record);
  }

  const results = [];
  for (const [repCode, commissions] of Object.entries(byRep)) {
    try {
      await sendReportForRep(repCode, commissions, periodStart, periodEnd);
      results.push({ repCode, sent: true, sales: commissions.length });
    } catch (err) {
      console.error('Failed to send sales report for', repCode, err);
      results.push({ repCode, sent: false, error: err.message });
    }
  }

  await store.set(CHECKPOINT_KEY, periodEnd.toISOString());

  return { statusCode: 200, body: JSON.stringify({ periodStart, periodEnd, results }) };
};
