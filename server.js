const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
require('dotenv').config();

const MPESA_PRODUCTION_API = 'https://api.safaricom.co.ke';
const PESAPAL_PRODUCTION_API = 'https://pay.pesapal.com/v3';
const PAYPAL_PRODUCTION_API = 'https://api-m.paypal.com';
const BINANCE_PAY_API = 'https://bpay.binanceapi.com';
const NOWPAYMENTS_PRODUCTION_API = 'https://api.nowpayments.io/v1';
const MAX_KES_AMOUNT = 10_000_000;
const MAX_USD_CENTS = 1_000_000;
const PAYMENT_METHODS = [
    { id: 'mpesa', name: 'M-Pesa', currency: 'KES', detail: 'Secure M-Pesa checkout' },
    { id: 'mpesa-send', name: 'M-Pesa Send Money', currency: 'KES', detail: 'Send directly to our M-Pesa number' },
    { id: 'card', name: 'Visa / Mastercard', currency: 'USD', detail: 'Secure card checkout' },
    { id: 'paypal', name: 'PayPal', currency: 'USD', detail: 'Pay with your PayPal account' },
    { id: 'binance', name: 'Binance Pay', currency: 'USD', detail: 'Paid in USDT at Binance checkout' },
    { id: 'bitcoin', name: 'Bitcoin', currency: 'USD', detail: 'USD amount converted to BTC at checkout' },
    { id: 'bank', name: 'Bank transfer', currency: 'KES', detail: 'Manual confirmation by the charity team' }
];

function parseDonation(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Enter your donation details and try again.' };
    }

    const method = PAYMENT_METHODS.find((item) => item.id === body.method);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!method) return { error: 'Choose an available payment method.' };
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
        return { error: 'Enter your name (up to 100 characters).' };
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { error: 'Enter a valid email address.' };
    }

    let phone;
    if (method.id === 'mpesa') {
        const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
        phone = rawPhone.replace(/[\s()-]/g, '');
        if (phone.startsWith('+')) phone = phone.slice(1);
        if (phone.startsWith('0')) phone = `254${phone.slice(1)}`;
        if (!/^254[17]\d{8}$/.test(phone)) {
            return { error: 'Enter a valid Kenyan M-Pesa mobile number.' };
        }
    }

    let amountMinor;
    if (method.currency === 'KES') {
        const amount = Number(body.amount);
        if (!Number.isSafeInteger(amount) || amount < 10 || amount > MAX_KES_AMOUNT) {
            return { error: 'Enter a whole-number donation between KES 10 and KES 10,000,000.' };
        }
        amountMinor = amount;
    } else {
        const amountString = String(body.amount || '');
        if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(amountString)) {
            return { error: 'Enter a USD donation with no more than two decimal places.' };
        }
        amountMinor = Math.round(Number(amountString) * 100);
        if (!Number.isSafeInteger(amountMinor) || amountMinor < 100 || amountMinor > MAX_USD_CENTS) {
            return { error: 'Enter a donation between USD 1.00 and USD 10,000.00.' };
        }
    }

    return {
        value: {
            method: method.id,
            currency: method.currency,
            amountMinor,
            amount: method.currency === 'KES' ? amountMinor : amountMinor / 100,
            name,
            email,
            ...(phone ? { phone } : {})
        }
    };
}

function toUsd(amountMinor) {
    return (amountMinor / 100).toFixed(2);
}

function compareSecrets(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sortObject(value) {
    if (Array.isArray(value)) return value.map(sortObject);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((sorted, key) => {
        sorted[key] = sortObject(value[key]);
        return sorted;
    }, {});
}

function trustedCheckoutUrl(value, allowedHosts) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Payment provider returned an invalid checkout URL.');
    }
    const isAllowed = allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    if (url.protocol !== 'https:' || !isAllowed) {
        throw new Error('Payment provider returned an untrusted checkout URL.');
    }
    return url.toString();
}

function createApp(options = {}) {
    const config = options.config || process.env;
    const fetchImpl = options.fetchImpl || fetch;
    const databasePath = options.dbPath
        || process.env.DATABASE_PATH
        || path.join(__dirname, 'data', 'donations.sqlite');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });

    const db = new Database(databasePath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS bank_transfer_donations (
            reference TEXT PRIMARY KEY,
            amount INTEGER NOT NULL,
            currency TEXT NOT NULL,
            donor_name TEXT NOT NULL,
            donor_email TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('awaiting_transfer', 'received', 'expired')),
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS online_donations (
            reference TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            amount_minor INTEGER NOT NULL,
            currency TEXT NOT NULL,
            donor_name TEXT NOT NULL,
            donor_email TEXT NOT NULL,
            provider_order_id TEXT,
            status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
            created_at TEXT NOT NULL
        )
    `);

    const app = express();
    app.disable('x-powered-by');
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                baseUri: ["'self'"],
                objectSrc: ["'none'"],
                frameAncestors: ["'none'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                fontSrc: ["'self'"],
                connectSrc: ["'self'"],
                formAction: ["'self'"],
                upgradeInsecureRequests: null
            }
        }
    }));
    app.use('/api', rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 30,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        skip: (request) => ['/webhook', '/callback', '/ipn'].some((suffix) => request.path.endsWith(suffix))
    }));
    app.use(express.json({
        limit: '16kb',
        type: 'application/json',
        verify: (request, response, buffer) => {
            request.rawBody = Buffer.from(buffer);
        }
    }));
    app.use('/api', (request, response, next) => {
        response.setHeader('Cache-Control', 'no-store');
        next();
    });
    app.get('/donate.html', (request, response) => {
        response.sendFile(path.join(__dirname, 'donate.html'));
    });

    const configuredPublicBaseUrl = String(config.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    let publicOrigin = '';
    try {
        const parsedBase = new URL(configuredPublicBaseUrl);
        if ((parsedBase.protocol === 'https:' || parsedBase.hostname === 'localhost' || parsedBase.hostname === '127.0.0.1')
            && parsedBase.pathname === '/' && !parsedBase.search && !parsedBase.hash) {
            publicOrigin = parsedBase.origin;
        }
    } catch {
        publicOrigin = '';
    }

    function availableMethods() {
        return {
            mpesa: hasCredentials(
                config.MPESA_CONSUMER_KEY,
                config.MPESA_CONSUMER_SECRET,
                config.MPESA_SHORTCODE,
                config.MPESA_PASSKEY
            ),
            'mpesa-send': true,
            card: hasCredentials(
                config.PESAPAL_CONSUMER_KEY,
                config.PESAPAL_CONSUMER_SECRET,
                config.PESAPAL_IPN_ID
            ),
            paypal: hasCredentials(config.PAYPAL_CLIENT_ID, config.PAYPAL_CLIENT_SECRET),
            binance: hasCredentials(config.BINANCE_PAY_API_SECRET, config.BINANCE_PAY_CERTIFICATE_SN),
            bitcoin: hasCredentials(config.NOWPAYMENTS_API_KEY, config.NOWPAYMENTS_IPN_SECRET),
            bank: true
        };
    }

    function requestOriginFromRequest(request) {
        const explicitOrigin = request.get('origin');
        if (explicitOrigin) {
            try {
                return new URL(explicitOrigin).origin;
            } catch {
                return '';
            }
        }

        const forwardedProto = (request.get('x-forwarded-proto') || request.protocol || 'http')
            .split(',')[0]
            .trim();
        const forwardedHost = (request.get('x-forwarded-host') || request.get('host') || '')
            .split(',')[0]
            .trim();

        if (!forwardedHost) return '';
        const protocol = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : 'http';
        return `${protocol}://${forwardedHost}`;
    }

    function sameOrigin(request) {
        const originValue = requestOriginFromRequest(request);
        if (!originValue) return false;

        let origin;
        try {
            origin = new URL(originValue);
        } catch {
            return false;
        }

        const localHttp = origin.protocol === 'http:'
            && ['localhost', '127.0.0.1'].includes(origin.hostname);
        if (origin.protocol !== 'https:' && !localHttp) return false;
        if (publicOrigin) return origin.origin === publicOrigin;
        return origin.host === request.get('host');
    }

    function requestPublicOrigin(request) {
        return publicOrigin || requestOriginFromRequest(request);
    }

    function hasCredentials(...values) {
        return values.every((value) => typeof value === 'string'
            && value.length > 0
            && !value.toLowerCase().includes('replace-with'));
    }

    async function providerJson(url, init) {
        const response = await fetchImpl(url, {
            ...init,
            signal: AbortSignal.timeout(15000)
        });
        const payload = await response.json().catch(() => {
            throw new Error('Payment provider returned an unreadable response.');
        });
        if (!response.ok) throw new Error('Payment provider request failed.');
        return payload;
    }

    async function paypalAccessToken() {
        const sandbox = config.PAYPAL_ENV !== 'live';
        const base = sandbox ? 'https://api-m.sandbox.paypal.com' : PAYPAL_PRODUCTION_API;
        const authorization = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString('base64');
        const payload = await providerJson(`${base}/v1/oauth2/token`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${authorization}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        });
        if (!payload.access_token) throw new Error('PayPal did not return an access token.');
        return { base, accessToken: payload.access_token };
    }

    let mpesaToken = '';
    let mpesaTokenExpiresAt = 0;
    async function mpesaAccessToken() {
        if (mpesaToken && mpesaTokenExpiresAt > Date.now()) return mpesaToken;
        const base = config.MPESA_ENV === 'live' ? MPESA_PRODUCTION_API : 'https://sandbox.safaricom.co.ke';
        const credentials = Buffer.from(`${config.MPESA_CONSUMER_KEY}:${config.MPESA_CONSUMER_SECRET}`).toString('base64');
        const payload = await providerJson(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
            headers: { Authorization: `Basic ${credentials}` }
        });
        if (!payload.access_token) throw new Error('Safaricom did not return an access token.');
        mpesaToken = payload.access_token;
        mpesaTokenExpiresAt = Date.now() + Math.max(30, Number(payload.expires_in) || 3600) * 1000 - 30000;
        return mpesaToken;
    }

    async function requestMpesaStatus(checkoutRequestId) {
        const base = config.MPESA_ENV === 'live' ? MPESA_PRODUCTION_API : 'https://sandbox.safaricom.co.ke';
        const token = await mpesaAccessToken();
        const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
        const password = Buffer.from(`${config.MPESA_SHORTCODE}${config.MPESA_PASSKEY}${timestamp}`).toString('base64');
        const result = await providerJson(`${base}/mpesa/stkpushquery/v1/query`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                BusinessShortCode: config.MPESA_SHORTCODE,
                Password: password,
                Timestamp: timestamp,
                CheckoutRequestID: checkoutRequestId
            })
        });
        if (result.CheckoutRequestID !== checkoutRequestId) {
            throw new Error('Safaricom returned a mismatched checkout reference.');
        }
        return result;
    }

    const pesapalBase = config.PESAPAL_ENV === 'live' ? PESAPAL_PRODUCTION_API : 'https://cybqa.pesapal.com/pesapalv3';
    let pesapalToken = '';
    let pesapalTokenExpiresAt = 0;
    async function pesapalAccessToken() {
        if (pesapalToken && pesapalTokenExpiresAt > Date.now()) return pesapalToken;
        const payload = await providerJson(`${pesapalBase}/api/Auth/RequestToken`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                consumer_key: config.PESAPAL_CONSUMER_KEY,
                consumer_secret: config.PESAPAL_CONSUMER_SECRET
            })
        });
        if (!payload.token) throw new Error('Pesapal did not return an access token.');
        pesapalToken = payload.token;
        const expiresAt = Date.parse(payload.expiryDate);
        pesapalTokenExpiresAt = Number.isFinite(expiresAt) ? expiresAt - 30000 : Date.now() + 4 * 60 * 1000;
        return pesapalToken;
    }

    async function queryPesapalOrder(orderTrackingId) {
        const token = await pesapalAccessToken();
        return providerJson(`${pesapalBase}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json'
            }
        });
    }

    async function updatePesapalDonation(donation) {
        if (!donation.provider_order_id) return 'pending';
        const result = await queryPesapalOrder(donation.provider_order_id);
        const expectedAmount = donation.currency === 'KES' ? donation.amount_minor : donation.amount_minor / 100;
        const matches = result.merchant_reference === donation.reference
            && result.currency === donation.currency
            && Number(result.amount) === expectedAmount;
        const status = String(result.payment_status_description || '').toLowerCase();
        if (matches && Number(result.status_code) === 1 && status === 'completed') {
            markPaid.run(result.confirmation_code || donation.provider_order_id, donation.reference);
            return 'paid';
        }
        if (['0', '2', '3'].includes(String(result.status_code))
            || ['failed', 'reversed', 'invalid'].includes(status)) {
            markFailed.run(donation.reference);
            return 'failed';
        }
        return 'pending';
    }

    async function updateMpesaDonation(donation) {
        if (!donation.provider_order_id) return 'pending';
        const result = await requestMpesaStatus(donation.provider_order_id);
        if (result.ResultCode === undefined || result.ResultCode === null) return 'pending';
        if (String(result.ResponseCode) !== '0') return 'pending';
        const resultCode = Number(result.ResultCode);
        if (!Number.isFinite(resultCode)) return 'pending';
        if (resultCode === 0) {
            markPaid.run(donation.provider_order_id, donation.reference);
            return 'paid';
        }
        markFailed.run(donation.reference);
        return 'failed';
    }

    async function binanceRequest(payload) {
        const timestamp = String(Date.now());
        const nonce = crypto.randomBytes(16).toString('hex');
        const body = JSON.stringify(payload);
        const signature = crypto.createHmac('sha512', config.BINANCE_PAY_API_SECRET)
            .update(`${timestamp}\n${nonce}\n${body}\n`)
            .digest('hex')
            .toUpperCase();
        const result = await providerJson(`${BINANCE_PAY_API}/binancepay/openapi/v3/order`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'BinancePay-Timestamp': timestamp,
                'BinancePay-Nonce': nonce,
                'BinancePay-Certificate-SN': config.BINANCE_PAY_CERTIFICATE_SN,
                'BinancePay-Signature': signature
            },
            body
        });
        if (result.status !== 'SUCCESS') throw new Error('Binance Pay could not create the order.');
        return result.data;
    }

    async function queryBinanceOrder(reference) {
        const timestamp = String(Date.now());
        const nonce = crypto.randomBytes(16).toString('hex');
        const body = JSON.stringify({ merchantTradeNo: reference });
        const signature = crypto.createHmac('sha512', config.BINANCE_PAY_API_SECRET)
            .update(`${timestamp}\n${nonce}\n${body}\n`)
            .digest('hex')
            .toUpperCase();
        const result = await providerJson(`${BINANCE_PAY_API}/binancepay/openapi/v2/order/query`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'BinancePay-Timestamp': timestamp,
                'BinancePay-Nonce': nonce,
                'BinancePay-Certificate-SN': config.BINANCE_PAY_CERTIFICATE_SN,
                'BinancePay-Signature': signature
            },
            body
        });
        if (result.status !== 'SUCCESS') throw new Error('Binance Pay could not verify the order.');
        return result.data;
    }

    const getOnlineDonation = db.prepare('SELECT * FROM online_donations WHERE reference = ?');
    const getDonationByProviderOrder = db.prepare('SELECT * FROM online_donations WHERE provider = ? AND provider_order_id = ?');
    const markPaid = db.prepare(`
        UPDATE online_donations SET status = 'paid', provider_order_id = COALESCE(?, provider_order_id)
        WHERE reference = ? AND status != 'paid'
    `);
    const markFailed = db.prepare(`
        UPDATE online_donations SET status = 'failed'
        WHERE reference = ? AND status = 'pending'
    `);

    async function createHostedCheckout(donation, reference, request) {
        const callbackBase = `${requestPublicOrigin(request)}/donate.html`;
        const returnUrl = `${callbackBase}?payment=return&gateway=${donation.method}&reference=${encodeURIComponent(reference)}`;
        const cancelUrl = `${callbackBase}?payment=cancelled&gateway=${donation.method}&reference=${encodeURIComponent(reference)}`;

        if (donation.method === 'mpesa') {
            const token = await mpesaAccessToken();
            const base = config.MPESA_ENV === 'live' ? MPESA_PRODUCTION_API : 'https://sandbox.safaricom.co.ke';
            const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
            const password = Buffer.from(`${config.MPESA_SHORTCODE}${config.MPESA_PASSKEY}${timestamp}`).toString('base64');
            const result = await providerJson(`${base}/mpesa/stkpush/v1/processrequest`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    BusinessShortCode: config.MPESA_SHORTCODE,
                    Password: password,
                    Timestamp: timestamp,
                    TransactionType: config.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
                    Amount: donation.amountMinor,
                    PartyA: donation.phone,
                    PartyB: config.MPESA_SHORTCODE,
                    PhoneNumber: donation.phone,
                    CallBackURL: `${requestPublicOrigin(request)}/api/payments/mpesa/callback`,
                    AccountReference: reference.slice(-12),
                    TransactionDesc: 'Home Charity donation'
                })
            });
            if (String(result.ResponseCode) !== '0' || !result.CheckoutRequestID) {
                throw new Error('Safaricom could not start the M-Pesa payment request.');
            }
            return { url: null, orderId: result.CheckoutRequestID, pending: true };
        }

        if (donation.method === 'card') {
            const token = await pesapalAccessToken();
            const names = donation.name.split(/\s+/);
            const firstName = names.shift() || donation.name;
            const lastName = names.join(' ') || firstName;
            const result = await providerJson(`${pesapalBase}/api/Transactions/SubmitOrderRequest`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    id: reference,
                    currency: donation.currency,
                    amount: donation.amount,
                    description: 'Home Charity donation',
                    callback_url: returnUrl,
                    notification_id: config.PESAPAL_IPN_ID,
                    billing_address: {
                        email_address: donation.email,
                        phone_number: '',
                        country_code: 'KE',
                        first_name: firstName,
                        last_name: lastName
                    }
                })
            });
            if (!result.order_tracking_id || result.merchant_reference !== reference || !result.redirect_url) {
                throw new Error('Pesapal did not return a valid card checkout order.');
            }
            return {
                url: trustedCheckoutUrl(result.redirect_url, ['pesapal.com']),
                orderId: result.order_tracking_id
            };
        }

        if (donation.method === 'paypal') {
            const { base, accessToken } = await paypalAccessToken();
            const result = await providerJson(`${base}/v2/checkout/orders`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'PayPal-Request-Id': reference
                },
                body: JSON.stringify({
                    intent: 'CAPTURE',
                    purchase_units: [{
                        reference_id: reference,
                        custom_id: reference,
                        invoice_id: reference,
                        description: 'Home Charity donation',
                        amount: { currency_code: 'USD', value: toUsd(donation.amountMinor) }
                    }],
                    application_context: {
                        brand_name: 'Home Charity',
                        user_action: 'PAY_NOW',
                        return_url: returnUrl,
                        cancel_url: cancelUrl
                    }
                })
            });
            const approval = result.links?.find((link) => ['approve', 'payer-action'].includes(link.rel))?.href;
            if (!result.id || !approval) throw new Error('PayPal did not return an approval link.');
            const trustedUrl = trustedCheckoutUrl(approval, [
                config.PAYPAL_ENV === 'live' ? 'paypal.com' : 'sandbox.paypal.com'
            ]);
            return { url: trustedUrl, orderId: result.id };
        }

        if (donation.method === 'binance') {
            const result = await binanceRequest({
                env: { terminalType: 'WEB' },
                merchantTradeNo: reference,
                orderAmount: toUsd(donation.amountMinor),
                currency: 'USDT',
                goods: {
                    goodsType: '01',
                    goodsCategory: 'Z000',
                    referenceGoodsId: reference,
                    goodsName: 'Home Charity donation'
                },
                returnUrl,
                cancelUrl
            });
            return {
                url: trustedCheckoutUrl(result.checkoutUrl, ['binance.com']),
                orderId: result.prepayId || reference
            };
        }

        if (donation.method === 'bitcoin') {
            const nowPaymentsApi = config.NOWPAYMENTS_ENV === 'sandbox'
                ? 'https://api-sandbox.nowpayments.io/v1'
                : NOWPAYMENTS_PRODUCTION_API;
            const result = await providerJson(`${nowPaymentsApi}/invoice`, {
                method: 'POST',
                headers: {
                    'x-api-key': config.NOWPAYMENTS_API_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    price_amount: Number(toUsd(donation.amountMinor)),
                    price_currency: 'usd',
                    pay_currency: 'btc',
                    order_id: reference,
                    order_description: 'Home Charity donation',
                    ipn_callback_url: `${requestPublicOrigin(request)}/api/payments/nowpayments/webhook`,
                    success_url: returnUrl,
                    cancel_url: cancelUrl
                })
            });
            return {
                url: trustedCheckoutUrl(result.invoice_url, ['nowpayments.io']),
                orderId: String(result.id)
            };
        }

        throw new Error('That payment method is not an online checkout.');
    }

    app.get('/api/payment-methods', (request, response) => {
        const availability = availableMethods();
        response.json({
            methods: PAYMENT_METHODS.map((method) => ({
                ...method,
                enabled: availability[method.id]
            }))
        });
    });

    app.post('/api/payments', async (request, response) => {
        if (!sameOrigin(request)) {
            return response.status(403).json({ error: 'Reload the donation page and try again.' });
        }
        const parsed = parseDonation(request.body);
        if (parsed.error) return response.status(400).json({ error: parsed.error });
        const donation = parsed.value;
        if (['mpesa-send', 'bank'].includes(donation.method)) {
            return response.status(400).json({ error: 'This payment method uses manual transfer instructions, not online checkout.' });
        }
        if (!availableMethods()[donation.method]) {
            return response.status(503).json({ error: 'This payment method is not configured yet. Please choose another method.' });
        }

        const reference = `D-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
        db.prepare(`
            INSERT INTO online_donations
                (reference, provider, amount_minor, currency, donor_name, donor_email, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
        `).run(reference, donation.method, donation.amountMinor, donation.currency, donation.name, donation.email, new Date().toISOString());

        try {
            const checkout = await createHostedCheckout(donation, reference, request);
            db.prepare('UPDATE online_donations SET provider_order_id = ? WHERE reference = ?')
                .run(checkout.orderId, reference);
            return response.status(201).json({
                checkoutUrl: checkout.url,
                reference,
                amount: donation.amount,
                currency: donation.currency,
                method: donation.method
            });
        } catch (error) {
            markFailed.run(reference);
            console.error(`Unable to initialize ${donation.method} checkout:`, error.message);
            return response.status(502).json({ error: 'Secure checkout could not be started. No donation has been confirmed; please try again.' });
        }
    });

    app.post('/api/payments/paypal/capture', async (request, response) => {
        if (!sameOrigin(request)) return response.status(403).json({ error: 'Reload the donation page and try again.' });
        if (!availableMethods().paypal) return response.status(503).json({ error: 'PayPal is not configured.' });
        const reference = request.body?.reference;
        const orderId = request.body?.orderId;
        if (typeof reference !== 'string' || !/^D-[A-F0-9]{24}$/.test(reference)
            || typeof orderId !== 'string' || !/^[A-Z0-9-]{1,40}$/i.test(orderId)) {
            return response.status(400).json({ error: 'The PayPal return details are invalid.' });
        }

        const donation = getOnlineDonation.get(reference);
        if (!donation || donation.provider !== 'paypal' || donation.provider_order_id !== orderId) {
            return response.status(404).json({ error: 'We could not find this PayPal donation.' });
        }
        if (donation.status === 'paid') return response.json({ status: 'paid' });
        if (donation.status !== 'pending') return response.json({ status: 'failed' });

        try {
            const { base, accessToken } = await paypalAccessToken();
            const result = await providerJson(`${base}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'PayPal-Request-Id': `capture-${reference}`
                },
                body: '{}'
            });
            const unit = result.purchase_units?.[0];
            const capture = unit?.payments?.captures?.[0];
            const correctPayment = result.id === orderId
                && unit?.custom_id === reference
                && capture?.amount?.currency_code === 'USD'
                && Number(capture.amount.value) === donation.amount_minor / 100;
            if (result.status === 'COMPLETED' && correctPayment) {
                markPaid.run(capture.id || orderId, reference);
                return response.json({ status: 'paid' });
            }
            if (result.status === 'VOIDED') {
                markFailed.run(reference);
                return response.json({ status: 'failed' });
            }
            return response.status(502).json({ error: 'PayPal has not confirmed this donation yet.' });
        } catch (error) {
            console.error('Unable to capture PayPal donation:', error.message);
            return response.status(502).json({ error: 'PayPal could not confirm the payment. Please retry the confirmation.' });
        }
    });

    app.get('/api/payments/status', async (request, response) => {
        if (request.get('origin') && !sameOrigin(request)) return response.status(403).json({ error: 'Reload the donation page and try again.' });
        const reference = request.query.reference;
        if (typeof reference !== 'string' || !/^D-[A-F0-9]{24}$/.test(reference)) {
            return response.status(400).json({ error: 'The payment reference is invalid.' });
        }
        const donation = getOnlineDonation.get(reference);
        if (!donation) return response.status(404).json({ error: 'We could not find this donation.' });
        if (donation.status === 'paid' || donation.status === 'failed') {
            return response.json({ status: donation.status });
        }

        if (donation.provider === 'mpesa' && availableMethods().mpesa) {
            try {
                return response.json({ status: await updateMpesaDonation(donation) });
            } catch (error) {
                console.error('Unable to verify Safaricom M-Pesa donation:', error.message);
                return response.status(502).json({ error: 'We could not verify the M-Pesa payment yet.' });
            }
        }
        if (donation.provider === 'card' && availableMethods().card) {
            try {
                return response.json({ status: await updatePesapalDonation(donation) });
            } catch (error) {
                console.error('Unable to verify Pesapal card donation:', error.message);
                return response.status(502).json({ error: 'We could not verify the card payment yet.' });
            }
        }

        if (donation.provider === 'binance' && availableMethods().binance) {
            try {
                const order = await queryBinanceOrder(reference);
                const matches = order.merchantTradeNo === reference
                    && order.currency === 'USDT'
                    && Number(order.orderAmount) === donation.amount_minor / 100;
                if (order.status === 'PAID' && matches) {
                    markPaid.run(order.prepayId || reference, reference);
                    return response.json({ status: 'paid' });
                }
                if (['CANCELED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(order.status)) {
                    markFailed.run(reference);
                    return response.json({ status: 'failed' });
                }
            } catch (error) {
                console.error('Unable to verify Binance Pay donation:', error.message);
                return response.status(502).json({ error: 'We could not verify the Binance Pay order yet.' });
            }
        }
        return response.json({ status: 'pending' });
    });

    app.post('/api/payments/mpesa/callback', async (request, response) => {
        const checkoutRequestId = request.body?.Body?.stkCallback?.CheckoutRequestID;
        if (typeof checkoutRequestId !== 'string' || !checkoutRequestId) {
            return response.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback details.' });
        }
        const donation = getDonationByProviderOrder.get('mpesa', checkoutRequestId);
        if (!donation || donation.status !== 'pending') {
            return response.json({ ResultCode: 0, ResultDesc: 'Callback acknowledged.' });
        }
        try {
            await updateMpesaDonation(donation);
            return response.json({ ResultCode: 0, ResultDesc: 'Callback acknowledged.' });
        } catch (error) {
            console.error('Unable to verify Safaricom M-Pesa callback:', error.message);
            return response.status(502).json({ ResultCode: 1, ResultDesc: 'Payment verification is temporarily unavailable.' });
        }
    });

    app.all('/api/payments/pesapal/ipn', async (request, response) => {
        const orderTrackingId = request.query.OrderTrackingId || request.body?.OrderTrackingId;
        const merchantReference = request.query.OrderMerchantReference || request.body?.OrderMerchantReference;
        const notificationType = request.query.OrderNotificationType || request.body?.OrderNotificationType;
        const acknowledgement = {
            orderNotificationType: notificationType || 'IPNCHANGE',
            orderTrackingId: typeof orderTrackingId === 'string' ? orderTrackingId : '',
            orderMerchantReference: typeof merchantReference === 'string' ? merchantReference : '',
            status: 200
        };
        if (typeof orderTrackingId !== 'string' || typeof merchantReference !== 'string') {
            return response.status(400).json({ ...acknowledgement, status: 500 });
        }
        const donation = getOnlineDonation.get(merchantReference);
        if (!donation || donation.provider !== 'card' || donation.provider_order_id !== orderTrackingId) {
            return response.json(acknowledgement);
        }
        if (donation.status !== 'pending') return response.json(acknowledgement);
        try {
            await updatePesapalDonation(donation);
            return response.json(acknowledgement);
        } catch (error) {
            console.error('Unable to verify Pesapal IPN:', error.message);
            return response.status(500).json({ ...acknowledgement, status: 500 });
        }
    });

    app.post('/api/payments/nowpayments/webhook', (request, response) => {
        const signature = request.get('x-nowpayments-sig');
        const expectedSignature = crypto.createHmac('sha512', config.NOWPAYMENTS_IPN_SECRET || '')
            .update(JSON.stringify(sortObject(request.body || {})))
            .digest('hex');
        if (!config.NOWPAYMENTS_IPN_SECRET || !compareSecrets(signature?.toLowerCase(), expectedSignature)) {
            return response.status(401).json({ error: 'Invalid webhook signature.' });
        }
        const payment = request.body;
        const donation = typeof payment.order_id === 'string' ? getOnlineDonation.get(payment.order_id) : null;
        if (!donation || donation.provider !== 'bitcoin') return response.status(200).json({ received: true });

        const correctPrice = payment.price_currency?.toLowerCase() === 'usd'
            && payment.pay_currency?.toLowerCase() === 'btc'
            && Number(payment.price_amount) === donation.amount_minor / 100;
        if (!correctPrice) return response.status(400).json({ error: 'Payment amount does not match the donation.' });
        if (payment.payment_status === 'finished') {
            markPaid.run(String(payment.payment_id || donation.provider_order_id), donation.reference);
        } else if (['failed', 'refunded', 'expired'].includes(payment.payment_status)) {
            markFailed.run(donation.reference);
        }
        return response.status(200).json({ received: true });
    });

    app.post('/api/bank-transfers', (request, response) => {
        if (!sameOrigin(request)) return response.status(403).json({ error: 'Reload the donation page and try again.' });
        const parsed = parseDonation({ ...request.body, method: 'bank' });
        if (parsed.error) return response.status(400).json({ error: parsed.error });
        const donation = parsed.value;
        const reference = `BANK-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        db.prepare(`
            INSERT INTO bank_transfer_donations
                (reference, amount, currency, donor_name, donor_email, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'awaiting_transfer', ?)
        `).run(reference, donation.amountMinor, donation.currency, donation.name, donation.email, new Date().toISOString());
        return response.status(201).json({ reference, amount: donation.amountMinor, currency: 'KES', status: 'awaiting_transfer' });
    });

    app.get(['/', '/index.html'], (request, response) => {
        response.sendFile(path.join(__dirname, 'index.html'));
    });
    for (const assetDirectory of ['css', 'images', 'js', 'webfonts']) {
        app.use(`/${assetDirectory}`, express.static(path.join(__dirname, assetDirectory), {
            dotfiles: 'deny',
            index: false
        }));
    }
    app.use((request, response) => response.status(404).json({ error: 'The requested page was not found.' }));
    app.use((error, request, response, next) => {
        if (response.headersSent) return next(error);
        if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
            return response.status(400).json({ error: 'The request body must be valid JSON.' });
        }
        console.error('Unhandled request error:', error.message);
        return response.status(500).json({ error: 'The request could not be completed.' });
    });

    app.locals.db = db;
    return app;
}

if (require.main === module) {
    const port = Number(process.env.PORT || 3000);
    createApp().listen(port, () => console.log(`Donation website listening on port ${port}`));
}

module.exports = { createApp, parseDonation, sortObject };
