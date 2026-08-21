// Called from public/sign-up.html.
//
//   Step 1 (action: 'accept-contract') — records contract acceptance
//   (typed legal name, checkbox, timestamp, IP, and the contract's own
//   version identifier so we know exactly which wording was agreed to)
//   against a chosen sales code. This is what ACTIVATES the code — see
//   the note in _commission.js / issue-self-credits.js on where that
//   check still needs wiring in (not done yet as of this build).
//
//   Step 2 (action: 'connect-bank') — creates a Stripe Connect account
//   (Accounts v2, Recipient configuration) for that code and returns a
//   hosted onboarding link. Wired into the UI as an optional step right
//   after contract sign-up, and re-triggerable later via the welcome
//   email's link (public/sign-up.html?code=X&step=bank). Not required —
//   reps/Booking Contacts who skip it are paid manually (see
//   send-sales-reports.js) until they connect a bank account.
//
//   Step 3 (action: 'account-status') — read-only check of whether a
//   code's Recipient account has reached an active payout capability
//   yet. Used by the UI right after Stripe redirects back from hosted
//   onboarding, since account creation and verification aren't the
//   same moment.
//
// Malaysia only, deliberately — HRD Corp itself only deals with
// Malaysian and Malaysia-registered companies, so every Sales Rep and
// Booking Contact here is Malaysia-based. Don't add a country field or
// any worldwide handling; that's a future, separate decision if WooWoo
// World ever operates outside Malaysia.
//
// CONTRACT_VERSION bump this whenever the contract wording changes —
// old acceptances stay valid for what they actually agreed to, but a
// version bump can be used to prompt re-acceptance if the terms
// materially change.
const { getStore } = require('./_blobs');
const { createConnectAccount, createOnboardingLink, getAccountStatus } = require('./_stripe-connect');
const { sendSalesAgentWelcomeEmail } = require('./_email');

const CONTRACT_VERSION = '2026-08-18-v1';
const CODE_PATTERN = /^[A-Z0-9]{3,12}$/;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Everything below is wrapped in one top-level try/catch: an unhandled
  // throw here (e.g. a Netlify Blobs write failing because its store
  // credentials aren't available in this deploy context) would otherwise
  // crash the whole invocation with an opaque platform error instead of
  // the clear {error: "..."} JSON this endpoint is meant to always return.
  try {
    const store = getStore('bookings');

    if (body.action === 'accept-contract') {
      const { salesCode, kind, legalName, email, agreed } = body;

      if (!salesCode || !CODE_PATTERN.test(salesCode)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Sales code must be 3-12 letters/numbers, e.g. your initials.' }) };
      }
      if (kind !== 'sales_rep' && kind !== 'booking_contact') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown signup kind' }) };
      }
      if (!legalName || legalName.trim().length < 2) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Legal name is required' }) };
      }
      if (!email || !email.includes('@')) {
        return { statusCode: 400, body: JSON.stringify({ error: 'A valid email is required' }) };
      }
      if (!agreed) {
        return { statusCode: 400, body: JSON.stringify({ error: 'You must accept the agreement to continue' }) };
      }

      const key = `sales-agent:${salesCode}`;
      const existing = await store.get(key, { type: 'json' }).catch(() => null);
      if (existing) {
        return { statusCode: 409, body: JSON.stringify({ error: `Sales code ${salesCode} is already registered. Choose a different one, or contact sales@woowoo.world if this is yours.` }) };
      }

      const record = {
        salesCode,
        kind,
        legalName: legalName.trim(),
        email: email.trim().toLowerCase(),
        contractVersion: CONTRACT_VERSION,
        contractAcceptedAt: new Date().toISOString(),
        contractAcceptedIp: event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || null,
        status: 'active', // active -> bank_connected, once Connect is wired back in
        stripeAccountId: null,
      };
      await store.setJSON(key, record);

      // No Stripe Connect attempt here (see file header) — the code is
      // fully active the moment the contract is on file. Payment method
      // is sorted out separately, manually, for now.
      try {
        await sendSalesAgentWelcomeEmail({
          legalName: record.legalName,
          email: record.email,
          salesCode,
          kind,
        });
      } catch (err) {
        // Contract acceptance itself still succeeded and the code is
        // active either way — an email hiccup here shouldn't block that.
        console.error('Welcome email failed for', salesCode, err);
      }

      return { statusCode: 200, body: JSON.stringify({ ok: true, salesCode, status: record.status }) };
    }

    if (body.action === 'connect-bank') {
      const { salesCode, returnUrl, refreshUrl } = body;
      if (!salesCode) return { statusCode: 400, body: JSON.stringify({ error: 'Missing salesCode' }) };

      const key = `sales-agent:${salesCode}`;
      const record = await store.get(key, { type: 'json' }).catch(() => null);
      if (!record) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Sign the agreement first before connecting a bank account.' }) };
      }

      try {
        if (!record.stripeAccountId) {
          const account = await createConnectAccount({
            email: record.email,
            name: record.legalName,
            kind: record.kind,
          });
          record.stripeAccountId = account.id;
          record.status = 'bank_connected';
          await store.setJSON(key, record);
        }

        const url = await createOnboardingLink({
          accountId: record.stripeAccountId,
          refreshUrl: refreshUrl || `${process.env.URL || ''}/sign-up?code=${salesCode}&step=bank`,
          returnUrl: returnUrl || `${process.env.URL || ''}/sign-up?code=${salesCode}&step=done`,
        });

        return { statusCode: 200, body: JSON.stringify({ ok: true, onboardingUrl: url }) };
      } catch (err) {
        console.error('Stripe Connect onboarding failed for', salesCode, err);
        return { statusCode: 502, body: JSON.stringify({ error: `Could not start bank connection right now: ${err.message}` }) };
      }
    }

    if (body.action === 'account-status') {
      // Called when the UI needs to know whether a code's Stripe Connect
      // payout capability is actually active yet — e.g. right after
      // Stripe redirects back from hosted onboarding. Deliberately
      // separate from connect-bank: this never creates an account or
      // spends an onboarding link, it only reads current state.
      const { salesCode } = body;
      if (!salesCode) return { statusCode: 400, body: JSON.stringify({ error: 'Missing salesCode' }) };

      const record = await store.get(`sales-agent:${salesCode}`, { type: 'json' }).catch(() => null);
      if (!record) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Sales code not found' }) };
      }
      if (!record.stripeAccountId) {
        return { statusCode: 200, body: JSON.stringify({ ok: true, bankConnected: false, transfersActive: false }) };
      }

      try {
        const { transfersActive, rawStatus } = await getAccountStatus(record.stripeAccountId);
        if (transfersActive && record.status !== 'bank_active') {
          record.status = 'bank_active';
          await store.setJSON(`sales-agent:${salesCode}`, record);
        }
        return { statusCode: 200, body: JSON.stringify({ ok: true, bankConnected: true, transfersActive, rawStatus }) };
      } catch (err) {
        console.error('Account status check failed for', salesCode, err);
        return { statusCode: 502, body: JSON.stringify({ error: `Could not check bank connection status: ${err.message}` }) };
      }
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    console.error('sales-agent-signup crashed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: `Server error: ${err.message}` }) };
  }
};
