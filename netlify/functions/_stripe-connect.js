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
// losses_collector is 'stripe', not 'application', BECAUSE OF MALAYSIA
// SPECIFICALLY: per Stripe's own support page ("Connect availability
// for businesses located in Malaysia"), a Malaysia-based platform
// creating Malaysia connected accounts can only generally use "Connect
// where Stripe collects fees and owns loss liability" (Managed Risk,
// losses_collector: 'stripe'). The platform-owns-the-loss model
// (losses_collector: 'application', what this file used until this
// pass) is preview-only for Malaysia and requires Stripe Support to
// invite you in. This is what the live "card_payments required"
// error and the Dashboard force-substituting Payments for Transfers
// were both actually pointing at. fees_collector stays 'application'
// since Stripe's own docs only restrict the other direction
// (losses_collector: 'application' requires fees_collector:
// 'application' too) and these accounts never process charges/fees
// at all — but if account creation rejects that combination during
// testing, try fees_collector: 'stripe' next.
//
// One real open question this doesn't resolve: Stripe Managed Risk can
// carry its own fees depending on your account's economic model
// (revenue share vs buy-rate) per Stripe's Managed Risk pricing page.
// Whether that applies to a pure-payout, zero-charge-volume recipient
// account like these isn't confirmed — worth a direct question to
// Stripe Support or your account rep before this carries real money,
// not assumed either way here.
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
        fees_collector: 'application',
        losses_collector: 'stripe',
      },
    },
    configuration: {
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
