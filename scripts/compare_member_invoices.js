/**
 * Compare invoice events between two members.
 * Usage: node scripts/compare_member_invoices.js Behailu Yigzaw
 */
require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

const names = process.argv.slice(2);
if (names.length < 2) {
  console.error('Usage: node scripts/compare_member_invoices.js <name1> <name2>');
  process.exit(1);
}

function eventKey(row) {
  const ev = row.event_number != null ? `#${row.event_number}` : '';
  const deceased = (row.deceased_name || row.item || '').trim();
  return `${ev} ${deceased}`.trim() || `invoice-${row.invoice_number}`;
}

async function findMembers(db, search) {
  const r = await db.query(
    `SELECT id, member_number, paypal_name, full_name, email, status
     FROM members
     WHERE paypal_name ILIKE $1 OR full_name ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1
     ORDER BY member_number`,
    [`%${search}%`]
  );
  return r.rows;
}

async function getInvoices(db, memberId) {
  const r = await db.query(
    `SELECT DISTINCT ON (i.invoice_number)
       i.invoice_number,
       i.status,
       i.amount_due,
       i.sent_date,
       e.event_number,
       COALESCE(e.deceased_name, '') AS deceased_name,
       COALESCE(e.deceased_name, '') AS item
     FROM invoices i
     LEFT JOIN events e ON i.event_id = e.id
     WHERE i.member_id = $1
       AND i.invoice_number IS NOT NULL
     ORDER BY i.invoice_number DESC,
       (CASE WHEN i.event_id IS NOT NULL THEN 0 ELSE 1 END),
       i.updated_at DESC`,
    [memberId]
  );
  return r.rows;
}

async function main() {
  const db = getDb();

  for (const n of names) {
    const members = await findMembers(db, n);
    console.log(`\nMembers matching "${n}":`);
    for (const m of members) {
      console.log(`  #${m.member_number} id=${m.id} ${m.paypal_name} | ${m.full_name} | ${m.status}`);
    }
  }

  const m1List = await findMembers(db, names[0]);
  const m2List = await findMembers(db, names[1]);
  if (!m1List.length || !m2List.length) {
    console.error('Could not find both members.');
    process.exit(1);
  }

  const m1 = m1List.find(m => m.status === 'Active') || m1List[0];
  const m2 = m2List.find(m => m.status === 'Active') || m2List[0];

  const inv1 = await getInvoices(db, m1.id);
  const inv2 = await getInvoices(db, m2.id);

  const map1 = new Map();
  const map2 = new Map();
  for (const inv of inv1) map1.set(eventKey(inv), inv);
  for (const inv of inv2) map2.set(eventKey(inv), inv);

  console.log(`\n=== ${m1.paypal_name} (#${m1.member_number}) — ${inv1.length} invoices ===`);
  for (const inv of inv1.sort((a, b) => (a.event_number || 0) - (b.event_number || 0))) {
    console.log(`  Event #${inv.event_number ?? '?'} ${inv.deceased_name || '(no name)'} — inv #${inv.invoice_number} ${inv.status}`);
  }

  console.log(`\n=== ${m2.paypal_name} (#${m2.member_number}) — ${inv2.length} invoices ===`);
  for (const inv of inv2.sort((a, b) => (a.event_number || 0) - (b.event_number || 0))) {
    console.log(`  Event #${inv.event_number ?? '?'} ${inv.deceased_name || '(no name)'} — inv #${inv.invoice_number} ${inv.status}`);
  }

  const only1 = [...map1.keys()].filter(k => !map2.has(k));
  const only2 = [...map2.keys()].filter(k => !map1.has(k));

  console.log(`\n=== In ${m1.paypal_name} but NOT in ${m2.paypal_name} (${only1.length}) ===`);
  for (const k of only1.sort()) {
    const inv = map1.get(k);
    console.log(`  MISSING for ${m2.paypal_name}: Event #${inv.event_number ?? '?'} ${inv.deceased_name || k} — inv #${inv.invoice_number} ${inv.status}`);
  }

  console.log(`\n=== In ${m2.paypal_name} but NOT in ${m1.paypal_name} (${only2.length}) ===`);
  for (const k of only2.sort()) {
    const inv = map2.get(k);
    console.log(`  Event #${inv.event_number ?? '?'} ${inv.deceased_name || k} — inv #${inv.invoice_number} ${inv.status}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
