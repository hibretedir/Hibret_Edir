/**
 * Clear board test data: Activity log, Approval, Receipts, Messages, Payout Fund.
 * Does NOT delete members, invoices, events, or waiting list.
 *
 * Usage: node scripts/reset_board_test_data.js [--apply]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../netlify/functions/db');

const APPLY = process.argv.includes('--apply');

const TABLES = [
  { name: 'invoice_mark_paid_requests', label: 'Mark-paid approval requests' },
  { name: 'member_change_requests', label: 'Beneficiary / change requests' },
  { name: 'membership_applications', label: 'Membership applications (Approval)' },
  { name: 'receipts', label: 'Receipt uploads' },
  { name: 'event_payouts', label: 'Payout fund cases' },
  { name: 'contact_messages', label: 'Contact messages' },
  { name: 'pin_reset_requests', label: 'PIN reset requests' },
  { name: 'audit_log', label: 'Activity log' },
];

async function countTable(db, table) {
  const res = await db.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
  return res.rows[0]?.c ?? 0;
}

async function main() {
  const db = getDb();
  console.log(APPLY ? 'Applying reset…\n' : 'Dry run (add --apply to delete):\n');

  const counts = [];
  for (const t of TABLES) {
    const c = await countTable(db, t.name);
    counts.push({ ...t, count: c });
    console.log(`  ${t.label}: ${c}`);
  }

  const total = counts.reduce((s, t) => s + t.count, 0);
  console.log(`\nTotal rows: ${total}`);

  if (!APPLY) {
    console.log('\nRe-run with --apply to clear all of the above.');
    process.exit(0);
  }

  if (!total) {
    console.log('\nNothing to delete.');
    process.exit(0);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const t of TABLES) {
      await client.query(`DELETE FROM ${t.name}`);
      console.log(`Cleared ${t.name}`);
    }
    await client.query('COMMIT');
    console.log('\nDone. Hard-refresh admin (Ctrl+Shift+R) to clear session cache.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await db.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
