/**
 * Find invoices marked Paid in DB but Cancelled on PayPal; revert to Cancelled.
 * Usage: node scripts/fix_cancelled_marked_paid.js [--apply]
 */
require('dotenv').config();
const { getDb } = require('../netlify/functions/db');
const { loadLocalEnv, paypalApiBase } = require('../netlify/functions/paypal-env');

loadLocalEnv();
const APPLY = process.argv.includes('--apply');

async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  const authResponse = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const authData = await authResponse.json();
  if (!authData.access_token) throw new Error(authData.error_description || 'PayPal auth failed');
  return authData.access_token;
}

function mapPaypalStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'PAID' || s === 'MARKED_AS_PAID' || s === 'PARTIALLY_PAID') return 'Paid';
  if (s.startsWith('CANCEL') || s === 'REFUNDED' || s === 'REFUND') return 'Cancelled';
  return 'Unpaid';
}

async function fetchPaypalDetail(token, paypalId) {
  const res = await fetch(`${paypalApiBase()}/v2/invoicing/invoices/${encodeURIComponent(paypalId)}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `PayPal detail failed for ${paypalId}`);
  return data;
}

async function main() {
  const db = getDb();
  const r = await db.query(`
    SELECT invoice_number, status, paid_note, paid_date, paypal_invoice_id, recipient_name, updated_at
    FROM invoices
    WHERE LOWER(COALESCE(status, '')) = 'paid'
      AND paypal_invoice_id IS NOT NULL
      AND (
        paid_note IS NOT NULL
        OR updated_at > NOW() - INTERVAL '3 days'
      )
    ORDER BY updated_at DESC
  `);

  if (!r.rows.length) {
    console.log('No candidate invoices to verify.');
    process.exit(0);
  }

  const token = await getAccessToken();
  const toFix = [];

  for (const row of r.rows) {
    const detail = await fetchPaypalDetail(token, row.paypal_invoice_id);
    const paypalStatus = mapPaypalStatus(detail.status);
    const paypalRaw = detail.status;
    console.log(`#${row.invoice_number} ${row.recipient_name}: DB=${row.status} PayPal=${paypalRaw} paid_note=${row.paid_note || '(none)'}`);
    if (paypalStatus === 'Cancelled' && row.status === 'Paid') {
      toFix.push({ ...row, paypalRaw });
    }
  }

  if (!toFix.length) {
    console.log('\nNo mismatches — none of the checked invoices are cancelled on PayPal.');
    process.exit(0);
  }

  console.log(`\n=== ${toFix.length} invoice(s) marked Paid in DB but Cancelled on PayPal ===`);
  for (const row of toFix) {
    console.log(`  #${row.invoice_number} ${row.recipient_name} (PayPal: ${row.paypalRaw})`);
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to set status=Cancelled and clear paid_note/paid_date.');
    process.exit(0);
  }

  for (const row of toFix) {
    await db.query(
      `UPDATE invoices
       SET status = 'Cancelled', paid_note = NULL, paid_date = NULL, updated_at = NOW()
       WHERE invoice_number = $1`,
      [row.invoice_number]
    );
    await db.query(
      `INSERT INTO audit_log (actor_type, actor_label, action, table_name, entity_type, record_id, summary, new_value)
       VALUES ('system', 'PayPal verify', 'invoice.corrected', 'invoices', 'invoices', NULL, $1, $2)`,
      [
        `Invoice #${row.invoice_number}: reverted Paid → Cancelled (PayPal status: ${row.paypalRaw}; manual mark removed)`,
        JSON.stringify({ invoice_number: row.invoice_number, status: 'Cancelled', reason: 'paypal_cancelled' }),
      ]
    );
    console.log(`  Fixed #${row.invoice_number}`);
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
