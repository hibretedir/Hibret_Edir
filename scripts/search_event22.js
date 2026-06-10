require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

async function main() {
  const db = getDb();

  // Search for #22 in any invoice field / unlinked
  const r = await db.query(`
    SELECT i.invoice_number, i.recipient_name, i.status, m.paypal_name,
           e.event_number, e.deceased_name
    FROM invoices i
    LEFT JOIN events e ON i.event_id = e.id
    LEFT JOIN members m ON i.member_id = m.id
    WHERE e.event_number = 22
       OR e.deceased_name ILIKE '%22%'
       OR i.recipient_name ILIKE '%behailu%'
       OR i.recipient_name ILIKE '%yigzaw%'
    ORDER BY i.invoice_number
  `);

  // Find invoices with no event for behailu/yigzaw
  const unlinked = await db.query(`
    SELECT i.invoice_number, i.status, i.recipient_name, m.paypal_name, m.member_number
    FROM invoices i
    LEFT JOIN members m ON i.member_id = m.id
    WHERE i.event_id IS NULL
      AND (i.recipient_name ILIKE '%behailu%' OR i.recipient_name ILIKE '%yigzaw%'
           OR m.paypal_name ILIKE '%behailu aklilu%' OR m.paypal_name ILIKE '%yigzaw%')
    ORDER BY i.invoice_number
  `);
  console.log('Unlinked invoices for Behailu/Yigzaw:');
  unlinked.rows.forEach(r => console.log(`  #${r.invoice_number} ${r.status} ${r.recipient_name} [${r.paypal_name} #${r.member_number}]`));

  // Event 15 - check if Behailu has it under different spellings
  const ev15all = await db.query(`
    SELECT i.invoice_number, i.recipient_name, m.paypal_name, e.deceased_name
    FROM invoices i JOIN events e ON i.event_id = e.id
    LEFT JOIN members m ON i.member_id = m.id
    WHERE e.event_number = 15 OR e.deceased_name ILIKE '%daniel deda%'
  `);
  console.log('\nEvent 15 / Daniel Deda all holders:');
  ev15all.rows.forEach(r => console.log(`  inv #${r.invoice_number} ${r.recipient_name} [${r.paypal_name}]`));

  // Count events in sequence - what's event 22 deceased name in PayPal exports?
  // Search members list for joined date context
  const beh = await db.query(`SELECT * FROM members WHERE paypal_name ILIKE '%behailu aklilu%'`);
  const yig = await db.query(`SELECT * FROM members WHERE paypal_name ILIKE '%yigzaw%'`);
  console.log('\nBehailu:', beh.rows[0]?.joined_date, beh.rows[0]?.email);
  console.log('Yigzaw:', yig.rows[0]?.joined_date, yig.rows[0]?.email);

  // All event numbers in DB
  const evs = await db.query(`SELECT event_number, deceased_name FROM events ORDER BY event_number`);
  console.log('\nEvent catalog (note gap at 22):');
  let prev = 0;
  for (const e of evs.rows) {
    if (e.event_number - prev > 1 && prev > 0) {
      console.log(`  *** GAP: no event #${prev + 1} to #${e.event_number - 1} in catalog ***`);
    }
    console.log(`  #${e.event_number} ${e.deceased_name}`);
    prev = e.event_number;
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
