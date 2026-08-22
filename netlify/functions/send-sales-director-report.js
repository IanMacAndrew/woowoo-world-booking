// Scheduled daily (see netlify.toml). The company-name-inclusive
// counterpart to /leaderboard's public Cohort Progress view — this one
// is NOT public. It's an internal report to the Sales Director at
// sales@woowoo.world, covering the same currently-open cohorts but with
// every booking's company name and rep code attached, plus an explicit
// flag on any booking that looks inconsistent with the company's current
// Account Owner (see checkAndRecordAccountOwnership in _commission.js).
//
// This is the intended channel for the account-ownership "catch a
// problem" loop: reps can't see company names on the public dashboard
// (deliberately — see leaderboard.js), so a rep who suspects an
// ownership issue tells the Sales Director directly, who checks it here
// against the real underlying data rather than reps self-policing a
// public client list.
const { getStore } = require('./_blobs');
const { cohortsData, getProgramme, isCohortListed, salePhase } = require('./_pricing');
const { normalizeCompanyName } = require('./_commission');
const { sendEmail } = require('./_email');

const DEFAULT_MIN_SEATS = 10; // matches check-cohort-minimums.js / send-ops-planning-report.js

exports.handler = async () => {
  const store = getStore('bookings');
  const now = new Date();

  // Only cohorts still open for sale — matches the public dashboard's scope.
  const openCohorts = cohortsData.cohorts.filter((c) => {
    if (!isCohortListed(c, now)) return false;
    const phase = salePhase(c, now);
    return phase === 'early-bird' || phase === 'final-call';
  });
  if (openCohorts.length === 0) {
    return { statusCode: 200, body: 'Nothing to report — no cohorts currently open for sale' };
  }
  const openCohortIds = new Set(openCohorts.map((c) => c.id));

  // Pull every paid booking, filtered down to the open cohorts above.
  // roster: isn't indexed by cohort, so this scans all of them — bounded
  // and fine at current volume; revisit with a cohort-indexed secondary
  // key if this store grows large enough to matter.
  const { blobs: rosterBlobs } = await store.list({ prefix: 'roster:' });
  const bookingsByCohort = {};
  for (const b of rosterBlobs) {
    const roster = await store.get(b.key, { type: 'json' });
    if (!roster) continue;
    if (roster.status !== 'paid' && roster.status !== 'paid_awaiting_delegates') continue;
    if (!openCohortIds.has(roster.cohortId)) continue;
    if (!bookingsByCohort[roster.cohortId]) bookingsByCohort[roster.cohortId] = [];
    bookingsByCohort[roster.cohortId].push({
      companyName: roster.companyName || '(none given)',
      repCode: roster.salesRepCode || 'ISM',
      seatCount: roster.pricing ? roster.pricing.seatCount : null,
      createdAt: roster.createdAt
    });
  }

  // Cross-check each booking's company against the current owner record,
  // if any, and flag anything that looks off:
  //  - a rep-coded booking for a company someone ELSE already owns
  //    (not inherently wrong -- a different rep can always sell there --
  //    but worth a human glance if it's happening a lot)
  //  - an ISM/SELF_CREDIT booking for a company with NO owner on file
  //    (means nobody's expansion override fired -- fine, just means the
  //    company was never opened by a rep in the first place)
  const rows = [];
  for (const cohort of openCohorts) {
    const bookings = bookingsByCohort[cohort.id] || [];
    if (bookings.length === 0) continue;

    const programme = getProgramme(cohort.programme);
    const minSeats = programme.minSeats || DEFAULT_MIN_SEATS;
    const bookedRaw = await store.get(`seats-booked:${cohort.id}`);
    const booked = bookedRaw ? parseInt(bookedRaw, 10) : 0;

    const flaggedBookings = [];
    for (const bk of bookings) {
      const normalized = normalizeCompanyName(bk.companyName);
      if (!normalized) continue;
      const owner = await store.get(`company-owner:${normalized}`, { type: 'json' });
      const ownerActive = owner && new Date(owner.expiresAt) > now;
      const isRepSale = bk.repCode && bk.repCode !== 'ISM' && bk.repCode !== 'SELF_CREDIT';

      let flag = null;
      if (isRepSale && ownerActive && owner.ownerCode !== bk.repCode) {
        flag = `Sold by ${bk.repCode}, but ${owner.ownerCode} owns this company until ${new Date(owner.expiresAt).toISOString().slice(0, 10)}`;
      }
      flaggedBookings.push({ ...bk, flag });
    }

    rows.push({ cohort, booked, minSeats, bookings: flaggedBookings });
  }

  if (rows.length === 0) {
    return { statusCode: 200, body: 'Nothing to report — no bookings in any currently-open cohort' };
  }

  const cohortBlocks = rows.map((r) => {
    const bookingRows = r.bookings.map((bk) => `
      <tr style="border-bottom:1px solid #E9ECF2;">
        <td style="padding:6px 10px 6px 0;">${bk.companyName}</td>
        <td style="padding:6px 10px;text-align:center;">${bk.repCode}</td>
        <td style="padding:6px 10px;text-align:center;">${bk.seatCount ?? '\u2014'}</td>
        <td style="padding:6px 10px;">${bk.flag ? `<span style="color:#9C3B4A;font-weight:600;">${bk.flag}</span>` : '\u2014'}</td>
      </tr>`).join('');

    return `
      <div style="margin-bottom:24px;">
        <h3 style="margin-bottom:2px;">${r.cohort.programmeName} — ${r.cohort.label}</h3>
        <p style="color:#5C566B;font-size:12px;margin-bottom:8px;">${r.booked} / ${r.minSeats} minimum${r.booked < r.minSeats ? ' — under minimum' : ' — minimum reached'}</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr style="border-bottom:2px solid #1C0333;text-align:left;">
            <th style="padding:6px 10px 6px 0;">Company</th>
            <th style="padding:6px 10px;text-align:center;">Rep</th>
            <th style="padding:6px 10px;text-align:center;">Seats</th>
            <th style="padding:6px 10px;">Ownership flag</th>
          </tr>
          ${bookingRows}
        </table>
      </div>`;
  }).join('');

  const totalFlags = rows.reduce((sum, r) => sum + r.bookings.filter((b) => b.flag).length, 0);

  const html = `
    <div style="font-family:sans-serif;color:#1C0333;max-width:820px;">
      <h2>Sales Director report — cohort bookings by company</h2>
      <p style="color:#5C566B;font-size:13px;">Every currently-open cohort's bookings, with company name and rep code — the detail behind the public leaderboard's Cohort Progress view, which deliberately hides company names. ${totalFlags > 0 ? `<strong style="color:#9C3B4A;">${totalFlags} booking${totalFlags === 1 ? '' : 's'} flagged</strong> for a possible account-ownership mismatch — see below.` : 'No ownership flags today.'}</p>
      ${cohortBlocks}
      <p style="color:#B0ABBB;font-size:11px;margin-top:8px;">Sent daily. Covers only cohorts currently open for sale, matching the public leaderboard's scope.</p>
    </div>`;

  await sendEmail({
    to: cohortsData.salesReportRecipient || 'sales@woowoo.world',
    subject: `Sales Director report — ${rows.length} cohort${rows.length === 1 ? '' : 's'}${totalFlags > 0 ? `, ${totalFlags} ownership flag${totalFlags === 1 ? '' : 's'}` : ''}`,
    html
  });

  return { statusCode: 200, body: JSON.stringify({ cohortsReported: rows.length, flags: totalFlags }) };
};
