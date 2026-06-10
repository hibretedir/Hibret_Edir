require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

async function main() {
  const db = getDb();
  const withNote = await db.query(`
    SELECT invoice_number, status, paid_note, paid_date, recipient_name, paypal_invoice_id, updated_at
    FROM invoices
    WHERE paid_note IS NOT NULL AND TRIM(paid_note) <> ''
    ORDER BY updated_at DESC
    LIMIT 20
  `);
  console.log('=== Invoices with paid_note (manual mark paid) ===');
  console.log(JSON.stringify(withNote.rows, null, 2));

  const recentPaid = await db.query(`
    SELECT invoice_number, status, paid_note, paid_date, recipient_name, paypal_invoice_id, updated_at
    FROM invoices
    WHERE LOWER(COALESCE(status, '')) = 'paid'
      AND updated_at > NOW() - INTERVAL '7 days'
    ORDER BY updated_at DESC
    LIMIT 20
  `);
  console.log('\n=== Recently updated to Paid (7 days) ===');
  console.log(JSON.stringify(recentPaid.rows, null, 2));

  const audit = await db.query(`
    SELECT id, summary, new_value, created_at
    FROM audit_log
    WHERE action = 'invoice.paid'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  console.log('\n=== Recent invoice.paid audit entries ===');
  console.log(JSON.stringify(audit.rows, null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
