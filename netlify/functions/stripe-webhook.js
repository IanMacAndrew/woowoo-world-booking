const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');
const { getStore } = require('./_blobs');
const { getCohort } = require('./_pricing');
const { sendDelegateFormLinkEmail, sendOpsAwaitingDelegatesNotification } = require('./_email');

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

    // Mark roster as paid, awaiting delegate details
    const roster = await store.get(`roster:${bookingId}`, { type: 'json' });
    if (roster) {
      roster.status = 'paid_awaiting_delegates';
      roster.stripeSessionId = session.id;
      roster.paidAt = new Date().toISOString();
      await store.setJSON(`roster:${bookingId}`, roster);
    }

    // Increment confirmed seat count for the cohort
    const raw = await store.get(`seats-booked:${cohortId}`);
    const current = raw ? parseInt(raw, 10) : 0;
    await store.set(`seats-booked:${cohortId}`, String(current + parseInt(seatCount, 10)));

    // Issue a one-time delegate-form token and email the Booking Contact
    if (roster) {
      const cohort = getCohort(cohortId);
      try {
        const token = crypto.randomBytes(24).toString('hex');
        await store.setJSON(`delegate-form:${token}`, {
          bookingId,
          seatCount: roster.pricing.seatCount,
          used: false,
          createdAt: new Date().toISOString()
        });

        const siteUrl = process.env.URL || 'https://woowoo.world';
        const formUrl = `${siteUrl}/delegate-form?token=${token}`;

        await sendDelegateFormLinkEmail({
          contactEmail: roster.contactEmail,
          contactName: roster.bookingContact && roster.bookingContact.name,
          cohort,
          seatCount: roster.pricing.seatCount,
          bookingId,
          formUrl
        });

        await sendOpsAwaitingDelegatesNotification({
          cohort,
          seatCount: roster.pricing.seatCount,
          pricing: roster.pricing,
          contactName: roster.bookingContact && roster.bookingContact.name,
          contactEmail: roster.contactEmail,
          bookingId
        });
      } catch (err) {
        // Payment already succeeded — never let an email failure block that.
        // Log it so it surfaces in Netlify's function logs for follow-up.
        console.error('Post-payment notification failed for booking', bookingId, err);
      }
    }
  }

  return { statusCode: 200, body: 'ok' };
};
