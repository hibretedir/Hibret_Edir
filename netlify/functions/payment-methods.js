/** Classify invoice payment_method values for stats and PayPal sync. */

function isZelleBofaPaymentMethod(method) {
  const m = String(method || '').trim().toLowerCase();
  if (!m) return false;
  if (m === 'zelle' || m === 'bofa' || m === 'zelle & bofa') return true;
  if (m.includes('zelle')) return true;
  if (m.includes('bofa')) return true;
  if (m.includes('bank of america')) return true;
  if (m.includes('direct deposit')) return true;
  return false;
}

function paymentMethodFromPaypalStatus(rawStatus) {
  const s = String(rawStatus || '').toUpperCase();
  if (s === 'MARKED_AS_PAID') return 'Zelle & BofA';
  if (s === 'PAID' || s === 'PARTIALLY_PAID') return 'PayPal';
  return null;
}

/** Invoice still owes money (unpaid or partially paid). */
const OUTSTANDING_INVOICE_SQL = `LOWER(TRIM(COALESCE(invoices.status, ''))) IN ('unpaid', 'partially paid')`;

function outstandingInvoiceSql(column = 'invoices.status') {
  return `LOWER(TRIM(COALESCE(${column}, ''))) IN ('unpaid', 'partially paid')`;
}

function unpaidOnlyInvoiceSql(column = 'invoices.status') {
  return `LOWER(TRIM(COALESCE(${column}, ''))) = 'unpaid'`;
}

function partialOnlyInvoiceSql(column = 'invoices.status') {
  return `LOWER(TRIM(COALESCE(${column}, ''))) = 'partially paid'`;
}

/** SQL fragment: invoices.payment_method is Zelle or BofA direct deposit. */
const ZELLE_BOFA_SQL = `(
  LOWER(COALESCE(invoices.payment_method, '')) IN ('zelle', 'bofa', 'zelle & bofa', 'bank of america', 'direct deposit')
  OR LOWER(COALESCE(invoices.payment_method, '')) LIKE '%zelle%'
  OR LOWER(COALESCE(invoices.payment_method, '')) LIKE '%bofa%'
  OR LOWER(COALESCE(invoices.payment_method, '')) LIKE '%bank%'
)`;

/** Do not let PayPal sync downgrade board-approved / pending local payment state. */
const SYNC_PROTECT_LOCAL_PAID_SQL = `(
  EXISTS (
    SELECT 1 FROM invoice_mark_paid_requests r
    WHERE r.invoice_id = invoices.id AND r.status = 'Pending'
  )
  OR (
    LOWER(TRIM(COALESCE(invoices.status, ''))) = 'paid'
    AND (
      NULLIF(TRIM(COALESCE(invoices.paid_note, '')), '') IS NOT NULL
      OR ${ZELLE_BOFA_SQL}
    )
  )
)`;

module.exports = {
  isZelleBofaPaymentMethod,
  paymentMethodFromPaypalStatus,
  OUTSTANDING_INVOICE_SQL,
  outstandingInvoiceSql,
  unpaidOnlyInvoiceSql,
  partialOnlyInvoiceSql,
  ZELLE_BOFA_SQL,
  SYNC_PROTECT_LOCAL_PAID_SQL,
};
