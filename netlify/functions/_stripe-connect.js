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
// losses_collector is 'application', matching what Stripe's own live API
// error required for this exact account (confirmed twice, empirically:
// 'stripe' was rejected outright with "Losses collector can only be
// 'application' for the set of configurations this account has").
// A separate Stripe support page on Malaysia availability suggested
// Managed Risk ('stripe') was the only generally-available path — that
// turned out not to hold for this account/config combination, so don't
// re-introduce 'stripe' without a fresh live error actually asking for
// it again. Trust the live API response over general docs when they
// conflict; this file has now been wrong in both directions once.
//
// merchant.capabilities.card_payments is requested alongside the
// recipient capability because Stripe's own error said so verbatim:
// "The stripe_balance.stripe_transfers capability cannot be requested
// without the configuration.merchant.capabilities.card_payments
// capability." This does NOT mean reps will ever process card
// payments — WooWoo never sends them a charge, never uses on_behalf_of,
// never routes a customer payment through their account. It's a
// capability grant Stripe requires be present on the account, unused
// in practice. If this card_payments capability ever shows as
// "pending"/incomplete in a way that blocks the stripe_transfers side
// from activating, that's the next thing to dig into — for now this
// matches the literal instruction in Stripe's live error.
//
// fees_collector stays 'application' per Stripe's documented rule that
// losses_collector: 'application' requires fees_collector: 'application'
// too — the two aren't independent once merchant/card_payments is in
// play.
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
        losses_collector: 'application',
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
