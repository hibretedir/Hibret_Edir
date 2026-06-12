/**
 * Create and send PayPal registration fee invoice for a membership application.
 */

const { paypalApiBase, loadLocalEnv } = require('./paypal-env');
const { getPayPalAccessToken } = require('./paypal-client');
const { REGISTRATION_FEE } = require('./membership-completion');

loadLocalEnv();

const LINE_ITEM_NAME = 'Hibret Edir — Membership Registration Fee';

function splitRecipientName(fullName) {
  const text = String(fullName || '').trim();
  if (!text) return { given_name: 'Member', surname: 'Applicant' };
  const parts = text.split(/\s+/);
  if (parts.length === 1) return { given_name: parts[0], surname: parts[0] };
  return { given_name: parts[0], surname: parts.slice(1).join(' ') };
}

function registrationInvoiceReference(applicationId) {
  return `REG-${applicationId}`;
}

async function createPayPalDraftInvoice(token, { recipientEmail, recipientName, applicationId, note }) {
  const name = splitRecipientName(recipientName);
  const invoiceDate = new Date().toISOString().slice(0, 10);
  const payload = {
    detail: {
      invoice_number: registrationInvoiceReference(applicationId),
      invoice_date: invoiceDate,
      currency_code: 'USD',
      note: note || 'One-time Hibret Edir membership registration fee ($200). Payment activates your membership.',
      payment_term: { term_type: 'DUE_ON_RECEIPT' },
    },
    primary_recipients: [
      {
        billing_info: {
          name: {
            given_name: name.given_name,
            surname: name.surname,
          },
          email_address: recipientEmail,
        },
      },
    ],
    items: [
      {
        name: LINE_ITEM_NAME,
        description: `Membership application #${applicationId}`,
        quantity: '1',
        unit_amount: {
          currency_code: 'USD',
          value: REGISTRATION_FEE.toFixed(2),
        },
        unit_of_measure: 'QUANTITY',
      },
    ],
  };

  const res = await fetch(`${paypalApiBase()}/v2/invoicing/invoices`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.details?.[0]?.description || 'PayPal invoice create failed';
    throw new Error(msg);
  }
  return data;
}

async function sendPayPalInvoice(token, invoiceId) {
  const res = await fetch(`${paypalApiBase()}/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      send_to_recipient: true,
      send_to_invoicer: false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.details?.[0]?.description || 'PayPal invoice send failed';
    throw new Error(msg);
  }
  return data;
}

/**
 * @param {{ id, member_full_name, email, wl_email }} appRow
 */
async function createAndSendRegistrationInvoice(appRow) {
  const recipientEmail = String(appRow.email || appRow.wl_email || '').trim().toLowerCase();
  if (!recipientEmail) {
    throw new Error('Applicant email is required to send a PayPal registration invoice.');
  }

  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_SECRET) {
    return {
      ok: false,
      skipped: true,
      reason: 'paypal_not_configured',
      recipient_email: recipientEmail,
      amount: REGISTRATION_FEE,
    };
  }

  const token = await getPayPalAccessToken();
  const draft = await createPayPalDraftInvoice(token, {
    recipientEmail,
    recipientName: appRow.member_full_name || appRow.wl_full_name,
    applicationId: appRow.id,
  });
  const paypalInvoiceId = draft.id;
  if (!paypalInvoiceId) {
    throw new Error('PayPal did not return an invoice id.');
  }

  await sendPayPalInvoice(token, paypalInvoiceId);

  const payerView = (draft.links || []).find((link) => link.rel === 'payer-view')?.href;
  const paypalLink = payerView || `https://www.paypal.com/invoice/p/#${paypalInvoiceId}`;
  const invoiceNumber = draft.detail?.invoice_number
    ? Number(String(draft.detail.invoice_number).replace(/\D/g, '')) || null
    : null;

  return {
    ok: true,
    paypal_invoice_id: paypalInvoiceId,
    invoice_number: invoiceNumber,
    paypal_link: paypalLink,
    recipient_name: appRow.member_full_name || appRow.wl_full_name,
    recipient_email: recipientEmail,
    amount: REGISTRATION_FEE,
    status: 'Unpaid',
    sent_date: new Date().toISOString().slice(0, 10),
  };
}

module.exports = {
  createAndSendRegistrationInvoice,
  registrationInvoiceReference,
  LINE_ITEM_NAME,
};
