// Stripe Connect helper — onboards a Sales Rep or Booking Contact as a
// connected account purely to RECEIVE payouts. WooWoo never collects,
// stores, or even sees their bank details: the account holder enters
// those directly into Stripe's own hosted onboarding form. Our backend
// only ever holds a Stripe account ID and later calls stripe.transfers
// .create() against it — the bank transfer itself is entirely Stripe's.
//
// IMPORTANT — verify before going live: this uses "controller properties"
// (Stripe's current-recommended replacement for the deprecated Standard/
// Express/Custom account types) rather than `type: 'express'`. The exact
// combination below is our best-effort reading of Stripe's own migration
// docs as of this build, matched to what's confirmed generally available
// for Malaysia (Stripe collects fees and owns loss liability — the
// platform-owns-liability configuration is still preview-only for
// Malaysia). This has NOT been exercised against a real Stripe test
// account yet — do that before connecting a single real bank account:
//   1. Use a Stripe TEST secret key.
//   2. Run createConnectAccount() end to end for one throwaway signup.
//   3. Complete the returned onboarding link with Stripe's test-mode
//      Malaysia bank details.
//   4. Confirm the account shows `payouts_enabled: true` afterwards, and
//      that WooWoo's own Dashboard/logs never show the entered bank
//      details anywhere.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function createConnectAccount({ email, name, kind, country }) {
  // kind: 'sales_rep' | 'booking_contact' — stored in metadata only, no
  // behavioural difference to Stripe.
  //
  // country: ISO 3166-1 alpha-2 (e.g. 'MY', 'GB', 'US'), from the sign-up
  // form — the agreement is usable worldwide, so this can't be hardcoded
  // to Malaysia. Only Malaysia's availability under this controller
  // configuration ("Stripe collects fees and owns loss liability") has
  // actually been checked against Stripe's own docs for this build —
  // verify a given country works before onboarding a real person from
  // it; a few countries have different requirements or aren't eligible
  // for this exact configuration at all.
  const account = await stripe.accounts.create({
    country: country || 'MY',
    email,
    controller: {
      // Stripe collects fees / owns negative-balance risk on this
      // account — the configuration confirmed generally available for
      // Malaysia (see _stripe-connect.js header comment). Not
      // individually re-checked for every other country.
      fees: { payer: 'application' },
      losses: { responsibility: 'stripe' },
      // Gives the account holder their own hosted Stripe dashboard —
      // this is what lets THEM enter and manage their own bank details
      // directly with Stripe, never through anything WooWoo built.
      stripe_dashboard: { type: 'express' },
      requirement_collection: 'stripe',
    },
    business_type: 'individual',
    metadata: { kind, woowooName: name || '' },
  });
  return account;
}

async function createOnboardingLink({ accountId, refreshUrl, returnUrl }) {
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  return link.url;
}

async function getAccountStatus(accountId) {
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
  return stripe.transfers.create({
    amount: amountCents,
    currency: currency || 'myr',
    destination: accountId,
    description,
  });
}

module.exports = { createConnectAccount, createOnboardingLink, getAccountStatus, payoutReleasedCommission };
