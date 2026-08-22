// Scheduled daily (see netlify.toml). Payout gate for rep commissions —
// mirrors the pattern issue-self-credits.js already uses for the Booking
// Contact rebate: once a cohort is fully closed to new sales, check
// whether it actually reached its minimum go-ahead headcount.
//
//   - If YES: every 'pending' commission record for that cohort gets the
//     minimum-fill team bonus (+5%) added, and is marked 'released' —
//     payable on the next sales-report cycle.
//   - If NO and the cohort was never rescued into a merge: every
//     'pending' record for that cohort is marked 'void' — not paid. The
//     rep was told this could happen (see the "pending, not yet payable"
//     note on the at-sale commission email).
//
// Fires once per cohort (idempotent via a stored flag).
const { getStore } = require('./_blobs');
const { cohortsData, getProgramme, salePhase } = require('./_pricing');
const { MINIMUM_FILL_BONUS_RATE } = require('./_commission');

const DEFAULT_MIN_SEATS = 10;

exports.handler = async () => {
  const store = getStore('bookings');
  const results = [];

  for (const cohort of cohortsData.cohorts) {
    if (salePhase(cohort) !== 'closed') continue;

    const alreadyProcessed = await store.get(`commission-payouts-released:${cohort.id}`);
    if (alreadyProcessed) continue;

    const programme = getProgramme(cohort.programme);
    const minSeats = programme.minSeats || DEFAULT_MIN_SEATS;
    const bookedRaw = await store.get(`seats-booked:${cohort.id}`);
    const booked = bookedRaw ? parseInt(bookedRaw, 10) : 0;
    const minimumReached = booked >= minSeats;

    const { blobs } = await store.list({ prefix: 'commission:' });
    let releasedCount = 0;
    let voidCount = 0;

    for (const b of blobs) {
      const record = await store.get(b.key, { type: 'json' });
      if (!record || record.cohortId !== cohort.id) continue;
      if (record.payoutStatus !== 'pending') continue; // already released/void, or never eligible

      if (minimumReached) {
        // Ownership-override records (account-ownership expansion payouts)
        // are deliberately bounded to the company-tier rate alone — no
        // workshop-bonus, no minimum-fill bonus. They still go through the
        // same released/void gate as normal commissions (a company that
        // books but the cohort never runs shouldn't pay out either way),
        // they just don't pick up the +5% on release.
        if (record.recordType !== 'ownership-override') {
          record.minimumFillBonusRate = MINIMUM_FILL_BONUS_RATE;
          record.totalRate = record.companyTierRate + record.workshopBonusRate + MINIMUM_FILL_BONUS_RATE;
          record.commissionAmount = Math.round(record.revenue * record.totalRate);
        }
        record.payoutStatus = 'released';
        record.payoutDecidedAt = new Date().toISOString();
        releasedCount++;
      } else {
        record.payoutStatus = 'void';
        record.payoutDecidedAt = new Date().toISOString();
        record.voidReason = `Cohort ${cohort.id} closed at ${booked}/${minSeats} delegates — minimum not reached and not merged into a cohort that did.`;
        voidCount++;
      }

      await store.setJSON(b.key, record);
      // Keep the commission-by-rep secondary index in sync — it's a
      // separate copy of the same record, used by send-sales-reports.js.
      const repIndexKey = `commission-by-rep:${record.repCode}:${record.computedAt}:${b.key.replace('commission:', '')}`;
      const repIndexRecord = await store.get(repIndexKey, { type: 'json' }).catch(() => null);
      if (repIndexRecord) {
        await store.setJSON(repIndexKey, record);
      }
    }

    await store.set(`commission-payouts-released:${cohort.id}`, new Date().toISOString());
    if (releasedCount > 0 || voidCount > 0) {
      console.log(`Cohort ${cohort.id}: released ${releasedCount}, voided ${voidCount} commission record(s) (${booked}/${minSeats} delegates)`);
    }
    results.push({ cohortId: cohort.id, booked, minSeats, minimumReached, released: releasedCount, voided: voidCount });
  }

  return { statusCode: 200, body: JSON.stringify({ results }) };
};
