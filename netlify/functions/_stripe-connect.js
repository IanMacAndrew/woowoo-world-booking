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
// REWRITTEN to use Stripe's Accounts v2 API (POST /v2/core/accounts),
// per Stripe's own current guidance — a real, live error from this
// exact endpoint told us in plain language: "Stripe no longer
// recommends Accounts v1 for new Connect integrations... For agent-
// based integrations, use Stripe's current best-practices skill:
// npx skills add stripe/ai." That skill's Connect reference reframed
// the whole problem correctly: WooWoo never charges anything on a
// rep's account, so this is a pure payout relationship — Stripe's
// "Recipient" configuration, not the "Merchant"/SaaS-style "Standard
// account equivalent" the previous version of this file was built
// around (which is why three rounds of v1 controller-properties
// parameter fixes never quite got there — right general direction,
// wrong account model entirely).
//
// Config used, matching the skill's Recipient guidance:
//   dashboard: 'express'                         — lightweight, cobranded
//   defaults.responsibilities.fees_collector:    'application'
//   defaults.responsibilities.losses_collector:  'stripe'   (see note below)
//   configuration.recipient.capabilities.stripe_balance.stripe_transfers
//                                                 — requested: true
// Every field name and nesting level below was checked against the
// actual TypeScript definitions shipped in stripe-node 22.5.0 (see
// package.json — the previously-installed ^17.0.0 predates v2 support
// entirely, which is a separate reason the old code never had a
// chance of working), not inferred from prose documentation.
//
// RESOLVED, empirically, across three live errors — trust this over
// any prose doc if they ever conflict again:
//   1. losses_collector:'application' + recipient-only -> Stripe:
//      "requires configuration.merchant.capabilities.card_payments"
//   2. losses_collector:'stripe' + recipient-only (fees_collector
//      still 'application') -> Stripe: "can only be application for
//      the set of configurations this account has"
//   3. losses_collector:'application' + fees_collector:'application' +
//      merchant.card_payments + recipient.stripe_transfers -> Stripe:
//      "Platforms in MY cannot create accounts where the platform is
//      loss-liable, due to risk control measures" (links the same
//      Malaysia support page cited below)
// The actual required combination, matching that support page's own
// title verbatim ("Connect where Stripe collects fees AND owns loss
// liability is available for Malaysia businesses") is BOTH collectors
// set to 'stripe' together, not just losses_collector alone — that's
// the gap in every attempt before this one. This is a blanket
// Malaysia-platform rule, unrelated to actual risk: these accounts
// never process a charge, so there's nothing for Stripe to actually
// be liable for in practice, but the rule applies regardless of that.
// Source: https://support.stripe.com/questions/connect-availability-for-businesses-located-in-malaysia
//
// merchant.capabilities.card_payments stays requested alongside the
// recipient capability per error #1 above — WooWoo never actually
// charges or routes a payment through a rep's account, this is a
// capability grant Stripe requires be present, unused in practice.
//
// STILL TO VERIFY end-to-end: parameter names/shapes are confirmed
// against real SDK types, and losses_collector is now backed by an
// explicit Stripe support-page citation for Malaysia rather than
// assumption — but the full onboarding-link-completion flow still
// hasn't been watched succeed against a live (test-mode) account.
// Test again — throwaway signup, Stripe's test-mode Malaysia bank
// details, confirm the recipient capability status reaches 'active' —
// before trusting this with a real bank account.
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
  const account = await stripe.v2.core.accounts.create({
    contact_email: email,
    display_name: name || undefined,
    identity: {
      country: 'MY',
      entity_type: 'individual',
    },
    dashboard: 'express',
    defaults: {
      responsibilities: {
        fees_collector: 'stripe',
        losses_collector: 'stripe',
      },
    },
    configuration: {
      merchant: {
        capabilities: {
          card_payments: { requested: true },
        },
      },
      recipient: {
        capabilities: {
          stripe_balance: {
            stripe_transfers: { requested: true },
          },
        },
      },
    },
    metadata: { kind, woowooName: name || '' },
  });
  return account;
}

async function createOnboardingLink({ accountId, refreshUrl, returnUrl }) {
  const stripe = getStripe();
  const link = await stripe.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['recipient'],
        refresh_url: refreshUrl,
        return_url: returnUrl,
      },
    },
  });
  return link.url;
}

async function getAccountStatus(accountId) {
  const stripe = getStripe();
  const account = await stripe.v2.core.accounts.retrieve(accountId, {
    include: ['configuration.recipient'],
  });
  const status = account.configuration
    && account.configuration.recipient
    && account.configuration.recipient.capabilities
    && account.configuration.recipient.capabilities.stripe_balance
    && account.configuration.recipient.capabilities.stripe_balance.stripe_transfers
    && account.configuration.recipient.capabilities.stripe_balance.stripe_transfers.status;
  return {
    transfersActive: status === 'active',
    rawStatus: status || null,
  };
}

// Pays out released commission to a connected account's Stripe balance.
// The actual movement to their bank happens on Stripe's own payout
// schedule from there — WooWoo's part ends at this transfer. This
// stays on the v1 Transfers API deliberately: the Recipient
// configuration's stripe_balance.stripe_transfers capability exists
// specifically to let a v2 account receive v1 /v1/transfers into its
// balance (v1 Transfers isn't being deprecated the way v1 Account
// creation is — Stripe's own skill guidance confirms this is still
// the correct payout mechanism for a Recipient account).
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
