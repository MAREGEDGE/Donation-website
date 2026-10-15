(function () {
    const form = document.getElementById('donationForm');
    const amountInput = document.getElementById('donationAmount');
    const amountSummary = document.getElementById('donationAmountSummary');
    const currencyLabel = document.getElementById('amountCurrencyLabel');
    const currencySymbol = document.getElementById('amountCurrencySymbol');
    const message = document.getElementById('formMessage');
    const submitButton = document.getElementById('submitPaymentBtn');
    const submitLabel = submitButton.querySelector('.submit-label');
    const presets = Array.from(document.querySelectorAll('.amount-preset'));
    const paymentOptions = Array.from(document.querySelectorAll('input[name="paymentMethod"]'));
    const phoneGroup = document.getElementById('phoneGroup');
    const phoneInput = document.getElementById('phoneNumber');
    const transferInstructions = document.getElementById('transferInstructions');
    const amountByCurrency = { KES: '1000', USD: '25' };
    let methods = new Map();

    function selectedOption() {
        return paymentOptions.find((input) => input.checked);
    }

    function selectedMethod() {
        const input = selectedOption();
        return input ? methods.get(input.value) : null;
    }

    function formatAmount(value, currency) {
        const amount = Number(value);
        if (!Number.isFinite(amount)) return `${currency} 0`;
        return `${currency} ${new Intl.NumberFormat('en', {
            minimumFractionDigits: currency === 'USD' ? 2 : 0,
            maximumFractionDigits: currency === 'USD' ? 2 : 0
        }).format(amount)}`;
    }

    function updateAmountSummary() {
        const method = selectedMethod();
        if (!method) return;
        const currency = method.currency;
        amountSummary.textContent = formatAmount(amountInput.value, currency);
        presets.forEach((preset) => {
            const isSelected = preset.dataset.amount === amountInput.value;
            preset.classList.toggle('is-selected', isSelected);
            preset.setAttribute('aria-pressed', String(isSelected));
        });
    }

    function updateAmountControls(method) {
        const currency = method.currency;
        currencyLabel.textContent = currency;
        currencySymbol.textContent = currency;
        amountInput.min = currency === 'KES' ? '10' : '1.00';
        amountInput.max = currency === 'KES' ? '10000000' : '10000.00';
        amountInput.step = currency === 'KES' ? '1' : '0.01';
        amountInput.inputMode = currency === 'KES' ? 'numeric' : 'decimal';
        amountInput.value = amountByCurrency[currency];

        const suggestions = currency === 'KES'
            ? [{ amount: '500', label: 'KES 500' }, { amount: '1000', label: 'KES 1,000' }, { amount: '2500', label: 'KES 2,500' }]
            : [{ amount: '10', label: 'USD 10' }, { amount: '25', label: 'USD 25' }, { amount: '50', label: 'USD 50' }];
        presets.forEach((preset, index) => {
            preset.dataset.amount = suggestions[index].amount;
            preset.textContent = suggestions[index].label;
        });
        updateAmountSummary();
    }

    function showMessage(text, type, actionLabel, action) {
        message.replaceChildren(document.createTextNode(text));
        message.className = `form-message show ${type}`;
        if (actionLabel && action) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'payment-status-action';
            button.textContent = actionLabel;
            button.addEventListener('click', action);
            message.append(document.createElement('br'), button);
        }
    }

    function setBusy(busy, label) {
        submitButton.disabled = busy || !selectedOption() || selectedOption().disabled;
        submitButton.setAttribute('aria-busy', String(busy));
        submitLabel.textContent = busy ? label : buttonLabel(selectedMethod());
    }

    function buttonLabel(method) {
        if (!method) return 'Choose a payment method';
        return method.id === 'bank' ? 'Show bank transfer instructions' : `Continue to ${method.name}`;
    }

    function setMethodDetails(method) {
        const isBank = method.id === 'bank';
        const isMpesa = method.id === 'mpesa';
        const donorNameInput = document.getElementById('donorName');
        const donorEmailInput = document.getElementById('email');
        document.querySelector('.donor-name-group').hidden = isBank;
        document.querySelector('.donor-email-group').hidden = isBank;
        donorNameInput.required = !isBank;
        donorEmailInput.required = !isBank;
        phoneGroup.hidden = !isMpesa;
        phoneInput.required = isMpesa;
        transferInstructions.hidden = true;

        if (isBank) {
            document.getElementById('checkoutInfoTitle').textContent = 'Transfer directly to our ABSA account';
            document.getElementById('checkoutInfoText').textContent = 'We will provide the donation amount and a unique reference for your bank transfer. Your charity team will confirm the deposit manually.';
            document.getElementById('paymentPromiseText').textContent = 'A bank transfer is confirmed only after the charity team matches the deposit against its bank statement.';
            document.getElementById('summaryMethod').textContent = 'Bank transfer donation';
            document.getElementById('paymentFeeSummary').textContent = 'Set by your bank';
            document.querySelector('.payment-footnote').textContent = 'The instructions are not proof of payment. The charity team must verify your deposit manually.';
        } else {
            document.getElementById('checkoutInfoTitle').textContent = 'Your payment is securely processed';
            document.getElementById('checkoutInfoText').textContent = isMpesa
                ? 'Safaricom will send an M-Pesa prompt to your phone. Approve it in the official M-Pesa prompt; never enter your PIN on this website.'
                : method.id === 'card'
                    ? 'Continue to Pesapal’s hosted Visa or Mastercard checkout. Your card details are entered only on Pesapal.'
                    : 'Continue to the selected provider’s hosted checkout. PayPal, Binance Pay, and Bitcoin payments are processed away from this website.';
            document.getElementById('paymentPromiseText').textContent = 'We confirm online donations only after the payment provider verifies the transaction.';
            document.getElementById('summaryMethod').textContent = `${method.name} donation`;
            document.getElementById('paymentFeeSummary').textContent = 'Shown by provider';
            document.querySelector('.payment-footnote').textContent = 'Only provider-verified transactions are confirmed as paid. Do not enter payment PINs or banking passwords here.';
        }

        submitButton.disabled = !method.enabled;
        submitLabel.textContent = method.enabled ? buttonLabel(method) : `${method.name} setup required`;
        updateAmountSummary();
    }

    function onMethodChange(event) {
        const next = methods.get(event.target.value);
        if (!next) return;
        updateAmountControls(next);
        setMethodDetails(next);
        message.textContent = '';
        message.className = 'form-message';
    }

    async function loadPaymentMethods() {
        try {
            const response = await fetch('/api/payment-methods', {
                headers: { Accept: 'application/json' },
                credentials: 'same-origin'
            });
            if (!response.headers.get('content-type')?.includes('application/json')) {
                throw new Error('Online payment options are unavailable. You can still donate by bank transfer.');
            }
            const result = await response.json();
            if (!response.ok || !Array.isArray(result.methods)) {
                throw new Error(result.error || 'Payment methods could not be loaded.');
            }

            methods = new Map(result.methods.map((method) => [method.id, method]));
            paymentOptions.forEach((input) => {
                const method = methods.get(input.value);
                if (!method) {
                    input.disabled = true;
                    return;
                }
                input.disabled = !method.enabled;
                input.closest('.payment-option').querySelector('.method-state').textContent =
                    method.enabled ? 'Available' : 'Setup required';
            });

            const preferred = paymentOptions.find((input) => input.value === 'mpesa' && !input.disabled)
                || paymentOptions.find((input) => input.value === 'card' && !input.disabled)
                || paymentOptions.find((input) => !input.disabled);
            if (preferred) {
                preferred.checked = true;
                updateAmountControls(methods.get(preferred.value));
                setMethodDetails(methods.get(preferred.value));
            }
        } catch (error) {
            paymentOptions.forEach((input) => {
                if (input.value !== 'bank') input.disabled = true;
                input.closest('.payment-option').querySelector('.method-state').textContent =
                    input.value === 'bank' ? 'Available' : 'Unavailable';
            });
            const bank = paymentOptions.find((input) => input.value === 'bank');
            if (bank) {
                bank.checked = true;
                const fallback = {
                    id: 'bank',
                    name: 'Bank transfer',
                    currency: 'KES',
                    enabled: true
                };
                methods.set('bank', fallback);
                updateAmountControls(fallback);
                setMethodDetails(fallback);
            }
            showMessage(
                error.message || 'Online payment options are unavailable. You can still donate by bank transfer.',
                'pending'
            );
        }
    }

    function delay(milliseconds) {
        return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    }

    function createBankTransferReference() {
        const bytes = new Uint8Array(6);
        window.crypto.getRandomValues(bytes);
        return `BANK-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    }

    async function fetchPaymentStatus(reference) {
        const response = await fetch(`/api/payments/status?${new URLSearchParams({ reference })}`, {
            headers: { Accept: 'application/json' },
            credentials: 'same-origin'
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Payment status could not be checked.');
        return result.status;
    }

    async function capturePaypal(reference, orderId) {
        const response = await fetch('/api/payments/paypal/capture', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            credentials: 'same-origin',
            body: JSON.stringify({ reference, orderId })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'PayPal could not confirm the payment.');
        return result.status;
    }

    async function verifyReturnedPayment(reference, gateway, params) {
        try {
            if (params.get('status') && ['cancelled', 'canceled'].includes(params.get('status').toLowerCase())) {
                showMessage('Checkout was cancelled. No donation has been confirmed.', 'error');
                window.history.replaceState({}, document.title, window.location.pathname);
                return;
            }
            if (gateway === 'paypal') {
                const orderId = params.get('token');
                if (!orderId) throw new Error('PayPal did not return an order ID.');
                const status = await capturePaypal(reference, orderId);
                if (status === 'paid') {
                    showPaymentSuccess();
                    return;
                }
            } else {
                const status = await pollStatus(reference, 8);
                if (status === 'paid') {
                    showPaymentSuccess();
                    return;
                }
                if (status === 'failed') {
                    showMessage('The payment was not completed. No donation has been confirmed.', 'error');
                    window.history.replaceState({}, document.title, window.location.pathname);
                    return;
                }
                showMessage(
                    'Payment is still awaiting provider confirmation. It is not marked paid yet.',
                    'pending',
                    'Check again',
                    () => verifyReturnedPayment(reference, gateway, params)
                );
                return;
            }
            showMessage(
                'Payment is still awaiting provider confirmation. It is not marked paid yet.',
                'pending',
                'Check again',
                () => verifyReturnedPayment(reference, gateway, params)
            );
        } catch (error) {
            showMessage(
                error.message || 'We could not verify this payment. Please retry.',
                'error',
                'Retry verification',
                () => verifyReturnedPayment(reference, gateway, params)
            );
        }
    }

    async function pollStatus(reference, attemptsRemaining) {
        const status = await fetchPaymentStatus(reference);
        if (status !== 'pending' || attemptsRemaining === 0) return status;
        await delay(3000);
        return pollStatus(reference, attemptsRemaining - 1);
    }

    function showPaymentSuccess() {
        showMessage('Payment confirmed. Thank you for supporting families in need!', 'success');
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    function handleCheckoutReturn() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('payment') !== 'return' && params.get('payment') !== 'cancelled') return;
        const reference = params.get('reference');
        const gateway = params.get('gateway');
        if (params.get('payment') === 'cancelled') {
            showMessage('Checkout was cancelled. No donation has been confirmed.', 'error');
            window.history.replaceState({}, document.title, window.location.pathname);
            return;
        }
        if (!reference || !/^D-[A-F0-9]{24}$/.test(reference) || !gateway) {
            showMessage('The payment return details are invalid. Please contact the charity team before donating again.', 'error');
            return;
        }
        showMessage('Checking payment securely with the provider…', 'pending');
        verifyReturnedPayment(reference, gateway, params);
    }

    paymentOptions.forEach((input) => input.addEventListener('change', onMethodChange));
    presets.forEach((preset) => {
        preset.addEventListener('click', () => {
            amountInput.value = preset.dataset.amount;
            const method = selectedMethod();
            if (method) amountByCurrency[method.currency] = amountInput.value;
            updateAmountSummary();
        });
    });
    amountInput.addEventListener('input', () => {
        const method = selectedMethod();
        if (method) amountByCurrency[method.currency] = amountInput.value;
        updateAmountSummary();
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        message.textContent = '';
        message.className = 'form-message';
        transferInstructions.hidden = true;
        if (!form.reportValidity()) return;

        const method = selectedMethod();
        if (!method || !method.enabled) {
            showMessage('Choose an available payment method.', 'error');
            return;
        }

        const amount = Number(amountInput.value);
        const validAmount = method.currency === 'KES'
            ? Number.isSafeInteger(amount) && amount >= 10 && amount <= 10000000
            : Number.isFinite(amount) && amount >= 1 && amount <= 10000
                && Math.round(amount * 100) === amount * 100;
        if (!validAmount) {
            showMessage(`Enter a valid donation amount in ${method.currency}.`, 'error');
            amountInput.focus();
            return;
        }

        if (method.id === 'bank') {
            const reference = createBankTransferReference();
            document.getElementById('transferAmount').textContent = formatAmount(amount, 'KES');
            document.getElementById('transferReference').textContent = reference;
            transferInstructions.hidden = false;
            showMessage('Bank details are ready. Include the reference in your transfer narration; the charity team will confirm your donation after checking the deposit.', 'pending');
            transferInstructions.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            return;
        }

        const body = {
            method: method.id,
            amount,
            name: document.getElementById('donorName').value.trim(),
            email: document.getElementById('email').value.trim()
        };
        if (method.id === 'mpesa') body.phone = phoneInput.value.trim();

        setBusy(true, 'Connecting to secure checkout…');
        try {
            const response = await fetch('/api/payments', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                credentials: 'same-origin',
                body: JSON.stringify(body)
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'The payment request could not be completed.');

            if (method.id === 'mpesa') {
                showMessage('M-Pesa request sent. Check your phone and approve the Safaricom prompt to complete your donation.', 'pending');
                await verifyReturnedPayment(result.reference, 'mpesa', new URLSearchParams());
                return;
            }

            const checkoutUrl = new URL(result.checkoutUrl);
            const trustedHosts = {
                card: ['pesapal.com'],
                paypal: ['paypal.com'],
                binance: ['binance.com'],
                bitcoin: ['nowpayments.io']
            }[method.id] || [];
            if (checkoutUrl.protocol !== 'https:' || !trustedHosts.some((host) => (
                checkoutUrl.hostname === host || checkoutUrl.hostname.endsWith(`.${host}`)
            ))) {
                throw new Error('The secure checkout link could not be validated.');
            }
            window.location.assign(checkoutUrl.toString());
        } catch (error) {
            showMessage(error.message || 'The payment request could not be completed. Please try again.', 'error');
        } finally {
            setBusy(false);
        }
    });

    loadPaymentMethods();
    handleCheckoutReturn();
}());
