/**
 * Revert a manually marked-paid invoice.
 * Usage: node scripts/unmark_invoice.js 1036 [--apply]
 */
require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

const invoiceNum = Number(process.argv[2]);
const APPLY = process.argv.includes('--apply');

if (!invoiceNum) {
  console.error('Usage: node scripts/unmark_invoice.js <invoice_number> [--apply]');
  process.exit(1);
}

async function main() {
  const db = getDb();
  const cur = await db.query(
    'SELECT invoice_number, status, paid_note, recipient_name FROM invoices WHERE invoice_number = $1',
    [invoiceNum]
  );
  const row = cur.rows[0];
  if (!row) {
    console.error(`Invoice #${invoiceNum} not found.`);
    process.exit(1);
  }

  console.log(`#${row.invoice_number} ${row.recipient_name}: ${row.status} → Unpaid`);
  if (row.paid_note) console.log(`  clearing paid_note: ${row.paid_note}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to update.');
    process.exit(0);
  }

  await db.query(
    `UPDATE invoices
     SET status = 'Unpaid', paid_note = NULL, paid_date = NULL, updated_at = NOW()
     WHERE invoice_number = $1`,
    [invoiceNum]
  );
  await db.query(
    `INSERT INTO audit_log (actor_type, actor_label, action, table_name, entity_type, summary, new_value)
     VALUES ('board', 'Board Admin', 'invoice.corrected', 'invoices', 'invoices', $1, $2)`,
    [
      `Invoice #${invoiceNum}: ${row.status} → Unpaid (manual mark removed)`,
      JSON.stringify({ invoice_number: invoiceNum, status: 'Unpaid', prior_status: row.status }),
    ]
  );
  console.log('Done.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
