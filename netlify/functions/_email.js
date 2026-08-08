const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'bookings@woowoo.world';
const OPS_NOTIFICATION_EMAIL = process.env.OPS_NOTIFICATION_EMAIL; // set to Omar's inbox
const SALES_NOTIFICATION_EMAIL = process.env.SALES_NOTIFICATION_EMAIL || 'sales@woowoo.world';

async function sendEmail({ to, subject, html, attachments }) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email send to', to);
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      attachments: attachments || []
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Resend API error:', res.status, errText);
  }
  return res;
}

function delegateRosterHtml(delegates) {
  const rows = delegates
    .map((d) => `<tr><td style="padding:6px 12px;">${d.name}</td><td style="padding:6px 12px;">${d.position}</td><td style="padding:6px 12px;">${d.company}</td>${'eligible' in d ? `<td style="padding:6px 12px;">${d.eligible ? 'Yes' : 'No'}</td>` : ''}</tr>`)
    .join('');
  const hasEligibleCol = delegates.some((d) => 'eligible' in d);
  return `<table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px;">
    <thead><tr style="text-align:left;border-bottom:1px solid #ccc;">
      <th style="padding:6px 12px;">Name</th><th style="padding:6px 12px;">Position</th><th style="padding:6px 12px;">Company</th>${hasEligibleCol ? '<th style="padding:6px 12px;">C-Suite/Dept Head</th>' : ''}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function sendConfirmationEmail({ contactEmail, cohort, delegates, pricing, invoicePdfBuffer, bookingId }) {
  const html = `
    <div style="font-family:sans-serif;color:#1C0333;">
      <h2>Booking confirmed</h2>
      <p>Your registration for <strong>${cohort.programmeName}</strong> (${cohort.label}) is confirmed.</p>
      <p>Venue: ${cohort.venue}</p>
      <h3>Delegates</h3>
      ${delegateRosterHtml(delegates)}
      <p style="margin-top:16px;">Total paid: <strong>RM ${((pricing.grandTotal ?? pricing.total) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })}</strong>${pricing.bookingProtectionSelected ? ' <span style="color:#746F82;font-size:12px;">(includes non-refundable Booking Protection)</span>' : ''}</p>
      <p>Your HRD Corp-claimable receipt is attached to this email.</p>
      <p style="color:#746F82;font-size:12px;">Booking reference: ${bookingId}</p>
    </div>`;

  return sendEmail({
    to: contactEmail,
    subject: `Booking confirmed — ${cohort.programmeName}, ${cohort.label}`,
    html,
    attachments: invoicePdfBuffer
      ? [{ filename: `Invoice-${bookingId}.pdf`, content: invoicePdfBuffer.toString('base64') }]
      : []
  });
}

async function sendOpsNotification({ cohort, delegates, pricing, contactEmail, bookingId, commission }) {
  if (!OPS_NOTIFICATION_EMAIL) {
    console.warn('OPS_NOTIFICATION_EMAIL not set — skipping ops notification');
    return { skipped: true };
  }
  const commissionHtml = commission
    ? (commission.eligible
        ? (commission.payoutType === 'seeding'
            ? `<p><strong>Seeding fee (${commission.repCode}):</strong> RM ${(commission.commissionAmount / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })} — ${commission.eligibleDelegateCount} eligible delegate(s), event hasn't yet crossed the attendance threshold. Rep cumulative now ${commission.repCumulativeAfter}</p>`
            : `<p><strong>Commission (${commission.repCode}):</strong> RM ${(commission.commissionAmount / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })} — ${commission.eligibleDelegateCount} eligible delegate(s) at ${Math.round(commission.rate * 100)}%, rep cumulative now ${commission.repCumulativeAfter}</p>`)
        : `<p style="color:#746F82;">No commission on this booking${commission.repCode && commission.repCode !== 'ISM' ? ` for ${commission.repCode}` : ''}: ${commission.reason}</p>`)
    : '';
  const html = `
    <div style="font-family:sans-serif;color:#1C0333;">
      <h2>New paid booking</h2>
      <p><strong>${cohort.programmeName}</strong> — ${cohort.label}</p>
      <p>Venue: ${cohort.venue}</p>
      <p>Booking contact: ${contactEmail}</p>
      <h3>Delegates</h3>
      ${delegateRosterHtml(delegates)}
      <p>Total: RM ${((pricing.grandTotal ?? pricing.total) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })} (${pricing.seatCount} seats)</p>
      <p>Discount tier: <strong>${pricing.discountTier === 'heavy' ? 'Heavily Discounted' : 'Standard Discount'}</strong>${pricing.bookingProtectionSelected ? ' · Booking Protection purchased' : ''}</p>
      ${commissionHtml}
      <p style="color:#746F82;font-size:12px;">Booking reference: ${bookingId}</p>
    </div>`;

  return sendEmail({
    to: OPS_NOTIFICATION_EMAIL,
    subject: `New booking: ${delegates.length} seat(s) — ${cohort.programmeName} ${cohort.label}`,
    html
  });
}

async function sendDelegateFormLinkEmail({ contactEmail, contactName, cohort, seatCount, bookingId, formUrl }) {
  const html = `
    <div style="font-family:sans-serif;color:#1C0333;">
      <h2>Payment received — one more step</h2>
      <p>Hi ${contactName || 'there'}, thanks for booking <strong>${cohort.programmeName}</strong> (${cohort.label}).</p>
      <p>Venue: ${cohort.venue}</p>
      <p>We just need the details of the ${seatCount} delegate${seatCount === 1 ? '' : 's'} attending. Please note this training is intended for <strong>C-Suite and division/department heads</strong>.</p>
      <p style="margin:24px 0;"><a href="${formUrl}" style="background:#C79529;color:#1C0333;padding:12px 20px;text-decoration:none;font-weight:bold;border-radius:4px;">Add delegate details</a></p>
      <p style="color:#746F82;font-size:12px;">This link is unique to your booking — please don't forward it. Your HRD Corp-claimable receipt will follow once delegate details are submitted.</p>
      <p style="color:#746F82;font-size:12px;">Booking reference: ${bookingId}</p>
    </div>`;

  return sendEmail({
    to: contactEmail,
    subject: `Action needed — add delegate details for ${cohort.programmeName}`,
    html
  });
}

async function sendOpsAwaitingDelegatesNotification({ cohort, seatCount, pricing, contactName, contactEmail, bookingId }) {
  if (!OPS_NOTIFICATION_EMAIL) {
    console.warn('OPS_NOTIFICATION_EMAIL not set — skipping ops notification');
    return { skipped: true };
  }
  const html = `
    <div style="font-family:sans-serif;color:#1C0333;">
      <h2>New paid booking — awaiting delegate details</h2>
      <p><strong>${cohort.programmeName}</strong> — ${cohort.label}</p>
      <p>Booking contact: ${contactName} &lt;${contactEmail}&gt;</p>
      <p>Seats purchased: ${seatCount}</p>
      <p>Total: RM ${((pricing.grandTotal ?? pricing.total) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })}</p>
      <p>Discount tier: <strong>${pricing.discountTier === 'heavy' ? 'Heavily Discounted' : 'Standard Discount'}</strong>${pricing.bookingProtectionSelected ? ' · Booking Protection purchased' : ''}</p>
      <p style="color:#746F82;font-size:12px;">Delegate names will follow once the Booking Contact submits the delegate form. Booking reference: ${bookingId}</p>
    </div>`;

  return sendEmail({
    to: OPS_NOTIFICATION_EMAIL,
    subject: `New booking (awaiting delegates): ${seatCount} seat(s) — ${cohort.programmeName} ${cohort.label}`,
    html
  });
}

async function sendSalesCommissionNotification({ cohort, commission, bookingId }) {
  const html = `
    <div style="font-family:sans-serif;color:#1C0333;">
      <h2>Commission update — ${commission.repCode}</h2>
      <p><strong>${cohort.programmeName}</strong> — ${cohort.label}</p>
      ${commission.eligible
        ? `<p><strong>RM ${(commission.commissionAmount / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })}</strong> for ${commission.eligibleDelegateCount} eligible delegate(s)${commission.payoutType === 'seeding' ? ' (seeding fee — event hadn\u2019t yet crossed the attendance threshold)' : ` at ${Math.round(commission.rate * 100)}%`}.</p>
           ${commission.deepDiveFloorApplied ? '<p>Deep Dive floor applied.</p>' : ''}
           ${commission.capacityBonusApplied ? '<p>Capacity-fill bonus applied \u2014 this sale pushed the event past 80% full.</p>' : ''}
           ${commission.firstTimeCompanyBonusAmount ? `<p>First-time company bonus: RM ${(commission.firstTimeCompanyBonusAmount / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })} (${commission.firstTimeCompanies.join(', ')})</p>` : ''}
           <p>Cumulative eligible delegates sold: <strong>${commission.repCumulativeAfter}</strong></p>`
        : `<p>No commission on this booking: ${commission.reason}</p>`}
      <p style="color:#746F82;font-size:12px;">Booking reference: ${bookingId}</p>
    </div>`;

  return sendEmail({
    to: SALES_NOTIFICATION_EMAIL,
    subject: `Commission ${commission.eligible ? 'earned' : 'update'} — ${commission.repCode} — ${cohort.programmeName}`,
    html
  });
}

module.exports = { sendConfirmationEmail, sendOpsNotification, sendDelegateFormLinkEmail, sendOpsAwaitingDelegatesNotification, sendSalesCommissionNotification };
