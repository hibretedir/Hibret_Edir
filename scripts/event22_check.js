require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

async function main() {
  const db = getDb();

  const members = await db.query(`
    SELECT id, member_number, paypal_name, full_name, status
    FROM members
    WHERE paypal_name ILIKE '%behailu%' OR first_name ILIKE '%behailu%'
       OR paypal_name ILIKE '%yigzaw%'
    ORDER BY member_number
  `);
  console.log('Members:');
  for (const row of members.rows) {
    const c = await db.query(
      `SELECT COUNT(DISTINCT i.invoice_number)::int cnt,
              COUNT(DISTINCT e.event_number) FILTER (WHERE e.event_number IS NOT NULL)::int ev
       FROM invoices i LEFT JOIN events e ON i.event_id = e.id
       WHERE i.member_id = $1`,
      [row.id]
    );
    console.log(`  #${row.member_number} ${row.paypal_name} (${row.status}) — ${c.rows[0].cnt} invoices, ${c.rows[0].ev} events`);
  }

  const allEv = await db.query(`SELECT id, event_number, deceased_name FROM events ORDER BY event_number`);
  console.log('\nAll events in catalog:');
  for (const e of allEv.rows) console.log(`  #${e.event_number} ${e.deceased_name}`);

  const ev22 = await db.query(`
    SELECT i.invoice_number, i.status, i.recipient_name, m.paypal_name, m.member_number
    FROM events e
    JOIN invoices i ON i.event_id = e.id
    LEFT JOIN members m ON i.member_id = m.id
    WHERE e.event_number = 22
    ORDER BY m.paypal_name, i.invoice_number
  `);
  console.log(`\nEvent #22 invoices (${ev22.rows.length} rows):`);
  for (const r of ev22.rows) {
    console.log(`  inv #${r.invoice_number} ${r.status} — ${r.paypal_name || r.recipient_name} (#${r.member_number})`);
  }

  // Behailu Aklilu by member_id 45 - all invoices including unlinked
  const behailu45 = await db.query(`
    SELECT DISTINCT ON (i.invoice_number)
      i.invoice_number, i.status, e.event_number, COALESCE(e.deceased_name,'') deceased_name, i.recipient_name
    FROM invoices i
    LEFT JOIN events e ON i.event_id = e.id
    WHERE i.member_id = 45 OR i.recipient_name ILIKE '%behailu aklilu%'
    ORDER BY i.invoice_number DESC, i.event_id NULLS LAST
  `);
  console.log(`\nBehailu Aklilu (member 45) all invoices (${behailu45.rows.length}):`);
  for (const r of behailu45.rows.sort((a,b)=>(a.event_number||0)-(b.event_number||0))) {
    console.log(`  #${r.event_number ?? '?'} ${r.deceased_name || '(unlinked)'} — inv #${r.invoice_number} ${r.status}`);
  }

  // Search invoices where recipient is Behailu Aklilu
  const behRecipient = await db.query(`
    SELECT DISTINCT ON (i.invoice_number)
      i.invoice_number, i.status, e.event_number, COALESCE(e.deceased_name,'') deceased_name, i.member_id, m.paypal_name
    FROM invoices i
    LEFT JOIN events e ON i.event_id = e.id
    LEFT JOIN members m ON i.member_id = m.id
    WHERE TRIM(i.recipient_name) ILIKE 'Behailu Aklilu'
    ORDER BY i.invoice_number, e.event_number
  `);
  console.log(`\nRecipient 'Behailu Aklilu' invoices (${behRecipient.rows.length}):`);
  for (const r of behRecipient.rows.sort((a,b)=>(a.event_number||0)-(b.event_number||0))) {
    console.log(`  #${r.event_number ?? '?'} ${r.deceased_name} — inv #${r.invoice_number} ${r.status} member=${r.paypal_name}`);
  }

  // Yigzaw member 9
  const yig = await db.query(`
    SELECT DISTINCT ON (i.invoice_number)
      i.invoice_number, i.status, e.event_number, COALESCE(e.deceased_name,'') deceased_name
    FROM invoices i LEFT JOIN events e ON i.event_id = e.id
    WHERE i.member_id = 9
    ORDER BY i.invoice_number, e.event_number
  `);
  const behEv = new Set(behRecipient.rows.map(r => r.event_number).filter(Boolean));
  const yigEv = new Set(yig.rows.map(r => r.event_number).filter(Boolean));
  console.log('\nBehailu events:', [...behEv].sort((a,b)=>a-b).join(', '));
  console.log('Yigzaw events:', [...yigEv].sort((a,b)=>a-b).join(', '));
  const missing = [...behEv].filter(e => !yigEv.has(e));
  console.log('Yigzaw missing vs Behailu:', missing);
  for (const ev of missing) {
    const row = behRecipient.rows.find(r => r.event_number === ev);
    console.log(`  → Event #${ev} ${row?.deceased_name}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
