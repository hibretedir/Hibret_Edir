const {
  getPayPalAccessToken,
  fetchPayPalInvoiceDetail,
  recordPayPalInvoicePayment,
  isPayPalInvoiceClosedStatus,
} = require('./paypal-client');

function mapToPayPalPaymentMethod(method) {
  const m = String(method || '').trim().toLowerCase();
  if (m.includes('zelle') || m.includes('bofa') || m.includes('bank') || m.includes('deposit')) {
    return 'BANK_TRANSFER';
  }
  if (m.includes('check')) return 'CHECK';
  if (m.includes('cash')) return 'CASH';
  if (m.includes('wire')) return 'WIRE_TRANSFER';
  return 'OTHER';
}

function invoiceAmountValue(row) {
  const due = Number(row.amount_due);
  if (Number.isFinite(due) && due > 0) return due.toFixed(2);
  const amt = Number(row.amount);
  if (Number.isFinite(amt) && amt > 0) return amt.toFixed(2);
  return '110.00';
}

/** Structured note stored on PayPal payment record — survives if Hibret DB is lost. */
function buildPayPalPaymentTrailNote(row, options = {}) {
  const parts = ['Hibret Edir board record'];
  if (row.invoice_number != null) parts.push(`Invoice #${row.invoice_number}`);
  if (row.paypal_invoice_id) {
    parts.push(`PayPal ID ${String(row.paypal_invoice_id).slice(0, 24)}`);
  }
  const method = options.paymentMethod || row.payment_method;
  if (method) parts.push(String(method));
  if (options.source) parts.push(String(options.source));
  if (options.approvedBy) parts.push(`Approved by ${options.approvedBy}`);
  const when = options.approvedAt || new Date().toISOString().slice(0, 16).replace('T', ' ');
  parts.push(when);
  const detail = String(options.note || row.paid_note || '').trim();
  const header = parts.join(' · ');
  if (!detail) return header.slice(0, 2000);
  const combined = `${header}\n${detail}`;
  return combined.slice(0, 2000);
}

/**
 * Record an offline payment on PayPal for a Hibret invoice (Zelle/BofA / board mark-paid).
 * Safe to call when PayPal is already paid — returns skipped.
 */
async function recordPayPalPaymentForInvoiceRow(row, options = {}) {
  const paypalId = row.paypal_invoice_id || row.paypal_id;
  if (!paypalId) {
    return { ok: false, skipped: true, reason: 'no_paypal_id' };
  }
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_SECRET) {
    return { ok: false, skipped: true, reason: 'paypal_not_configured' };
  }

  const token = await getPayPalAccessToken();
  const detail = await fetchPayPalInvoiceDetail(token, paypalId);
  if (isPayPalInvoiceClosedStatus(detail.status)) {
    return {
      ok: true,
      skipped: true,
      reason: 'already_closed_on_paypal',
      paypal_status: detail.status,
    };
  }

  const note = buildPayPalPaymentTrailNote(row, options);
  const paymentDate = options.paymentDate || new Date().toISOString().slice(0, 10);
  const payload = {
    method: mapToPayPalPaymentMethod(options.paymentMethod || row.payment_method),
    payment_date: paymentDate,
    amount: {
      currency_code: 'USD',
      value: invoiceAmountValue(row),
    },
  };
  if (note) payload.note = note;

  const payment = await recordPayPalInvoicePayment(token, paypalId, payload);
  return {
    ok: true,
    paypal_invoice_id: paypalId,
    paypal_status: payment?.status || detail.status,
    payment_id: payment?.payment_id || null,
  };
}

async function recordPayPalPaymentForInvoice(db, lookup, options = {}) {
  const values = [];
  let sql;
  if (lookup.invoiceId != null) {
    sql = `SELECT id, invoice_number, paypal_invoice_id, status, amount, amount_due, payment_method, paid_note
           FROM invoices WHERE id = $1 LIMIT 1`;
    values.push(lookup.invoiceId);
  } else if (lookup.invoiceNum != null) {
    sql = `SELECT id, invoice_number, paypal_invoice_id, status, amount, amount_due, payment_method, paid_note
           FROM invoices WHERE invoice_number = $1 LIMIT 1`;
    values.push(lookup.invoiceNum);
  } else {
    throw new Error('invoiceId or invoiceNum required for PayPal payment');
  }

  const result = await db.query(sql, values);
  const row = result.rows[0];
  if (!row) {
    return { ok: false, skipped: true, reason: 'invoice_not_found' };
  }
  return recordPayPalPaymentForInvoiceRow(row, options);
}

module.exports = {
  mapToPayPalPaymentMethod,
  buildPayPalPaymentTrailNote,
  recordPayPalPaymentForInvoice,
  recordPayPalPaymentForInvoiceRow,
};
