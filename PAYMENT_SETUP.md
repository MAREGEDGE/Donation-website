# Donation payment setup

The payment page offers these distinct routes:

- **M-Pesa:** KES hosted checkout through Flutterwave.
- **Visa/Mastercard:** USD hosted checkout through Flutterwave.
- **PayPal:** USD checkout through PayPal Orders.
- **Binance Pay:** USD donation value charged as USDT through Binance Pay.
- **Bitcoin:** USD invoice paid in BTC through NOWPayments.
- **ABSA bank transfer:** KES transfer, confirmed manually by the charity team.

Flutterwave processes M-Pesa and Visa/Mastercard; PayPal, Binance Pay, and
NOWPayments are separate merchant integrations. These services settle funds
to their respective merchant accounts/wallets according to each account's
settings; they do **not** all send funds directly to the ABSA account. Configure
and verify withdrawal/settlement to the charity's account separately with each
provider. Additional payment platforms require a separate provider integration
and approved merchant account; no site can accept payments from arbitrary
platforms without one.

Provider checkout options remain marked **Setup required** until the matching
server credentials are configured. No card details or payment PINs are
collected by this website. Never place provider secrets in HTML or browser
JavaScript.

## Configure providers

1. For local bank-transfer testing, no provider credentials or `.env` file are
   required. Start the site with `npm.cmd start` and open
   `http://localhost:3000/donate.html`.
2. For the hosted Netlify site, deploy the Node API using the included
   `render.yaml` Blueprint. Render needs a paid web-service plan for the
   persistent disk that stores donation records. Keep the generated Render
   service URL.
3. In Netlify, proxy `/api/*` to the Render service by adding this rule to the
   deployed site's `_redirects` file (in its publish directory), replacing the
   host with the actual Render service URL:

   ```text
   /api/* https://YOUR-RENDER-SERVICE.onrender.com/api/:splat 200
   ```

   Redeploy the Netlify site, then verify that
   `https://homecharityke.netlify.app/api/payment-methods` returns JSON rather
   than a Netlify 404 page. The API's `PUBLIC_BASE_URL` must remain set to the
   exact Netlify origin so same-origin checks and provider return URLs work.
4. Create and verify merchant accounts with the provider(s) you intend to use.
   Enter live credentials only in the Render service's environment settings;
   the Blueprint prompts for these secret values and does not store them in
   this repository:
   - Flutterwave: `FLW_SECRET_KEY` and webhook `FLW_SECRET_HASH`.
   - PayPal: live `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
   - Binance Pay: API secret and certificate serial number from a Binance Pay
     merchant account.
   - NOWPayments: production API key and IPN secret.
5. In every merchant dashboard, configure ABSA settlement/payout details where
   that provider supports them. This is provider-account configuration, not a
   website setting. Some providers may hold funds in a merchant or crypto
   balance first; verify settlement eligibility, fees, currency conversion,
   and payout schedule. The separate ABSA bank-transfer option continues to
   require manual deposit confirmation.
6. Configure provider webhooks to the public Netlify API paths after the
   Netlify rewrite is deployed:
   - Flutterwave:
     `https://homecharityke.netlify.app/api/payments/flutterwave/webhook`
   - NOWPayments:
     `https://homecharityke.netlify.app/api/payments/nowpayments/webhook`
7. Test each live provider with an approved low-value transaction before
   advertising the method. Do not enter card details, payment PINs, or API
   secrets into the website or chat.
8. For local development only, copy `.env.example` to `.env`, keep it private,
   and use sandbox credentials. Install, test, and run:

   ```powershell
   npm.cmd install
   npm.cmd test
   npm.cmd start
   ```

## Currency and settlement

M-Pesa and the ABSA transfer option are denominated in whole KES amounts.
Cards and PayPal are charged in USD. Binance Pay presents the same USD value as
USDT; Bitcoin invoices price the gift in USD and calculate the BTC due at the
provider's quoted rate. Provider conversion rates, settlement currencies, fees,
availability, and country restrictions are determined by the merchant account
and checkout provider. Verify these in each provider's test mode and account
dashboard before advertising them.

Each online attempt is written to the local SQLite database as `pending`.
Flutterwave returns are checked against Flutterwave's transaction verification
API; Flutterwave webhooks are signature checked and verified with the API.
PayPal orders are captured by the server and their returned amount, currency,
reference, and order ID are checked. Binance Pay status is queried server to
server. NOWPayments payment notifications are validated with the configured
IPN HMAC secret and checked against the recorded order and USD amount. Only a
verified provider result changes an online donation to `paid`.

Bank-transfer instructions are not a payment confirmation. Reconcile the
ABSA statement independently and only mark a donation received after the bank
deposit appears.

## Production checks

- Deploy the Node server behind HTTPS and set `PUBLIC_BASE_URL` to its exact
  public website origin. Do not deploy the donation page as static-only files;
  the payment API and webhook endpoints must be online.
- Use separate test and live credentials, protect them with the host's secret
  manager, and restrict access to the server and database.
- Keep `DATABASE_PATH` on a persistent, backed-up volume. Define retention and
  deletion policies for donor names, email addresses, and payment references.
- Complete a successful and failed/cancelled sandbox transaction for every
  configured method; test delayed webhook and duplicate-notification behavior.
- Confirm provider eligibility for the charity and country, account ownership,
  supported currencies, settlement schedule/fees, and refund process.
- Review applicable legal, fundraising, tax, privacy, and crypto compliance
  requirements. Do not claim donations are tax deductible unless authorized.

References:
[Flutterwave methods](https://developer.flutterwave.com/docs/payment-methods.md),
[Flutterwave Standard](https://developer.flutterwave.com/docs/flutterwave-standard-1.md),
[Flutterwave verification](https://developer.flutterwave.com/docs/transaction-verification.md),
[PayPal OAuth](https://developer.paypal.com/api/rest/authentication/),
[PayPal Orders API](https://developer.paypal.com/api/orders/v2),
[Binance Pay create order](https://developers.binance.com/docs/binance-pay/merchant/order/create-order),
[NOWPayments API](https://documenter.getpostman.com/view/7907941/2s93JusNJt).
