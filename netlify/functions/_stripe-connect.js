// Stripe Connect helper — onboards a Sales Rep or Booking Contact as a
// connected account purely to RECEIVE payouts. WooWoo never collects,
// stores, or even sees their bank details: the account holder enters
// those directly into Stripe's own hosted onboarding form. Our backend
// only ever holds a Stripe account ID and later calls stripe.transfers
// .create() against it — the bank transfer itself is entirely Stripe's.
//
// Malaysia only — HRD Corp itself only deals with Malaysian and
// Malaysia-registered companies, so every Sales Rep and Booking
// Contact here is Malaysia-based. Country is hardcoded to 'MY' below,
// deliberately. Worldwide support is a future, separate decision.
//
// IMPORTANT — verify before going live: this uses "controller properties"
// (Stripe's current-recommended replacement for the deprecated Standard/
// Express/Custom account types) rather than `type: 'express'`.
//
// CORRECTED after two real test runs surfaced three bugs in the
// original version of this file:
//   1. Wrong field name — Stripe's actual parameter is
//      controller.losses.payments, not controller.losses.responsibility
//      (a typo in the original research-derived guess).
//   2. stripe_dashboard.type: 'express' requires BOTH fees.payer AND
//      losses.payments set to 'application' (platform-owned). Malaysia
//      only has Stripe-owns-fees-and-losses generally available (the
//      platform-owned configuration is preview-only there) — so
//      'express' was never valid for a Malaysia account on the
//      generally-available path, independent of the typo.
//   3. controller.fees.payer's valid values are 'application' or
//      'account' — NOT 'stripe'. ('stripe' is only a valid value in
//      the newer, differently-named Accounts v2 API's
//      defaults.responsibilities.fees_collector field; confusing the
//      two APIs' terminology produced a second wrong value here, only
//      caught via the real 400 error quoting this field's actual
//      valid set.)
//
// Fix: the exact values Stripe's own controller-properties migration
// doc gives for "Standard account behavior equivalent" —
//   fees: { payer: 'account' }, losses: { payments: 'stripe' },
//   stripe_dashboard: { type: 'full' }, requirement_collection: 'stripe'
// — which both matches what's generally available for Malaysia, and
// still gives the account holder their own full Stripe dashboard to
// enter bank details into directly, which is what actually matters
// for "WooWoo never sees bank details."
//
// STILL TO VERIFY end-to-end: this combination has not yet been
// confirmed to complete a real (test-mode) onboarding link successfully
// — only that account creation itself now uses valid parameter names
// and a Stripe-documented-valid combination. Run the full flow once
// more (throwaway test signup, complete Stripe's test-mode Malaysia
// bank details, confirm `payouts_enabled: true`) before trusting this
// with a real bank account.
// Stripe client is constructed lazily (not at module load time) so that a
// missing STRIPE_SECRET_KEY throws a clear, catchable error from inside a
// request handler's try/catch, instead of crashing this whole module at
// require() time with an opaque platform-level failure before any of our
// own error handling gets a chance to run.
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set for this deploy context — check the environment variable is scoped to it in Netlify.');
  }
  _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

async function createConnectAccount({ email, name, kind }) {
  const stripe = getStripe();
  // kind: 'sales_rep' | 'booking_contact' — stored in metadata only, no
  // behavioural difference to Stripe.
  //
  // Malaysia only, deliberately (see sales-agent-signup.js header) —
  // country is hardcoded, not collected from the sign-up form.
  const account = await stripe.accounts.create({
    country: 'MY',
    email,
    controller: {
      // Exact values for "Standard account behavior equivalent", taken
      // directly from Stripe's own controller-properties migration doc
      // (docs.stripe.com/connect/migrate-to-controller-properties):
      //   losses: { payments: "stripe" }, fees: { payer: "account" },
      //   stripe_dashboard: { type: "full" }, requirement_collection: "stripe"
      // NOTE: fees.payer's valid values are 'application' or 'account'
      // — NOT 'stripe'. ('stripe' is only a valid value in the newer,
      // differently-named Accounts v2 API's defaults.responsibilities
      // .fees_collector field — confirmed the hard way, via a real
      // 400 error quoting the actual valid set for this v1 field.)
      // 'account' here means the connected account itself is billed
      // for Stripe's fees — the correct v1 equivalent of "Stripe
      // collects fees", which is what's generally available for
      // Malaysia (see file header).
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
      // 'full' = the account holder gets their own complete Stripe
      // dashboard (equivalent to the old "Standard" account type) —
      // this is what lets THEM enter and manage their own bank details
      // directly with Stripe, never through anything WooWoo built.
      stripe_dashboard: { type: 'full' },
      requirement_collection: 'stripe',
    },
    business_type: 'individual',
    metadata: { kind, woowooName: name || '' },
  });
  return account;
}

async function createOnboardingLink({ accountId, refreshUrl, returnUrl }) {
  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  return link.url;
}

async function getAccountStatus(accountId) {
  const stripe = getStripe();
  const account = await stripe.accounts.retrieve(accountId);
  return {
    payoutsEnabled: !!account.payouts_enabled,
    detailsSubmitted: !!account.details_submitted,
    requirementsCurrentlyDue: (account.requirements && account.requirements.currently_due) || [],
  };
}

// Pays out released commission to a connected account's Stripe balance.
// The actual movement to their bank happens on Stripe's own payout
// schedule from there — WooWoo's part ends at this transfer.
async function payoutReleasedCommission({ accountId, amountCents, currency, description }) {
  const stripe = getStripe();
  return stripe.transfers.create({
    amount: amountCents,
    currency: currency || 'myr',
    destination: accountId,
    description,
  });
}

module.exports = { createConnectAccount, createOnboardingLink, getAccountStatus, payoutReleasedCommission };
