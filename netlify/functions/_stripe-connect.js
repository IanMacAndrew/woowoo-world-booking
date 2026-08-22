// STATUS AS OF THIS COMMIT: built and technically correct, but NOT
// wired into the UI. The remaining wall isn't code — it's a genuine
// Stripe account-level gate: Malaysia platforms need Stripe's own
// approval (a preview program) before ANY loss-liable connected
// account can be created, in v1 or v2, regardless of configuration.
// Confirmed the hard way: the v1 rewrite below, built exactly per
// Stripe Support's own direction, hit the identical "Platforms in MY
// cannot create accounts where the platform is loss-liable" error
// that v2 attempt #3 hit. That's not a code bug to fix by trying
// again — only Stripe granting account-level approval unblocks this.
// Decision: ship with manual payouts (sign-up.html has no bank-connect
// step, welcome email has no bank-connect link) and leave this file
// working and ready for whenever that approval comes through, rather
// than keep guessing at configurations that were never the problem.
//
// RESOLUTION: Accounts v1 API, NOT v2. Confirmed directly by Stripe
// Support after four different v2 attempts each hit a different wall
// (full history below, kept for the record — don't re-litigate
// without a fresh reason to). Support's answer: use the v1 Accounts
// API with tos_acceptance.service_agreement: 'recipient' and ONLY
// capabilities.transfers requested (no card_payments anywhere) — this
// is a real, working, documented v1 pattern (confirmed against a
// genuine Stripe API exchange: POST /v1/accounts with exactly this
// shape returned a valid account ID). This sidesteps the whole
// merchant/card_payments/Malaysia-loss-liability tangle entirely,
// because v1's recipient agreement type never requests card_payments
// in the first place — that's the whole point of it.
//
// v1 Account fields used here, confirmed against the real stripe-node
// 22.5.0 type definitions (resources/Accounts.d.ts, NOT the V2/Core
// ones this file used before):
//   type: 'express'
//   country: 'MY'
//   business_type: 'individual'
//   capabilities.transfers.requested: true    (transfers ONLY)
//   tos_acceptance.service_agreement: 'recipient'
//
// FULL ERROR HISTORY from the v2 attempts before this rewrite, kept
// for context on why v1 was the right call:
//   1. v2, losses_collector:'application', recipient-only -> Stripe:
//      "requires configuration.merchant.capabilities.card_payments"
//   2. v2, losses_collector:'stripe', recipient-only (fees_collector
//      still 'application') -> Stripe: "can only be application for
//      the set of configurations this account has"
//   3. v2, losses_collector:'application', fees_collector:
//      'application', merchant.card_payments + recipient.transfers ->
//      Stripe: "Platforms in MY cannot create accounts where the
//      platform is loss-liable, due to risk control measures"
//   4. v2, both collectors 'stripe', same capabilities as #3 ->
//      Stripe: "This account configuration is not supported"
// All four were v2-specific dead ends caused by v2 apparently forcing
// a merchant/card_payments capability onto MY recipient accounts one
// way or another, regardless of loss-liability configuration. v1's
// recipient agreement type doesn't have this problem because it
// refuses to let you request card_payments on a recipient-agreement
// account at all — it was never in the equation to begin with.
//
// STILL TO VERIFY end-to-end: this v1 shape is confirmed correct
// against real type definitions and a genuine working example from
// Stripe's own records, but hasn't yet been watched succeed against
// THIS account in test mode. Test again before trusting real money.
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
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'MY',
    email: email || undefined,
    business_type: 'individual',
    capabilities: {
      transfers: { requested: true },
    },
    tos_acceptance: {
      service_agreement: 'recipient',
    },
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
  const status = account.capabilities && account.capabilities.transfers;
  return {
    transfersActive: status === 'active',
    rawStatus: status || null,
  };
}

// Pays out released commission to a connected account's Stripe balance.
// The actual movement to their bank happens on Stripe's own payout
// schedule from there — WooWoo's part ends at this transfer. v1
// Transfers (destination: accountId) works directly against a v1
// Account with the transfers capability active — the same API,
// unaffected by the account-creation rewrite above.
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
