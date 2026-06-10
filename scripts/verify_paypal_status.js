/**
 * Compare DB invoice status vs PayPal for specific invoice numbers or recent manual marks.
 * Usage: node scripts/verify_paypal_status.js 978 1036
 */
require('dotenv').config();
const { getDb } = require('../netlify/functions/db');
const { loadLocalEnv, paypalApiBase } = require('../netlify/functions/paypal-env');

loadLocalEnv();

async function getAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  if (!clientId || !secret) throw new Error('PayPal credentials missing');
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
  const nums = process.argv.slice(2).map(Number).filter(Boolean);
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
      SELECT invoice_number, status, paid_note, paypal_invoice_id, recipient_name
      FROM invoices
      WHERE (paid_note IS NOT NULL AND TRIM(paid_note) <> '')
         OR (LOWER(status) = 'paid' AND updated_at > NOW() - INTERVAL '2 days')
      ORDER BY updated_at DESC
      LIMIT 30
    `);
    rows = r.rows;
  }

  if (!rows.length) {
    console.log('No matching invoices.');
    process.exit(0);
  }

  const token = await getAccessToken();
  const mismatches = [];

  for (const row of rows) {
    if (!row.paypal_invoice_id) {
      console.log(`#${row.invoice_number} ${row.recipient_name}: no PayPal ID`);
      continue;
    }
    const detail = await fetchPaypalDetail(token, row.paypal_invoice_id);
    const paypalRaw = detail.status || detail.detail?.invoice_number;
    const paypalStatus = mapPaypalStatus(detail.status);
    const dbStatus = row.status;
    const match = String(dbStatus).toLowerCase() === paypalStatus.toLowerCase()
      || (dbStatus === 'Paid' && paypalStatus === 'Paid');
    const line = {
      invoice_number: row.invoice_number,
      name: row.recipient_name,
      db_status: dbStatus,
      paypal_raw: detail.status,
      paypal_mapped: paypalStatus,
      paid_note: row.paid_note,
      match,
    };
    console.log(JSON.stringify(line));
    if (!match || (dbStatus === 'Paid' && paypalStatus === 'Cancelled')) {
      mismatches.push({ ...row, paypalRaw: detail.status, paypalStatus });
    }
  }

  if (mismatches.length) {
    console.log('\n=== MISMATCHES (DB should be corrected) ===');
    for (const m of mismatches) {
      console.log(`#${m.invoice_number}: DB=${m.status} PayPal=${m.paypalRaw} → should be ${m.paypalStatus}`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
