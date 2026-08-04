# WooWoo World — Booking System Setup

This is a full booking system: a products page, a live seat counter, and Stripe checkout
with stacked early-bird + multi-seat discounts. Nothing here costs money to run at your
current scale (Netlify's free tier covers this easily).

## What's in this folder

- `public/index.html` — the booking page itself
- `public/cohorts.json` / `cohorts.json` — all cohort dates, prices, and discount rules in one place. **Edit this file, not the HTML, if dates or prices change.**
- `netlify/functions/` — the backend logic (seat counting, checkout creation, payment confirmation)
- `netlify.toml` — Netlify configuration

## Step 1 — Create your Stripe account

1. Go to https://dashboard.stripe.com/register and create a Malaysia-based account.
2. Complete Stripe's business verification (they'll ask for your business registration details).
3. Once approved, go to **Developers → API keys** and copy your **Secret key** (starts with `sk_live_...` once live, `sk_test_...` while testing). Keep this private — don't paste it into chat with me or anyone else.

## Step 2 — Push this code to GitHub

```
cd woowoo-world-booking
git init
git add .
git commit -m "Booking system"
```
Create a new repo on GitHub, then follow GitHub's instructions to push this to it.

## Step 3 — Connect to Netlify

1. In Netlify, **Add new site → Import an existing project** → pick your GitHub repo.
2. Build settings should auto-detect from `netlify.toml` — publish directory `public`, functions directory `netlify/functions`.
3. Once deployed, go to **Site configuration → Environment variables** and add:
   - `STRIPE_SECRET_KEY` = your Stripe secret key from Step 1
   - `STRIPE_WEBHOOK_SECRET` = (see Step 4 below)
4. Netlify Blobs (used to track seats and delegate rosters) works automatically — no extra setup needed.

## Step 4 — Connect the Stripe webhook

This is what confirms payment and updates the seat counter — without it, seats won't count down.

1. In Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://YOUR-NETLIFY-SITE.netlify.app/.netlify/functions/stripe-webhook`
3. Select event: `checkout.session.completed`
4. Copy the **Signing secret** it gives you (`whsec_...`) and add it to Netlify as `STRIPE_WEBHOOK_SECRET` (Step 3).

## Step 4b — Email confirmations, ops notifications, and HRD Corp invoices

These now fire automatically from the webhook the moment a payment confirms: a confirmation
email + PDF invoice to the booking contact, and a roster notification to your inbox.

1. Create a free Resend account: https://resend.com — the free tier covers 3,000 emails/month, plenty for this volume.
2. **Verify a sending domain** (e.g. `woowoo.world`) under Resend → Domains, following their DNS instructions (adds a couple of TXT/CNAME records at GoDaddy). Until this is verified, Resend will only let you send test emails to your own account email — not to delegates.
3. In Resend → API Keys, create a key and add it to Netlify's environment variables as `RESEND_API_KEY`.
4. Add these additional environment variables in Netlify:

   | Variable | Value |
   |---|---|
   | `FROM_EMAIL` | e.g. `bookings@woowoo.world` (must be on your verified domain) |
   | `OPS_NOTIFICATION_EMAIL` | the inbox that should get the delegate roster on every paid booking |
   | `COMPANY_NAME` | your registered company name, for the invoice header |
   | `COMPANY_REG_NO` | your SSM company registration number |
   | `COMPANY_ADDRESS` | your registered business address |
   | `COMPANY_SST_NO` | optional — only if you're SST-registered |
   | `ADMIN_SECRET` | a password of your choosing, used by `/admin-issue-credit.html` to issue Deep Dive → Masterclass transfer codes. Pick something long and random — anyone with this can issue credits. |

5. Redeploy the site after adding these (Netlify → Deploys → Trigger deploy) so the functions pick up the new variables.

If any of these are left unset, the system won't fail — it just skips that email and logs a
warning in the function logs, so it's safe to deploy the rest first and add these when ready.

## Step 4c — Fill in your legal details

Two places, not one — they don't share data automatically:

1. **`public/company-info.json`** — edit `legalName`, `registeredAddress`, `bookingContactEmail`, and `privacyContactEmail`. Both `terms-of-service.html` and `privacy-policy.html` fetch this file on load and fill themselves in from it — so editing this one file updates both pages.
2. **Netlify env vars** (`COMPANY_NAME`, `COMPANY_REG_NO`, `COMPANY_ADDRESS`, `COMPANY_SST_NO` above) — separate, used only for the invoice PDF. Keep the name/address consistent with what you put in `company-info.json`.

Have both Terms of Service and Privacy Policy reviewed by a Malaysian-qualified lawyer before treating them as final — they're marked as drafts on the page itself until then.

## Step 5 — Connect your domain

In Netlify → **Domain management**, add `woowoo.world` and/or `woowooworld.co`, then update the DNS records at GoDaddy as Netlify instructs (usually a couple of CNAME/A records). I can walk through the exact records once you're at this step.

## Step 6 — Test before going live

1. Use Stripe's **test mode** keys first (`sk_test_...`) and Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC.
2. Book a test seat, confirm the webhook fires (Stripe Dashboard → Webhooks → your endpoint → should show a successful delivery) and the seat counter goes down on the page.
3. Check that the confirmation email (with PDF invoice attached) and the ops notification both arrive — if not, check Netlify → Functions → stripe-webhook → logs for the warning/error.
4. Test a transfer credit end to end: issue one via `/admin-issue-credit.html`, apply it at Masterclass checkout, confirm the discount shows on the Stripe payment page and the code can't be reused.
5. Once confirmed, switch to live keys in Netlify's environment variables.

## Known limitations, worth knowing about

- **Deep Dive still uses static Stripe Payment Links**, not this dynamic checkout — so it can't offer Booking Protection or transfer credits itself (only Masterclass can). Migrating Deep Dive onto this same system is the natural next step, planned but not yet done.
- **Transfer credit codes are reserved at checkout creation, not at payment confirmation** — if someone starts checkout with a code and then abandons it without paying, that code stays locked as "redeemed" rather than releasing automatically (a genuine payment failure does release it). If this happens, you can manually flip a code back to `unused` in Netlify Blobs, or just issue a new one.
- **No automatic minimum cohort size** — a Masterclass cohort will run with any number of bookings, including just one. Worth deciding if you want a minimum before a cohort is confirmed to run.

