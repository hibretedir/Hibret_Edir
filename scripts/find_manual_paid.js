require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

async function main() {
  const db = getDb();
  const audit = await db.query(`
    SELECT id, summary, new_value, created_at
    FROM audit_log
    WHERE action IN ('invoice.paid', 'invoice.updated')
      AND (summary ILIKE '%marked paid%' OR new_value::text ILIKE '%paid_note%')
    ORDER BY created_at DESC
    LIMIT 30
  `);
  console.log('Audit manual marks:', JSON.stringify(audit.rows, null, 2));

  const paidNotes = await db.query(`
    SELECT invoice_number, status, paid_note, recipient_name, updated_at
    FROM invoices WHERE paid_note IS NOT NULL AND TRIM(paid_note) <> ''
    ORDER BY updated_at DESC
  `);
  console.log('\nInvoices with paid_note:', JSON.stringify(paidNotes.rows, null, 2));

  const paidButMaybeCancel = await db.query(`
    SELECT invoice_number, status, paid_note, recipient_name, paypal_invoice_id
    FROM invoices
    WHERE LOWER(status) = 'paid'
      AND (paid_note IS NOT NULL OR updated_at > NOW() - INTERVAL '1 day')
    ORDER BY updated_at DESC
    LIMIT 10
  `);
  console.log('\nRecent Paid:', JSON.stringify(paidButMaybeCancel.rows, null, 2));

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
