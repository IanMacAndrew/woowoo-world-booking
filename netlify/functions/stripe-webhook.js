const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('./_blobs');
const { getCohort } = require('./_pricing');
const { generateInvoicePdf } = require('./_invoice');
const { sendConfirmationEmail, sendOpsNotification } = require('./_email');

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return { statusCode: 400, body: `Webhook signature verification failed: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const { bookingId, cohortId, seatCount } = session.metadata;
    const store = getStore('bookings');

    // Mark roster as paid
    const roster = await store.get(`roster:${bookingId}`, { type: 'json' });
    if (roster) {
      roster.status = 'paid';
      roster.stripeSessionId = session.id;
      roster.paidAt = new Date().toISOString();
      await store.setJSON(`roster:${bookingId}`, roster);
    }

    // Increment confirmed seat count for the cohort
    const raw = await store.get(`seats-booked:${cohortId}`);
    const current = raw ? parseInt(raw, 10) : 0;
    await store.set(`seats-booked:${cohortId}`, String(current + parseInt(seatCount, 10)));

    // Generate the HRD Corp claimable invoice and send both emails
    if (roster) {
      const cohort = getCohort(cohortId);
      try {
        const invoicePdfBuffer = await generateInvoicePdf({
          bookingId,
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
          bookingId
        });

        await sendOpsNotification({
          cohort,
          delegates: roster.delegates,
          pricing: roster.pricing,
          contactEmail: roster.contactEmail,
          bookingId
        });
      } catch (err) {
        // Payment already succeeded — never let an email/PDF failure block that.
        // Log it so it surfaces in Netlify's function logs for follow-up.
        console.error('Post-payment notification failed for booking', bookingId, err);
      }
    }
  }

  return { statusCode: 200, body: 'ok' };
};
