const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'bookings@woowoo.world';
const OPS_NOTIFICATION_EMAIL = process.env.OPS_NOTIFICATION_EMAIL; // set to Omar's inbox

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
    .map((d) => `<tr><td style="padding:6px 12px;">${d.name}</td><td style="padding:6px 12px;">${d.position}</td><td style="padding:6px 12px;">${d.company}</td></tr>`)
    .join('');
  return `<table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px;">
    <thead><tr style="text-align:left;border-bottom:1px solid #ccc;">
      <th style="padding:6px 12px;">Name</th><th style="padding:6px 12px;">Position</th><th style="padding:6px 12px;">Company</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function sendConfirmationEmail({ contactEmail, cohort, delegates, pricing, invoicePdfBuffer, bookingId }) {
  const html = `
    <div style="font-family:sans-serif;color:#1C0333;">
      <h2>Booking confirmed</h2>
      <p>Your registration for <strong>${cohort.programmeName}</strong> (${cohort.label}) is confirmed.</p>
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

async function sendOpsNotification({ cohort, delegates, pricing, contactEmail, bookingId }) {
  if (!OPS_NOTIFICATION_EMAIL) {
    console.warn('OPS_NOTIFICATION_EMAIL not set — skipping ops notification');
    return { skipped: true };
  }
  const html = `
    <div style="font-family:sans-serif;color:#1C0333;">
      <h2>New paid booking</h2>
      <p><strong>${cohort.programmeName}</strong> — ${cohort.label}</p>
      <p>Booking contact: ${contactEmail}</p>
      <h3>Delegates</h3>
      ${delegateRosterHtml(delegates)}
      <p>Total: RM ${((pricing.grandTotal ?? pricing.total) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })} (${pricing.seatCount} seats)</p>
      <p>Discount tier: <strong>${pricing.discountTier === 'heavy' ? 'Heavily Discounted' : 'Standard Discount'}</strong>${pricing.bookingProtectionSelected ? ' · Booking Protection purchased' : ''}</p>
      <p style="color:#746F82;font-size:12px;">Booking reference: ${bookingId}</p>
    </div>`;

  return sendEmail({
    to: OPS_NOTIFICATION_EMAIL,
    subject: `New booking: ${delegates.length} seat(s) — ${cohort.programmeName} ${cohort.label}`,
    html
  });
}

module.exports = { sendConfirmationEmail, sendOpsNotification };
