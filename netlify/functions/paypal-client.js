const { loadLocalEnv, paypalApiBase } = require('./paypal-env');

loadLocalEnv();

async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  if (!clientId || !secret) {
    throw new Error('PayPal credentials not configured. Add PAYPAL_CLIENT_ID and PAYPAL_SECRET to .env');
  }

  const authResponse = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const authData = await authResponse.json();
  if (!authData.access_token) {
    throw new Error(authData.error_description || authData.error || 'PayPal authentication failed');
  }
  return authData.access_token;
}

async function fetchPayPalInvoiceDetail(accessToken, invoiceId) {
  const res = await fetch(
    `${paypalApiBase()}/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error || `PayPal invoice detail failed for ${invoiceId}`);
  }
  return data;
}

async function recordPayPalInvoicePayment(accessToken, invoiceId, payload) {
  const res = await fetch(
    `${paypalApiBase()}/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/payments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.details?.[0];
    const msg = detail?.description || data.message || data.error || 'PayPal record payment failed';
    throw new Error(msg);
  }
  return data;
}

function isPayPalInvoiceClosedStatus(status) {
  const s = String(status || '').toUpperCase();
  return s === 'PAID' || s === 'MARKED_AS_PAID' || s === 'PARTIALLY_PAID'
    || s.startsWith('CANCEL') || s === 'REFUNDED' || s === 'REFUND';
}

module.exports = {
  getPayPalAccessToken,
  fetchPayPalInvoiceDetail,
  recordPayPalInvoicePayment,
  isPayPalInvoiceClosedStatus,
};
