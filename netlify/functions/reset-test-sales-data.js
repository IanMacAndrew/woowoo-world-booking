const { getStore } = require('./_blobs');

// One-time (or occasional) cleanup tool: wipes every artifact tied to
// test sales-rep/manager sign-ups and test bookings made before the
// business had any real sales — sales-agent registrations, commission
// records (rep, ownership-override, and manager-override alike), the
// secondary commission-by-rep index, per-rep-per-cohort sale ledgers,
// manager/team links, account-ownership claims, referral bonus records,
// per-cohort payout-release flags, and booked-seat counts.
//
// Deliberately leaves alone: cohorts.json / programme config (not test
// data, it's real business config), and anything in Stripe itself (out
// of scope for this tool — test-mode charges there don't affect this
// site's own logic and can be left or cleared separately if wanted).
//
// Protected by ADMIN_SECRET like the other admin tools. Two-step by
// design, since this is destructive and can't be undone:
//
//   GET  -> dry run. Reports how many keys under each prefix WOULD be
//           deleted. Deletes nothing.
//   POST { "confirm": "WIPE ALL TEST SALES DATA" } -> actually deletes
//           everything counted above. The exact confirm phrase is
//           required, not just a boolean, specifically so this can
//           never fire by an accidental POST with an empty/default body.

const PREFIXES = [
  'sales-agent:',
  'commission:',
  'commission-by-rep:',
  'rep-cohort-count:',
  'manager-team:',
  'company-owner:',
  'referral:',
  'commission-payouts-released:',
  'seats-booked:',
];

const CONFIRM_PHRASE = 'WIPE ALL TEST SALES DATA';

exports.handler = async (event) => {
  const adminSecret = event.headers['x-admin-secret'];
  if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const store = getStore('bookings');

  async function keysForPrefix(prefix) {
    const keys = [];
    let cursor;
    do {
      const page = await store.list({ prefix, cursor });
      keys.push(...page.blobs.map((b) => b.key));
      cursor = page.cursor;
    } while (cursor);
    return keys;
  }

  if (event.httpMethod === 'GET') {
    const counts = {};
    let total = 0;
    for (const prefix of PREFIXES) {
      const keys = await keysForPrefix(prefix);
      counts[prefix] = keys.length;
      total += keys.length;
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dryRun: true,
        wouldDelete: counts,
        totalKeys: total,
        toActuallyDelete: `POST with body { "confirm": "${CONFIRM_PHRASE}" }`
      })
    };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }
    if (body.confirm !== CONFIRM_PHRASE) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `To confirm this destructive action, POST { "confirm": "${CONFIRM_PHRASE}" }` })
      };
    }

    const deleted = {};
    let total = 0;
    for (const prefix of PREFIXES) {
      const keys = await keysForPrefix(prefix);
      for (const key of keys) {
        await store.delete(key);
      }
      deleted[prefix] = keys.length;
      total += keys.length;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, deleted, totalKeysDeleted: total })
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
