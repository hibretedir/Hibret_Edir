/**
 * Create and send PayPal registration fee invoice for a membership application.
 */

const { paypalApiBase, loadLocalEnv } = require('./paypal-env');
const { getPayPalAccessToken, fetchPayPalInvoiceDetail } = require('./paypal-client');
const { REGISTRATION_FEE } = require('./membership-completion');

loadLocalEnv();

const LINE_ITEM_NAME = 'Hibret Edir — Membership Registration Fee';

function extractPayPalInvoiceId(response, data) {
  if (data?.id) return data.id;
  const location = response.headers.get('location') || response.headers.get('Location');
  if (location) {
    const fromLocation = String(location).match(/\/invoices\/([^/?#]+)/i);
    if (fromLocation) return fromLocation[1];
  }
  const href = data?.href
    || (Array.isArray(data?.links) ? data.links.find((link) => link.rel === 'self')?.href : null);
  if (href) {
    const fromHref = String(href).match(/\/invoices\/([^/?#]+)/i);
    if (fromHref) return fromHref[1];
  }
  return null;
}

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

function formatPayPalError(data, fallback) {
  const detail = Array.isArray(data.details) ? data.details[0] : null;
  const msg = detail?.description || data.message || fallback;
  const err = new Error(msg);
  if (detail?.issue) err.paypalIssue = detail.issue;
  return err;
}

async function findExistingRegistrationInvoice(token, applicationId) {
  const ref = registrationInvoiceReference(applicationId);
  let url = `${paypalApiBase()}/v2/invoicing/invoices?page_size=100&total_count_required=true`;
  for (let page = 0; page < 10; page += 1) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) break;
    const match = (data.items || []).find((item) => item.detail?.invoice_number === ref);
    if (match?.id) return fetchPayPalInvoiceDetail(token, match.id);
    const next = (data.links || []).find((link) => link.rel === 'next');
    if (!next?.href) break;
    url = next.href;
  }
  return null;
}

function mapPayPalInvoiceStatus(paypalStatus) {
  const s = String(paypalStatus || '').toUpperCase();
  if (s === 'PAID' || s === 'MARKED_AS_PAID') return 'Paid';
  return 'Unpaid';
}

function shouldSendPayPalInvoice(paypalStatus) {
  return String(paypalStatus || '').toUpperCase() === 'DRAFT';
}

async function createPayPalDraftInvoice(token, { recipientEmail, recipientName, applicationId, note }) {
  const name = splitRecipientName(recipientName);
  const invoiceDate = new Date().toISOString().slice(0, 10);
  const payload = {
    detail: {
      invoice_number: registrationInvoiceReference(applicationId),
      invoice_date: invoiceDate,
      currency_code: 'USD',
      note: note || `One-time Hibret Edir membership registration fee ($${REGISTRATION_FEE.toFixed(2)}). Payment activates your membership.`,
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
    throw formatPayPalError(data, 'PayPal invoice create failed');
  }
  const invoiceId = extractPayPalInvoiceId(res, data);
  if (!invoiceId) {
    throw new Error('PayPal did not return an invoice id.');
  }
  if (data.id && data.links) return data;
  return fetchPayPalInvoiceDetail(token, invoiceId);
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
    throw formatPayPalError(data, 'PayPal invoice send failed');
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
  let draft = await findExistingRegistrationInvoice(token, appRow.id);
  if (!draft) {
    try {
      draft = await createPayPalDraftInvoice(token, {
        recipientEmail,
        recipientName: appRow.member_full_name || appRow.wl_full_name,
        applicationId: appRow.id,
      });
    } catch (err) {
      if (err.paypalIssue === 'DUPLICATE_INVOICE_NUMBER') {
        draft = await findExistingRegistrationInvoice(token, appRow.id);
      }
      if (!draft) throw err;
    }
  }
  const paypalInvoiceId = draft.id;
  if (!paypalInvoiceId) {
    throw new Error('PayPal did not return an invoice id.');
  }

  if (shouldSendPayPalInvoice(draft.status)) {
    await sendPayPalInvoice(token, paypalInvoiceId);
    draft = await fetchPayPalInvoiceDetail(token, paypalInvoiceId);
  }

  const payerView = (draft.links || []).find((link) => link.rel === 'payer-view')?.href;
  const paypalLink = payerView || `https://www.paypal.com/invoice/p/#${paypalInvoiceId}`;

  return {
    ok: true,
    paypal_invoice_id: paypalInvoiceId,
    paypal_reference: registrationInvoiceReference(appRow.id),
    invoice_number: null,
    paypal_link: paypalLink,
    recipient_name: appRow.member_full_name || appRow.wl_full_name,
    recipient_email: recipientEmail,
    amount: REGISTRATION_FEE,
    status: mapPayPalInvoiceStatus(draft.status),
    sent_date: new Date().toISOString().slice(0, 10),
    reused_existing: draft.status !== 'DRAFT',
  };
}

module.exports = {
  createAndSendRegistrationInvoice,
  registrationInvoiceReference,
  LINE_ITEM_NAME,
};
