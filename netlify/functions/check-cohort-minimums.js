// Scheduled daily (see netlify.toml). Checks every cohort right as it
// enters its Final Call phase: if it hasn't hit its minimum delegate count,
// email every Booking Contact who bought into it, and notify sales@ so a
// human can action the merge/reschedule rescue plan. Fires once per
// cohort (idempotent via a stored flag), not once per day of the Final
// Call window.
const { getStore } = require('./_blobs');
const { cohortsData, getProgramme, salePhase } = require('./_pricing');
const { sendMinimumNotMetEmail, sendOpsMinimumNotMetNotification } = require('./_email');

const DEFAULT_MIN_SEATS = 10;

// Suggest the next upcoming cohort on the same programme + track as a
// starting point for a possible merge -- ops makes the actual call, this
// just gives them (and the Booking Contact) something concrete to look at.
function suggestMergeTarget(cohort, allCohorts) {
  return allCohorts
    .filter((c) => c.id !== cohort.id && c.programme === cohort.programme && c.track === cohort.track && c.startDate > cohort.startDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] || null;
}

exports.handler = async () => {
  const store = getStore('bookings');
  const results = [];

  for (const cohort of cohortsData.cohorts) {
    const phase = salePhase(cohort);
    if (phase !== 'final-call') continue;

    const alreadyAlerted = await store.get(`minimum-alert-sent:${cohort.id}`);
    if (alreadyAlerted) continue;

    const programme = getProgramme(cohort.programme);
    const minSeats = programme.minSeats || DEFAULT_MIN_SEATS;

    const bookedRaw = await store.get(`seats-booked:${cohort.id}`);
    const booked = bookedRaw ? parseInt(bookedRaw, 10) : 0;

    if (booked >= minSeats) continue; // fine, nothing to do

    // Gather every paid booking into this cohort, so we know who to notify
    const { blobs } = await store.list({ prefix: 'roster:' });
    const bookings = [];
    for (const b of blobs) {
      const roster = await store.get(b.key, { type: 'json' });
      if (roster && roster.cohortId === cohort.id && (roster.status || '').startsWith('paid')) {
        bookings.push(roster);
      }
    }
    if (bookings.length === 0) continue; // nothing booked at all, no one to notify

    const mergeTarget = suggestMergeTarget(cohort, cohortsData.cohorts);
    const repCodes = [...new Set(bookings.map((b) => b.salesRepCode).filter(Boolean))];

    try {
      for (const roster of bookings) {
        await sendMinimumNotMetEmail({
          contactEmail: roster.contactEmail,
          contactName: roster.bookingContact && roster.bookingContact.name,
          cohort,
          booked,
          minSeats,
          seatCount: roster.pricing.seatCount,
          mergeTarget
        });
      }
      await sendOpsMinimumNotMetNotification({
        cohort,
        booked,
        minSeats,
        bookings,
        repCodes,
        mergeTarget
      });
      await store.set(`minimum-alert-sent:${cohort.id}`, new Date().toISOString());
      results.push({ cohortId: cohort.id, booked, minSeats, notified: bookings.length, mergeTarget: mergeTarget ? mergeTarget.id : null });
    } catch (err) {
      console.error('Minimum-not-met notification failed for', cohort.id, err);
      results.push({ cohortId: cohort.id, error: err.message });
    }
  }

  return { statusCode: 200, body: JSON.stringify({ checked: cohortsData.cohorts.length, results }) };
};
