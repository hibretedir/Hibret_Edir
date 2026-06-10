/**
 * Find invoices marked Paid in DB but Cancelled on PayPal.
 * Usage: node scripts/find_paid_cancelled_mismatch.js [--apply]
 */
require('dotenv').config();
const { getDb } = require('../netlify/functions/db');
const { loadLocalEnv, paypalApiBase } = require('../netlify/functions/paypal-env');

loadLocalEnv();
const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 8;

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
    SELECT invoice_number, status, paid_note, paypal_invoice_id, recipient_name
    FROM invoices
    WHERE LOWER(COALESCE(status, '')) = 'paid'
      AND paypal_invoice_id IS NOT NULL
    ORDER BY invoice_number
  `);

  console.log(`Checking ${r.rows.length} Paid invoices against PayPal...`);
  const token = await getAccessToken();
  const mismatches = [];

  for (let i = 0; i < r.rows.length; i += CONCURRENCY) {
    const batch = r.rows.slice(i, i + CONCURRENCY);
    const details = await Promise.all(
      batch.map(async (row) => {
        const detail = await fetchPaypalDetail(token, row.paypal_invoice_id);
        const paypalStatus = mapPaypalStatus(detail.status);
        return { row, paypalRaw: detail.status, paypalStatus };
      })
    );
    for (const { row, paypalRaw, paypalStatus } of details) {
      if (paypalStatus === 'Cancelled') {
        mismatches.push({ ...row, paypalRaw, paypalStatus });
        console.log(`MISMATCH #${row.invoice_number} ${row.recipient_name}: DB=Paid PayPal=${paypalRaw} paid_note=${row.paid_note || '(none)'}`);
      }
    }
    if ((i + CONCURRENCY) % 80 === 0) console.log(`  ...checked ${Math.min(i + CONCURRENCY, r.rows.length)}/${r.rows.length}`);
  }

  if (!mismatches.length) {
    console.log('\nNo Paid-in-DB / Cancelled-on-PayPal mismatches found.');
    process.exit(0);
  }

  console.log(`\nFound ${mismatches.length} to fix.`);

  if (!APPLY) {
    console.log('Dry run. Re-run with --apply to set Cancelled and clear paid fields.');
    process.exit(0);
  }

  for (const row of mismatches) {
    await db.query(
      `UPDATE invoices SET status = 'Cancelled', paid_note = NULL, paid_date = NULL, updated_at = NOW()
       WHERE invoice_number = $1`,
      [row.invoice_number]
    );
    await db.query(
      `INSERT INTO audit_log (actor_type, actor_label, action, table_name, entity_type, summary, new_value)
       VALUES ('system', 'PayPal verify', 'invoice.corrected', 'invoices', 'invoices', $1, $2)`,
      [
        `Invoice #${row.invoice_number}: reverted Paid → Cancelled (PayPal: ${row.paypalRaw})`,
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
