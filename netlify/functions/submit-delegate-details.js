const { getStore } = require('./_blobs');
const { getCohort } = require('./_pricing');
const { generateInvoicePdf } = require('./_invoice');
const { sendConfirmationEmail, sendOpsNotification, sendSalesCommissionNotification } = require('./_email');
const { calculateAndRecordCommission } = require('./_commission');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { token, delegates } = payload;
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing token' }) };
  }

  const store = getStore('bookings');
  const tokenRecord = await store.get(`delegate-form:${token}`, { type: 'json' });
  if (!tokenRecord) {
    return { statusCode: 404, body: JSON.stringify({ error: 'This link is invalid or has expired.' }) };
  }
  if (tokenRecord.used) {
    return { statusCode: 409, body: JSON.stringify({ error: 'Delegate details have already been submitted for this booking.' }) };
  }

  if (!Array.isArray(delegates) || delegates.length !== tokenRecord.seatCount) {
    return { statusCode: 400, body: JSON.stringify({ error: `Please provide exactly ${tokenRecord.seatCount} delegate(s).` }) };
  }
  for (const d of delegates) {
    if (!d.name || !d.position || !d.company) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Each delegate needs name, position and company' }) };
    }
  }

  const roster = await store.get(`roster:${tokenRecord.bookingId}`, { type: 'json' });
  if (!roster) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Booking not found.' }) };
  }

  roster.delegates = delegates;
  roster.status = 'paid';
  roster.delegatesSubmittedAt = new Date().toISOString();
  await store.setJSON(`roster:${tokenRecord.bookingId}`, roster);
  await store.setJSON(`delegate-form:${token}`, { ...tokenRecord, used: true, usedAt: new Date().toISOString() });

  const cohort = getCohort(roster.cohortId);

  let commission = null;
  try {
    commission = await calculateAndRecordCommission({
      bookingId: tokenRecord.bookingId,
      cohortId: roster.cohortId,
      repCode: roster.salesRepCode,
      delegates: roster.delegates,
      perSeat: roster.pricing.perSeat,
      createdAt: roster.createdAt,
      eventAttendanceBeforeSale: roster.eventAttendanceBeforeSale,
      eventAttendanceAfterSale: roster.eventAttendanceAfterSale
    });
  } catch (err) {
    console.error('Commission calculation failed for booking', tokenRecord.bookingId, err);
  }

  try {
    const invoicePdfBuffer = await generateInvoicePdf({
      bookingId: tokenRecord.bookingId,
      cohort,
      delegates: roster.delegates,
      pricing: roster.pricing,
      contactEmail: roster.contactEmail,
      paidAt: roster.paidAt
    });

    await sendConfirmationEmail({
      contactEmail: roster.contactEmail,
      cohort,
      delegates: roster.delegates,
      pricing: roster.pricing,
      invoicePdfBuffer,
      bookingId: tokenRecord.bookingId
    });

    await sendOpsNotification({
      cohort,
      delegates: roster.delegates,
      pricing: roster.pricing,
      contactEmail: roster.contactEmail,
      bookingId: tokenRecord.bookingId,
      commission
    });

    if (commission && roster.salesRepCode && roster.salesRepCode !== 'ISM') {
      await sendSalesCommissionNotification({
        cohort,
        commission,
        bookingId: tokenRecord.bookingId
      });
    }
  } catch (err) {
    // Delegate details are already saved — never let an email/PDF failure
    // undo that. Log for follow-up.
    console.error('Post-delegate-submission notification failed for booking', tokenRecord.bookingId, err);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true })
  };
};
