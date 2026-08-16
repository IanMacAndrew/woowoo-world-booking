const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');
const { getStore } = require('./_blobs');
const { getCohort } = require('./_pricing');
const { sendDelegateFormLinkEmail, sendOpsAwaitingDelegatesNotification, sendSalesCommissionNotification } = require('./_email');
const { calculateAndRecordCommission } = require('./_commission');

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

    // Snapshot the event's attendance at the moment this sale is confirmed —
    // this is the point-of-sale figure used for all commission gating
    // (the 10-delegate minimum and the 80%-capacity bonus). Taking it here,
    // rather than later when the delegate form is submitted, means a rep's
    // payout can't drift up or down based on what OTHER reps sell into the
    // same event after this sale was already made.
    const seatCountNum = parseInt(seatCount, 10);
    const attendanceRaw = await store.get(`seats-booked:${cohortId}`);
    const attendanceBefore = attendanceRaw ? parseInt(attendanceRaw, 10) : 0;
    const attendanceAfter = attendanceBefore + seatCountNum;

    if (roster) {
      roster.status = 'paid_awaiting_delegates';
      roster.stripeSessionId = session.id;
      roster.paidAt = new Date().toISOString();
      roster.eventAttendanceBeforeSale = attendanceBefore;
      roster.eventAttendanceAfterSale = attendanceAfter;
      await store.setJSON(`roster:${bookingId}`, roster);
    }

    // Increment confirmed seat count for the cohort
    await store.set(`seats-booked:${cohortId}`, String(attendanceAfter));

    // Commission is calculated immediately at payment, not later at
    // delegate-form submission — the new scheme only needs seat count and
    // revenue, not delegate-level eligibility, so there's no reason to wait
    // on a step the customer might never complete.
    try {
      const repCode = session.metadata.salesRepCode;
      const revenue = roster ? roster.pricing.total : null;
      const companyName = (roster && roster.companyName) || session.metadata.companyName;
      if (revenue != null) {
        const commission = await calculateAndRecordCommission({
          bookingId,
          cohortId,
          repCode,
          companyName,
          seatCount: seatCountNum,
          revenue,
          createdAt: (roster && roster.createdAt) || new Date().toISOString()
        });
        if (commission.eligible) {
          const baseCohortForCommission = getCohort(cohortId);
          await sendSalesCommissionNotification({ cohort: baseCohortForCommission, commission, bookingId }).catch((err) =>
            console.error('Commission notification email failed for booking', bookingId, err)
          );
        }
      } else {
        console.error('No revenue figure available (roster missing, no fallback) — skipping commission calc for booking', bookingId);
      }
    } catch (err) {
      // Payment already succeeded — a commission-calc failure should never
      // block that. Log for follow-up.
      console.error('Commission calculation failed for booking', bookingId, err);
    }

    // Issue a one-time delegate-form token and email the Booking Contact.
    // Prefer the internal roster record, but fall back to the Stripe
    // session's own metadata if the roster write failed at checkout time
    // (see rosterWriteFailed flag) — either way, a paid customer still gets
    // their delegate-form email and ops still gets visibility.
    const contactEmail = roster ? roster.contactEmail : session.metadata.contactEmail;
    const contactName = roster ? (roster.bookingContact && roster.bookingContact.name) : session.metadata.contactName;
    const effectiveSeatCount = roster ? roster.pricing.seatCount : seatCountNum;

    if (contactEmail) {
      const baseCohort = getCohort(cohortId);
      const cohort = { ...baseCohort, venue: (roster && roster.venue) || session.metadata.venue || baseCohort.venue };
      try {
        const token = crypto.randomBytes(24).toString('hex');
        await store.setJSON(`delegate-form:${token}`, {
          bookingId,
          seatCount: effectiveSeatCount,
          used: false,
          createdAt: new Date().toISOString()
        });

        const siteUrl = process.env.URL || 'https://woowoo.world';
        const formUrl = `${siteUrl}/delegate-form?token=${token}`;

        await sendDelegateFormLinkEmail({
          contactEmail,
          contactName,
          cohort,
          seatCount: effectiveSeatCount,
          bookingId,
          formUrl
        });

        await sendOpsAwaitingDelegatesNotification({
          cohort,
          seatCount: effectiveSeatCount,
          pricing: roster ? roster.pricing : null,
          contactName,
          contactEmail,
          bookingId,
          rosterMissing: !roster
        });
      } catch (err) {
        // Payment already succeeded — never let an email failure block that.
        // Log it so it surfaces in Netlify's function logs for follow-up.
        console.error('Post-payment notification failed for booking', bookingId, err);
      }
    } else {
      console.error('No contact email available (roster missing AND no metadata fallback) for booking', bookingId, '— manual follow-up needed via Stripe dashboard.');
    }
  }

  return { statusCode: 200, body: 'ok' };
};
