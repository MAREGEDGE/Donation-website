const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, parseDonation, sortObject } = require('../server');

const TEST_CONFIG = {
    MPESA_ENV: 'sandbox',
    MPESA_CONSUMER_KEY: 'mpesa-test-key',
    MPESA_CONSUMER_SECRET: 'mpesa-test-secret',
    MPESA_SHORTCODE: '174379',
    MPESA_PASSKEY: 'mpesa-test-passkey',
    PESAPAL_ENV: 'sandbox',
    PESAPAL_CONSUMER_KEY: 'pesapal-test-key',
    PESAPAL_CONSUMER_SECRET: 'pesapal-test-secret',
    PESAPAL_IPN_ID: 'pesapal-test-ipn-id',
    PAYPAL_ENV: 'sandbox',
    PAYPAL_CLIENT_ID: 'paypal-test-client',
    PAYPAL_CLIENT_SECRET: 'paypal-test-secret',
    BINANCE_PAY_API_SECRET: 'binance-test-secret',
    BINANCE_PAY_CERTIFICATE_SN: 'binance-test-serial',
    NOWPAYMENTS_ENV: 'sandbox',
    NOWPAYMENTS_API_KEY: 'nowpayments-test-key',
    NOWPAYMENTS_IPN_SECRET: 'nowpayments-test-secret'
};

async function startApp(t, fetchImpl, overrides = {}) {
    const portPicker = net.createServer();
    await new Promise((resolve, reject) => {
        portPicker.once('error', reject);
        portPicker.listen(0, '127.0.0.1', resolve);
    });
    const { port } = portPicker.address();
    await new Promise((resolve, reject) => portPicker.close((error) => error ? reject(error) : resolve()));

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'donation-payment-test-'));
    const config = {
        ...TEST_CONFIG,
        PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
        ...overrides
    };
    const app = createApp({
        config,
        dbPath: path.join(directory, 'donations.sqlite'),
        fetchImpl
    });
    const server = app.listen(port, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${port}`;

    t.after(async () => {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
        app.locals.db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    return { app, baseUrl, config };
}

function providerResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function createPayment(baseUrl, { method, amount = 25, phone, name = 'Test Donor', email = 'donor@example.com' }) {
    return fetch(`${baseUrl}/api/payments`, {
        method: 'POST',
        headers: {
            Origin: baseUrl,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ method, amount, phone, name, email })
    });
}

test('reports only payment methods whose provider credentials are configured', async (t) => {
    const { baseUrl } = await startApp(t, async () => providerResponse({}), {
        MPESA_CONSUMER_KEY: 'replace-with-key',
        MPESA_CONSUMER_SECRET: 'replace-with-secret',
        MPESA_SHORTCODE: 'replace-with-shortcode',
        MPESA_PASSKEY: 'replace-with-passkey',
        PESAPAL_CONSUMER_KEY: 'replace-with-key',
        PESAPAL_CONSUMER_SECRET: 'replace-with-secret',
        PESAPAL_IPN_ID: 'replace-with-ipn-id',
        PAYPAL_CLIENT_ID: 'replace-with-client-id',
        PAYPAL_CLIENT_SECRET: 'replace-with-client-secret',
        BINANCE_PAY_API_SECRET: 'replace-with-api-secret',
        BINANCE_PAY_CERTIFICATE_SN: 'replace-with-certificate-serial',
        NOWPAYMENTS_API_KEY: 'replace-with-api-key',
        NOWPAYMENTS_IPN_SECRET: 'replace-with-ipn-secret'
    });
    const response = await fetch(`${baseUrl}/api/payment-methods`);
    const result = await response.json();
    const enabled = result.methods.filter((method) => method.enabled).map((method) => method.id);

    assert.deepEqual(enabled, ['mpesa-send', 'bank']);
    assert.equal(result.methods.find((method) => method.id === 'mpesa-send').currency, 'KES');
    assert.equal(result.methods.find((method) => method.id === 'mpesa').currency, 'KES');
    assert.equal(result.methods.find((method) => method.id === 'card').currency, 'USD');
});

test('enables direct M-Pesa and Pesapal card checkout when their full credentials are configured', async (t) => {
    const { baseUrl } = await startApp(t, async () => providerResponse({}));
    const response = await fetch(`${baseUrl}/api/payment-methods`);
    const result = await response.json();

    assert.equal(result.methods.find((method) => method.id === 'mpesa').enabled, true);
    assert.equal(result.methods.find((method) => method.id === 'mpesa-send').enabled, true);
    assert.equal(result.methods.find((method) => method.id === 'card').enabled, true);
});

test('keeps direct M-Pesa Send Money as manual instructions rather than online checkout', async (t) => {
    let providerCalled = false;
    const { baseUrl } = await startApp(t, async () => {
        providerCalled = true;
        return providerResponse({});
    }, {
        MPESA_CONSUMER_KEY: '',
        MPESA_CONSUMER_SECRET: '',
        MPESA_SHORTCODE: '',
        MPESA_PASSKEY: ''
    });
    const response = await createPayment(baseUrl, { method: 'mpesa-send', amount: 500 });
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.match(result.error, /manual transfer instructions/);
    assert.equal(providerCalled, false);
});

test('normalizes Kenyan M-Pesa numbers from both 07 and 01 mobile ranges', () => {
    const result = parseDonation({
        method: 'mpesa',
        amount: 500,
        phone: '0112 345 678',
        name: 'Test Donor',
        email: 'donor@example.com'
    });

    assert.equal(result.value.phone, '254112345678');
});

test('supports local bank-transfer checkout without requiring a PUBLIC_BASE_URL setting', async (t) => {
    const { app, baseUrl } = await startApp(t, async () => providerResponse({}), {
        PUBLIC_BASE_URL: ''
    });
    const response = await fetch(`${baseUrl}/api/bank-transfers`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 1000, name: 'Local Donor', email: 'local@example.com' })
    });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(result.status, 'awaiting_transfer');
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM bank_transfer_donations').get().count, 1);
});

test('accepts the configured public site origin through a reverse-proxied payment API', async (t) => {
    const publicOrigin = 'https://homecharityke.netlify.app';
    const { app, baseUrl } = await startApp(t, async () => providerResponse({}), {
        PUBLIC_BASE_URL: publicOrigin
    });
    const response = await fetch(`${baseUrl}/api/bank-transfers`, {
        method: 'POST',
        headers: {
            Origin: publicOrigin,
            Host: new URL(baseUrl).host,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ amount: 1000, name: 'Proxy Donor', email: 'proxy@example.com' })
    });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(result.status, 'awaiting_transfer');
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM bank_transfer_donations').get().count, 1);
});

test('accepts same-origin requests when the Origin header is omitted', async (t) => {
    const { app, baseUrl } = await startApp(t, async () => providerResponse({}));
    const response = await fetch(`${baseUrl}/api/bank-transfers`, {
        method: 'POST',
        headers: {
            Host: new URL(baseUrl).host,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ amount: 1000, name: 'Local Donor', email: 'local@example.com' })
    });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(result.status, 'awaiting_transfer');
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM bank_transfer_donations').get().count, 1);
});

test('creates a USD Pesapal card checkout with the server-owned amount and callback', async (t) => {
    let checkoutRequest;
    const { baseUrl } = await startApp(t, async (url, options) => {
        if (url.endsWith('/api/Auth/RequestToken')) return providerResponse({ token: 'pesapal-test-token' });
        if (url.endsWith('/api/Transactions/SubmitOrderRequest')) {
            checkoutRequest = JSON.parse(options.body);
            return providerResponse({
                order_tracking_id: 'PESAPAL-ORDER-123',
                merchant_reference: checkoutRequest.id,
                redirect_url: 'https://cybqa.pesapal.com/pesapalv3/api/Transactions/ToRedirect/123'
            });
        }
        throw new Error(`Unexpected provider URL ${url}`);
    });
    const response = await createPayment(baseUrl, { method: 'card', amount: 25 });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(checkoutRequest.amount, 25);
    assert.equal(checkoutRequest.currency, 'USD');
    assert.equal(checkoutRequest.notification_id, TEST_CONFIG.PESAPAL_IPN_ID);
    assert.equal(checkoutRequest.callback_url, `${baseUrl}/donate.html?payment=return&gateway=card&reference=${result.reference}`);
    assert.equal(checkoutRequest.id, result.reference);
    assert.match(result.reference, /^D-[A-F0-9]{24}$/);
    assert.equal(result.checkoutUrl, 'https://cybqa.pesapal.com/pesapalv3/api/Transactions/ToRedirect/123');
});

test('rejects a Pesapal checkout URL outside the provider domain', async (t) => {
    const { baseUrl } = await startApp(t, async (url, options) => {
        if (url.endsWith('/api/Auth/RequestToken')) return providerResponse({ token: 'pesapal-test-token' });
        return providerResponse({
            order_tracking_id: 'PESAPAL-ORDER-123',
            merchant_reference: JSON.parse(options.body).id,
            redirect_url: 'https://pesapal.com.attacker.example/pay'
        });
    });
    const response = await createPayment(baseUrl, { method: 'card', amount: 25 });

    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /could not be started/);
});

test('initiates direct Safaricom M-Pesa checkout and verifies the stored STK order', async (t) => {
    let checkoutRequest;
    let requestCount = 0;
    const { baseUrl } = await startApp(t, async (url, options) => {
        requestCount += 1;
        if (url.includes('/oauth/v1/generate')) return providerResponse({ access_token: 'mpesa-test-access-token', expires_in: '3599' });
        if (url.endsWith('/mpesa/stkpush/v1/processrequest')) {
            checkoutRequest = JSON.parse(options.body);
            assert.equal(options.headers.Authorization, 'Bearer mpesa-test-access-token');
            return providerResponse({
                ResponseCode: '0',
                CheckoutRequestID: 'ws_CO_12345',
                CustomerMessage: 'Success. Request accepted for processing'
            });
        }
        if (url.endsWith('/mpesa/stkpushquery/v1/query')) {
            assert.equal(JSON.parse(options.body).CheckoutRequestID, 'ws_CO_12345');
            return providerResponse({
                ResponseCode: '0',
                CheckoutRequestID: 'ws_CO_12345',
                ResultCode: 0,
                ResultDesc: 'The service request is processed successfully.'
            });
        }
        throw new Error(`Unexpected provider URL ${url}`);
    });
    const response = await createPayment(baseUrl, { method: 'mpesa', amount: 500, phone: '0712 345 678' });
    const result = await response.json();
    const callbackResponse = await fetch(`${baseUrl}/api/payments/mpesa/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            Body: { stkCallback: { CheckoutRequestID: 'ws_CO_12345', ResultCode: 0 } }
        })
    });
    const statusResponse = await fetch(
        `${baseUrl}/api/payments/status?${new URLSearchParams({ reference: result.reference })}`,
        { headers: { Origin: baseUrl } }
    );

    assert.equal(response.status, 201);
    assert.equal(result.checkoutUrl, null);
    assert.equal(checkoutRequest.Amount, 500);
    assert.equal(checkoutRequest.PartyA, '254712345678');
    assert.equal(checkoutRequest.PhoneNumber, '254712345678');
    assert.equal(checkoutRequest.CallBackURL, `${baseUrl}/api/payments/mpesa/callback`);
    assert.equal(callbackResponse.status, 200);
    assert.equal((await statusResponse.json()).status, 'paid');
    assert.equal(requestCount, 3);
});

test('rejects invalid M-Pesa numbers and USD amounts before contacting a provider', async (t) => {
    let providerCalled = false;
    const { baseUrl } = await startApp(t, async () => {
        providerCalled = true;
        return providerResponse({});
    });
    const invalidPhone = await createPayment(baseUrl, { method: 'mpesa', amount: 500, phone: '1234' });
    const invalidUsd = await createPayment(baseUrl, { method: 'paypal', amount: 0.999 });

    assert.equal(invalidPhone.status, 400);
    assert.equal(invalidUsd.status, 400);
    assert.equal(providerCalled, false);
});

test('creates PayPal orders in USD and captures only the matching completed order', async (t) => {
    let reference;
    let orderId;
    let captureCalled = false;
    const { baseUrl } = await startApp(t, async (url, options) => {
        if (url.endsWith('/v1/oauth2/token')) {
            return providerResponse({ access_token: 'paypal-test-access-token' });
        }
        if (url.endsWith('/v2/checkout/orders')) {
            const payload = JSON.parse(options.body);
            reference = payload.purchase_units[0].custom_id;
            assert.equal(payload.purchase_units[0].amount.currency_code, 'USD');
            assert.equal(payload.purchase_units[0].amount.value, '25.00');
            orderId = 'TEST-ORDER-123';
            return providerResponse({
                id: orderId,
                links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` }]
            });
        }
        if (url.endsWith(`/v2/checkout/orders/${orderId}/capture`)) {
            captureCalled = true;
            return providerResponse({
                id: orderId,
                status: 'COMPLETED',
                purchase_units: [{
                    custom_id: reference,
                    payments: { captures: [{ id: 'CAPTURE-1', amount: { currency_code: 'USD', value: '25.00' } }] }
                }]
            });
        }
        throw new Error(`Unexpected provider URL ${url}`);
    });
    const checkoutResponse = await createPayment(baseUrl, { method: 'paypal', amount: 25 });
    const checkout = await checkoutResponse.json();
    const captureResponse = await fetch(`${baseUrl}/api/payments/paypal/capture`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference, orderId })
    });

    assert.equal(checkoutResponse.status, 201);
    assert.equal(new URL(checkout.checkoutUrl).hostname, 'www.sandbox.paypal.com');
    assert.equal(captureResponse.status, 200);
    assert.deepEqual(await captureResponse.json(), { status: 'paid' });
    assert.equal(captureCalled, true);
});

test('creates Binance Pay orders in USDT with a signed API request and verifies the order server-side', async (t) => {
    let reference;
    let calls = 0;
    const { baseUrl, config } = await startApp(t, async (url, options) => {
        calls += 1;
        const body = JSON.parse(options.body);
        const timestamp = options.headers['BinancePay-Timestamp'];
        const nonce = options.headers['BinancePay-Nonce'];
        const expected = crypto.createHmac('sha512', config.BINANCE_PAY_API_SECRET)
            .update(`${timestamp}\n${nonce}\n${options.body}\n`)
            .digest('hex')
            .toUpperCase();
        assert.equal(options.headers['BinancePay-Signature'], expected);
        if (calls === 1) {
            reference = body.merchantTradeNo;
            assert.equal(body.currency, 'USDT');
            assert.equal(body.orderAmount, '25.00');
            return providerResponse({
                status: 'SUCCESS',
                data: { checkoutUrl: 'https://pay.binance.com/checkout/test', prepayId: 'PREPAY-1' }
            });
        }
        return providerResponse({
            status: 'SUCCESS',
            data: { merchantTradeNo: reference, currency: 'USDT', orderAmount: '25.00', status: 'PAID' }
        });
    });
    const checkoutResponse = await createPayment(baseUrl, { method: 'binance', amount: 25 });
    const checkout = await checkoutResponse.json();
    const statusResponse = await fetch(
        `${baseUrl}/api/payments/status?${new URLSearchParams({ reference: checkout.reference })}`,
        { headers: { Origin: baseUrl } }
    );

    assert.equal(checkoutResponse.status, 201);
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(await statusResponse.json(), { status: 'paid' });
});

test('creates a USD-priced Bitcoin invoice with signed IPN callback configuration', async (t) => {
    let invoiceRequest;
    const { baseUrl } = await startApp(t, async (url, options) => {
        invoiceRequest = JSON.parse(options.body);
        return providerResponse({
            id: 555,
            invoice_url: 'https://nowpayments.io/payment/?iid=555'
        });
    });
    const response = await createPayment(baseUrl, { method: 'bitcoin', amount: 10 });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(invoiceRequest.price_amount, 10);
    assert.equal(invoiceRequest.price_currency, 'usd');
    assert.equal(invoiceRequest.pay_currency, 'btc');
    assert.equal(invoiceRequest.order_id, result.reference);
    assert.equal(invoiceRequest.ipn_callback_url, `${baseUrl}/api/payments/nowpayments/webhook`);
    assert.equal(new URL(result.checkoutUrl).hostname, 'nowpayments.io');
});

test('accepts only correctly signed and amount-matched completed Bitcoin callbacks', async (t) => {
    const { baseUrl, config } = await startApp(t, async () => providerResponse({
        id: 555,
        invoice_url: 'https://nowpayments.io/payment/?iid=555'
    }));
    const checkout = await (await createPayment(baseUrl, { method: 'bitcoin', amount: 10 })).json();
    const payload = {
        payment_id: 'PAYMENT-555',
        payment_status: 'finished',
        price_amount: 10,
        price_currency: 'usd',
        pay_currency: 'btc',
        order_id: checkout.reference
    };
    const signature = crypto.createHmac('sha512', config.NOWPAYMENTS_IPN_SECRET)
        .update(JSON.stringify(sortObject(payload)))
        .digest('hex');
    const invalidResponse = await fetch(`${baseUrl}/api/payments/nowpayments/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': 'invalid' },
        body: JSON.stringify(payload)
    });
    const validResponse = await fetch(`${baseUrl}/api/payments/nowpayments/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': signature },
        body: JSON.stringify(payload)
    });
    const statusResponse = await fetch(
        `${baseUrl}/api/payments/status?${new URLSearchParams({ reference: checkout.reference })}`,
        { headers: { Origin: baseUrl } }
    );

    assert.equal(invalidResponse.status, 401);
    assert.equal(validResponse.status, 200);
    assert.deepEqual(await statusResponse.json(), { status: 'paid' });
});

test('confirms Pesapal card payments only after matching provider status verification', async (t) => {
    let reference;
    let statusQuery;
    const { baseUrl } = await startApp(t, async (url, options) => {
        if (url.endsWith('/api/Auth/RequestToken')) return providerResponse({ token: 'pesapal-test-token' });
        if (url.endsWith('/api/Transactions/SubmitOrderRequest')) {
            reference = JSON.parse(options.body).id;
            return providerResponse({
                order_tracking_id: 'PESAPAL-ORDER-456',
                merchant_reference: reference,
                redirect_url: 'https://cybqa.pesapal.com/pesapalv3/api/Transactions/ToRedirect/456'
            });
        }
        if (url.includes('/api/Transactions/GetTransactionStatus?')) {
            statusQuery = new URL(url).searchParams.get('orderTrackingId');
            return providerResponse({
                merchant_reference: reference,
                amount: 25,
                currency: 'USD',
                status_code: 1,
                payment_status_description: 'Completed',
                confirmation_code: 'PESA-CAPTURE-456'
            });
        }
        throw new Error(`Unexpected provider URL ${url}`);
    });
    const checkout = await (await createPayment(baseUrl, { method: 'card', amount: 25 })).json();
    const ipnResponse = await fetch(
        `${baseUrl}/api/payments/pesapal/ipn?${new URLSearchParams({
            OrderTrackingId: 'PESAPAL-ORDER-456',
            OrderMerchantReference: reference,
            OrderNotificationType: 'IPNCHANGE'
        })}`
    );
    const response = await fetch(
        `${baseUrl}/api/payments/status?${new URLSearchParams({ reference: checkout.reference })}`,
        { headers: { Origin: baseUrl } }
    );

    assert.equal(response.status, 200);
    assert.equal((await ipnResponse.json()).status, 200);
    assert.deepEqual(await response.json(), { status: 'paid' });
    assert.equal(statusQuery, 'PESAPAL-ORDER-456');
});

test('creates direct bank instructions as awaiting transfer, not as a completed payment', async (t) => {
    const { app, baseUrl } = await startApp(t, async () => providerResponse({}));
    const response = await fetch(`${baseUrl}/api/bank-transfers`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 1000, name: 'Test Donor', email: 'donor@example.com' })
    });
    const result = await response.json();
    const stored = app.locals.db.prepare('SELECT * FROM bank_transfer_donations WHERE reference = ?').get(result.reference);

    assert.equal(response.status, 201);
    assert.equal(result.currency, 'KES');
    assert.equal(result.status, 'awaiting_transfer');
    assert.equal(stored.status, 'awaiting_transfer');
});

test('rejects cross-origin payment attempts and does not expose server source', async (t) => {
    const { baseUrl, app } = await startApp(t, async () => providerResponse({}));
    const response = await fetch(`${baseUrl}/api/bank-transfers`, {
        method: 'POST',
        headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 1000, name: 'Test', email: 'a@example.com' })
    });
    const sourceResponse = await fetch(`${baseUrl}/server.js`);
    const wrongOriginResponse = await fetch(`${baseUrl}/api/payments`, {
        method: 'POST',
        headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'card', amount: 25, name: 'Test', email: 'a@example.com' })
    });

    assert.equal(response.status, 201);
    assert.equal(wrongOriginResponse.status, 403);
    assert.equal(sourceResponse.status, 404);
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS count FROM online_donations').get().count, 0);
});
