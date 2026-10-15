# Donation payment setup

The payment page offers these distinct routes:

- **M-Pesa:** KES STK Push directly through Safaricom Daraja.
- **Visa/Mastercard:** USD hosted card checkout through Pesapal.
- **PayPal:** USD checkout through PayPal Orders.
- **Binance Pay:** USD donation value charged as USDT through Binance Pay.
- **Bitcoin:** USD invoice paid in BTC through NOWPayments.
- **ABSA bank transfer:** KES transfer, confirmed manually by the charity team.

Safaricom processes M-Pesa and Pesapal processes Visa/Mastercard; PayPal,
Binance Pay, and NOWPayments are separate merchant integrations. These services settle funds
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
   - Safaricom Daraja: `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`,
     `MPESA_SHORTCODE`, and `MPESA_PASSKEY`.
   - Pesapal: `PESAPAL_CONSUMER_KEY`, `PESAPAL_CONSUMER_SECRET`, and the
     registered `PESAPAL_IPN_ID`.
   - PayPal: live `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
   - Binance Pay: API secret and certificate serial number from a Binance Pay
     merchant account.
   - NOWPayments: production API key and IPN secret.
   The Render Blueprint starts the new Safaricom and Pesapal integrations in
   sandbox mode. Keep `MPESA_ENV=sandbox` and `PESAPAL_ENV=sandbox` while
   testing; switch each to `live` in Render only after the matching production
   merchant account and credentials are approved and a sandbox transaction
   succeeds.
5. In every merchant dashboard, configure ABSA settlement/payout details where
   that provider supports them. This is provider-account configuration, not a
   website setting. Some providers may hold funds in a merchant or crypto
   balance first; verify settlement eligibility, fees, currency conversion,
   and payout schedule. The separate ABSA bank-transfer option continues to
   require manual deposit confirmation.
6. Register the Pesapal IPN URL
   `https://homecharityke.netlify.app/api/payments/pesapal/ipn` with Pesapal
   using API 3.0's `POST /api/URLSetup/RegisterIPN` endpoint and
   `ipn_notification_type: "GET"`. Store the returned `ipn_id` as
   `PESAPAL_IPN_ID` in Render. Safaricom's callback URL is supplied per STK
   Push request and is generated from `PUBLIC_BASE_URL`.
   Configure the NOWPayments webhook to:
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
M-Pesa STK Push results are queried directly from Safaricom using the recorded
checkout request ID; callbacks only trigger that server-to-server verification.
Pesapal card results are queried using the recorded order tracking ID and
checked against the expected amount, currency, and donation reference. Pesapal
IPNs are also verified against the Pesapal status API before updating a
donation. PayPal orders are captured by the server and their returned amount, currency,
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
[Safaricom Daraja API portal](https://developer.safaricom.co.ke/),
[Pesapal API 3.0](https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/api-reference),
[Pesapal submit order](https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/submitorderrequest),
[Pesapal transaction status](https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/gettransactionstatus),
[PayPal OAuth](https://developer.paypal.com/api/rest/authentication/),
[PayPal Orders API](https://developer.paypal.com/api/orders/v2),
[Binance Pay create order](https://developers.binance.com/docs/binance-pay/merchant/order/create-order),
[NOWPayments API](https://documenter.getpostman.com/view/7907941/2s93JusNJt).
