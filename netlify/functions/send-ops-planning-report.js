// Scheduled daily (see netlify.toml). A working report for sales@woowoo.world
// to manage HRD Corp's e-TRiS submission timeline and venue bookings —
// covers every upcoming cohort with any booked seats, flagged by where it
// sits in HRD Corp's submission window (20-30 days out: submit; 14-20:
// awaiting approval; under 14: should already be locked).
const { getStore } = require('./_blobs');
const { cohortsData, getProgramme, daysUntilStart, salePhase } = require('./_pricing');
const { sendEmail } = require('./_email');

const REPORT_HORIZON_DAYS = 35; // covers the full e-TRiS submission window with margin
const DEFAULT_MIN_SEATS = 10;

function etrisFlag(days) {
  if (days > 30) return null;
  if (days >= 20) return { label: 'Submit e-TRiS application now', color: '#C79529' };
  if (days >= 14) return { label: 'Awaiting Grant ID approval — follow up if not yet approved', color: '#97711F' };
  if (days >= 0) return { label: 'URGENT — grant should already be locked, verify', color: '#9C3B4A' };
  return null;
}

exports.handler = async () => {
  const store = getStore('bookings');
  const now = new Date();

  const rows = [];
  for (const cohort of cohortsData.cohorts) {
    const days = daysUntilStart(cohort, now);
    if (days < 0 || days > REPORT_HORIZON_DAYS) continue;

    const bookedRaw = await store.get(`seats-booked:${cohort.id}`);
    const booked = bookedRaw ? parseInt(bookedRaw, 10) : 0;
    if (booked === 0) continue; // nothing to plan for yet

    const programme = getProgramme(cohort.programme);
    const minSeats = programme.minSeats || DEFAULT_MIN_SEATS;
    const maxSeats = programme.maxSeats || cohortsData.maxSeats;
    const flag = etrisFlag(days);

    rows.push({ cohort, days, booked, minSeats, maxSeats, phase: salePhase(cohort, now), flag });
  }

  rows.sort((a, b) => a.days - b.days);

  if (rows.length === 0) {
    return { statusCode: 200, body: 'Nothing to report — no cohorts with bookings in the next ' + REPORT_HORIZON_DAYS + ' days' };
  }

  const tableRows = rows.map((r) => `
    <tr style="border-bottom:1px solid #E9ECF2;">
      <td style="padding:8px 10px 8px 0;">
        <strong>${r.cohort.programmeName}</strong><br>
        <span style="color:#5C566B;font-size:12px;">${r.cohort.label}${r.cohort.trackLabel ? ' \u00b7 ' + r.cohort.trackLabel : ''}</span>
      </td>
      <td style="padding:8px 10px;text-align:center;">${r.days}d</td>
      <td style="padding:8px 10px;text-align:center;">${r.booked} / ${r.minSeats}\u2013${r.maxSeats}${r.booked < r.minSeats ? ' <span style="color:#9C3B4A;">(under min)</span>' : ''}</td>
      <td style="padding:8px 10px;">${r.cohort.venue}<br><span style="color:#5C566B;font-size:12px;">${r.cohort.venueContact ? `${r.cohort.venueContact.name} \u00b7 ${r.cohort.venueContact.phone}` : 'Venue contact TBC'}</span></td>
      <td style="padding:8px 10px;">${r.flag ? `<span style="color:${r.flag.color};font-weight:600;">${r.flag.label}</span>` : '\u2014'}</td>
    </tr>`).join('');

  const html = `
    <div style="font-family:sans-serif;color:#1C0333;max-width:820px;">
      <h2>HRD Corp &amp; venue planning report</h2>
      <p style="color:#5C566B;font-size:13px;">Every cohort with booked seats in the next ${REPORT_HORIZON_DAYS} days, sorted by soonest first. e-TRiS timing per HRD Corp's own guidance: submit 20\u201330 days out, grant should be locked by 14 days out.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="border-bottom:2px solid #1C0333;text-align:left;">
          <th style="padding:6px 10px 6px 0;">Cohort</th>
          <th style="padding:6px 10px;text-align:center;">Days out</th>
          <th style="padding:6px 10px;text-align:center;">Booked</th>
          <th style="padding:6px 10px;">Venue</th>
          <th style="padding:6px 10px;">Action</th>
        </tr>
        ${tableRows}
      </table>
      <p style="color:#B0ABBB;font-size:11px;margin-top:16px;">Sent daily. Only cohorts with at least one booking are shown.</p>
    </div>`;

  await sendEmail({
    to: cohortsData.salesReportRecipient || 'sales@woowoo.world',
    subject: `HRD Corp & venue planning — ${rows.length} cohort${rows.length === 1 ? '' : 's'} in the next ${REPORT_HORIZON_DAYS} days`,
    html
  });

  return { statusCode: 200, body: JSON.stringify({ cohortsReported: rows.length }) };
};
