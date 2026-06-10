/**
 * Set DB status=Cancelled for active-member invoices still Unpaid in DB but Cancelled on PayPal.
 * Also reverts Paid→Cancelled when PayPal says cancelled (manual mark correction).
 * Usage: node scripts/sync_cancelled_from_paypal.js [--apply] [invoice_numbers...]
 */
require('dotenv').config();
const { getDb } = require('../netlify/functions/db');
const { loadLocalEnv, paypalApiBase } = require('../netlify/functions/paypal-env');

loadLocalEnv();
const APPLY = process.argv.includes('--apply');
const nums = process.argv.slice(2).filter((a) => a !== '--apply').map(Number).filter(Boolean);

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
  let rows;
  if (nums.length) {
    const r = await db.query(
      `SELECT invoice_number, status, paid_note, paypal_invoice_id, recipient_name
       FROM invoices WHERE invoice_number = ANY($1::int[])`,
      [nums]
    );
    rows = r.rows;
  } else {
    const r = await db.query(`
      SELECT i.invoice_number, i.status, i.paid_note, i.paypal_invoice_id, i.recipient_name
      FROM invoices i
      LEFT JOIN members m ON i.member_id = m.id
      WHERE i.paypal_invoice_id IS NOT NULL
        AND LOWER(COALESCE(m.status, '')) = 'active'
        AND LOWER(COALESCE(i.status, '')) IN ('unpaid', 'paid')
      ORDER BY i.updated_at DESC
      LIMIT 200
    `);
    rows = r.rows;
  }

  const token = await getAccessToken();
  const toCancel = [];

  for (const row of rows) {
    const detail = await fetchPaypalDetail(token, row.paypal_invoice_id);
    const paypalStatus = mapPaypalStatus(detail.status);
    if (paypalStatus !== 'Cancelled') continue;
    if (String(row.status).toLowerCase() === 'cancelled') continue;
    toCancel.push({ ...row, paypalRaw: detail.status });
    console.log(`#${row.invoice_number} ${row.recipient_name}: DB=${row.status} PayPal=${detail.status} → Cancelled`);
  }

  if (!toCancel.length) {
    console.log('No invoices need Cancelled correction.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\nDry run: ${toCancel.length} invoice(s). Re-run with --apply to fix.`);
    process.exit(0);
  }

  for (const row of toCancel) {
    await db.query(
      `UPDATE invoices SET status = 'Cancelled', paid_note = NULL, paid_date = NULL, updated_at = NOW()
       WHERE invoice_number = $1`,
      [row.invoice_number]
    );
    await db.query(
      `INSERT INTO audit_log (actor_type, actor_label, action, table_name, entity_type, summary, new_value)
       VALUES ('system', 'PayPal verify', 'invoice.corrected', 'invoices', 'invoices', $1, $2)`,
      [
        `Invoice #${row.invoice_number}: ${row.status} → Cancelled (PayPal: ${row.paypalRaw}; member cancelled)`,
        JSON.stringify({ invoice_number: row.invoice_number, status: 'Cancelled', prior_status: row.status }),
      ]
    );
  }
  console.log(`Updated ${toCancel.length} invoice(s) to Cancelled.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
