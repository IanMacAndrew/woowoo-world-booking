const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('./_blobs');
const { calculatePricing, cohortsData, getCohort, getProgramme, getVenue } = require('./_pricing');

function jsonError(statusCode, error) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error }) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonError(405, 'Method not allowed');
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return jsonError(400, 'Invalid request — please refresh the page and try again.');
  }

  const { cohortId, seatCount: rawSeatCount, bookingContact, salesRepCode, bookingProtection, tosAccepted, transferCode, venueId } = payload;
  const repCode = (salesRepCode || 'ISM').trim().toUpperCase().slice(0, 20) || 'ISM';
  const creditCode = (transferCode || '').trim().toUpperCase();

  if (!tosAccepted) {
    return jsonError(400, 'You must accept the Terms of Service and Privacy Policy to continue.');
  }

  const seatCount = parseInt(rawSeatCount, 10);
  if (!seatCount || seatCount < 1) {
    return jsonError(400, 'At least one delegate seat is required');
  }
  const contactName = (bookingContact && bookingContact.name || '').trim();
  const contactEmail = (bookingContact && bookingContact.email || '').trim();
  if (!contactName || !contactEmail) {
    return jsonError(400, 'Booking Contact name and email are required');
  }
  const contactPhone = (bookingContact && bookingContact.phone || '').trim();

  const cohort = getCohort(cohortId);
  if (!cohort) {
    return jsonError(400, 'Unknown cohort — please refresh the page and select a date again.');
  }
  const programme = getProgramme(cohort.programme);
  const maxSeatsForCohort = programme.maxSeats || cohortsData.maxSeats;

  const store = getStore('bookings');

  // Re-check capacity right before checkout so we never oversell
  let alreadyBooked;
  try {
    const raw = await store.get(`seats-booked:${cohortId}`);
    alreadyBooked = raw ? parseInt(raw, 10) : 0;
  } catch (err) {
    console.error('Blobs read failed (seats-booked) for', cohortId, err);
    return jsonError(500, 'Could not check seat availability right now — please try again in a moment.');
  }
  if (alreadyBooked + seatCount > maxSeatsForCohort) {
    return jsonError(409, `Only ${maxSeatsForCohort - alreadyBooked} seat(s) left in this cohort.`);
  }

  let pricing;
  try {
    pricing = calculatePricing({ cohortId, seatCount, bookingProtection: !!bookingProtection, venueId });
  } catch (e) {
    return jsonError(400, e.message);
  }

  // Deep Dive → Masterclass transfer credit (see admin-issue-credit.html).
  // Applied as a one-time Stripe coupon so it's visible as a clean line item
  // on the actual payment page, rather than silently baked into the price.
  let creditStore, creditRecord, creditAmountApplied = 0;
  if (creditCode) {
    creditStore = getStore('transfer-credits');
    creditRecord = await creditStore.get(creditCode, { type: 'json' }).catch(() => null);
    if (!creditRecord) {
      return jsonError(400, 'Transfer credit code not recognised.');
    }
    if (creditRecord.status !== 'unused') {
      return jsonError(400, 'This transfer credit code has already been used.');
    }
    creditAmountApplied = Math.min(creditRecord.amountCents, pricing.grandTotal);
    // Reserve immediately (optimistic — see SETUP.md note on abandoned checkouts).
    await creditStore.setJSON(creditCode, {
      ...creditRecord,
      status: 'redeemed',
      redeemedAt: new Date().toISOString()
    });
  }

  // Store the full delegate roster server-side (Stripe metadata has tight size limits)
  const bookingId = `bk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await store.setJSON(`roster:${bookingId}`, {
      cohortId,
      delegates: null,
      bookingContact: { name: contactName, email: contactEmail, phone: contactPhone },
      contactEmail,
      venue: pricing.venue ? pricing.venue.name : cohort.venue,
      pricing: {
        perSeat: pricing.perSeat,
        total: pricing.total,
        seatCount,
        discountTier: pricing.discountTier,
        venueSurchargePerSeat: pricing.venueSurchargePerSeat,
        bookingProtectionSelected: pricing.bookingProtectionSelected,
        bookingProtectionFee: pricing.bookingProtectionFee,
        grandTotal: pricing.grandTotal
      },
      salesRepCode: repCode,
      transferCredit: creditCode ? { code: creditCode, amountApplied: creditAmountApplied } : null,
      tosAcceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      status: 'pending'
    });
  } catch (err) {
    console.error('Blobs write failed (roster) for', bookingId, err);
    if (creditCode && creditStore && creditRecord) {
      await creditStore.setJSON(creditCode, { ...creditRecord, status: 'unused', redeemedAt: null }).catch(() => {});
    }
    return jsonError(500, 'Could not save your booking right now — please try again in a moment.');
  }

  const siteUrl = process.env.URL || 'https://woowoo.world';

  try {
    let discounts;
    if (creditAmountApplied > 0) {
      const coupon = await stripe.coupons.create({
        amount_off: creditAmountApplied,
        currency: pricing.currency,
        duration: 'once',
        name: `Deep Dive transfer credit (${creditCode})`
      });
      discounts = [{ coupon: coupon.id }];
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'fpx', 'grabpay'],
      customer_email: contactEmail || undefined,
      client_reference_id: repCode || undefined,
      ...(discounts ? { discounts } : {}),
      line_items: [
        {
          price_data: {
            currency: pricing.currency,
            unit_amount: pricing.perSeat,
            product_data: {
              name: `${pricing.cohort.programmeName} — ${pricing.cohort.label}`,
              description: `${seatCount} delegate seat(s)${pricing.earlyBirdApplied ? ' · Early-bird rate' : ''}${pricing.fireSaleApplied ? ' · Fire Sale rate (50% off)' : ''}${pricing.seatDiscountApplied ? ' · Multi-seat discount' : ''}${pricing.venue ? ' · Venue: ' + pricing.venue.name : ''}. Delegate details aren't needed to book — after payment we'll email your Booking Contact a short form to add each delegate's name, position and company.`
            }
          },
          quantity: seatCount
        },
        ...(pricing.bookingProtectionFee > 0 ? [{
          price_data: {
            currency: pricing.currency,
            unit_amount: pricing.bookingProtectionFee,
            product_data: {
              name: 'Booking Protection',
              description: 'Non-refundable. Upgrades this booking\u2019s cancellation terms one tier — see Terms of Service.'
            }
          },
          quantity: 1
        }] : [])
      ],
      metadata: {
        bookingId,
        cohortId,
        seatCount: String(seatCount),
        discountTier: pricing.discountTier,
        venue: pricing.venue ? pricing.venue.name : cohort.venue,
        salesRepCode: repCode,
        bookingProtection: pricing.bookingProtectionSelected ? 'yes' : 'no',
        transferCreditCode: creditCode || 'none',
        transferCreditApplied: String(creditAmountApplied),
        contactName,
        contactEmail
      },
      success_url: `${siteUrl}/booking-confirmed?booking=${bookingId}`,
      cancel_url: `${siteUrl}/booking-cancelled?booking=${bookingId}`
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url, bookingId, pricing })
    };
  } catch (err) {
    // Release the credit back if we reserved one and then failed to check out.
    if (creditCode && creditStore && creditRecord) {
      await creditStore.setJSON(creditCode, { ...creditRecord, status: 'unused', redeemedAt: null }).catch(() => {});
    }
    console.error('Stripe checkout session creation failed for booking', bookingId, '—', err && err.message, err && err.type, err && err.code);
    return jsonError(500, (err && err.message) || 'Could not start checkout — please try again.');
  }
};
