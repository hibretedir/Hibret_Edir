require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

async function main() {
  const db = getDb();

  const members = await db.query(`
    SELECT id, member_number, paypal_name, full_name, status
    FROM members
    WHERE paypal_name ILIKE '%behailu%' OR full_name ILIKE '%behailu%'
       OR paypal_name ILIKE '%yigzaw%' OR full_name ILIKE '%yigzaw%'
    ORDER BY member_number
  `);
  console.log('All matching members:');
  for (const m of members.rows) {
    const cnt = await db.query(
      `SELECT COUNT(DISTINCT invoice_number)::int c FROM invoices WHERE member_id = $1`,
      [m.id]
    );
    const evCnt = await db.query(
      `SELECT COUNT(DISTINCT e.event_number)::int c
       FROM invoices i LEFT JOIN events e ON i.event_id = e.id
       WHERE i.member_id = $1 AND e.event_number IS NOT NULL`,
      [m.id]
    );
    console.log(`  #${m.member_number} id=${m.id} ${m.paypal_name} | ${m.status} | ${cnt.rows[0].c} invoices | ${evCnt.rows[0].c} events`);
  }

  // Also match by recipient_name on invoices
  for (const search of ['Behailu', 'Yigzaw']) {
    const byRecipient = await db.query(`
      SELECT DISTINCT i.member_id, m.member_number, m.paypal_name, COUNT(DISTINCT i.invoice_number)::int cnt
      FROM invoices i
      LEFT JOIN members m ON i.member_id = m.id
      WHERE i.recipient_name ILIKE $1
      GROUP BY i.member_id, m.member_number, m.paypal_name
    `, [`%${search}%`]);
    console.log(`\nInvoices with recipient_name like ${search}:`);
    console.log(byRecipient.rows);
  }

  // Behailu with ~13 event invoices
  const behailuInv = await db.query(`
    SELECT DISTINCT ON (i.invoice_number)
      i.invoice_number, i.status, i.recipient_name, e.event_number,
      COALESCE(e.deceased_name,'') deceased_name, m.paypal_name, m.member_number
    FROM invoices i
    LEFT JOIN events e ON i.event_id = e.id
    LEFT JOIN members m ON i.member_id = m.id
    WHERE (i.recipient_name ILIKE '%behailu%' OR m.paypal_name ILIKE '%behailu%')
      AND e.event_number IS NOT NULL
    ORDER BY i.invoice_number, e.event_number
  `);
  console.log(`\nBehailu event invoices (${behailuInv.rows.length}):`);
  for (const r of behailuInv.rows.sort((a,b) => a.event_number - b.event_number)) {
    console.log(`  #${r.event_number} ${r.deceased_name} — inv #${r.invoice_number} ${r.status} (${r.paypal_name || r.recipient_name})`);
  }

  const yigzawInv = await db.query(`
    SELECT DISTINCT ON (i.invoice_number)
      i.invoice_number, i.status, e.event_number,
      COALESCE(e.deceased_name,'') deceased_name
    FROM invoices i
    LEFT JOIN events e ON i.event_id = e.id
    LEFT JOIN members m ON i.member_id = m.id
    WHERE m.member_number = 10 OR m.paypal_name ILIKE '%yigzaw%'
    ORDER BY i.invoice_number, e.event_number
  `);
  console.log(`\nYigzaw event invoices (${yigzawInv.rows.length}):`);
  const yigEvents = new Set();
  for (const r of yigzawInv.rows.sort((a,b) => (a.event_number||0) - (b.event_number||0))) {
    if (r.event_number) yigEvents.add(r.event_number);
    console.log(`  #${r.event_number ?? '?'} ${r.deceased_name} — inv #${r.invoice_number} ${r.status}`);
  }

  const behEvents = new Set(behailuInv.rows.map(r => r.event_number).filter(Boolean));
  const missing = [...behEvents].filter(e => !yigEvents.has(e)).sort((a,b)=>a-b);
  const extra = [...yigEvents].filter(e => !behEvents.has(e)).sort((a,b)=>a-b);
  console.log(`\nEvents in Behailu set but not Yigzaw: ${missing.join(', ') || 'none'}`);
  for (const ev of missing) {
    const row = behailuInv.rows.find(r => r.event_number === ev);
    console.log(`  MISSING: Event #${ev} ${row?.deceased_name} — Behailu inv #${row?.invoice_number}`);
  }
  console.log(`Events in Yigzaw but not Behailu: ${extra.join(', ') || 'none'}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
