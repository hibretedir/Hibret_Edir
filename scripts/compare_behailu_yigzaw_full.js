require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

async function memberInvoices(db, memberId, label) {
  const r = await db.query(`
    SELECT DISTINCT ON (i.invoice_number)
      i.invoice_number, i.status, i.recipient_name,
      e.event_number, COALESCE(e.deceased_name, '') AS deceased_name,
      i.paypal_invoice_id
    FROM invoices i
    LEFT JOIN events e ON i.event_id = e.id
    WHERE i.member_id = $1 AND i.invoice_number IS NOT NULL
    ORDER BY i.invoice_number DESC,
      (CASE WHEN i.event_id IS NOT NULL THEN 0 ELSE 1 END),
      i.updated_at DESC
  `, [memberId]);

  console.log(`\n=== ${label} — ${r.rows.length} invoices ===`);
  const byEvent = new Map();
  for (const row of r.rows.sort((a, b) => (a.event_number || 999) - (b.event_number || 999) || a.invoice_number - b.invoice_number)) {
    const key = row.event_number != null ? `#${row.event_number} ${row.deceased_name}` : `unlinked #${row.invoice_number}`;
    byEvent.set(key, row);
    console.log(`  Event #${row.event_number ?? '—'} ${row.deceased_name || '(no event)'} — inv #${row.invoice_number} ${row.status}`);
  }
  return { rows: r.rows, byEvent };
}

async function main() {
  const db = getDb();

  // Behailu Aklilu #52, Yigzaw Tiku #10
  const beh = await db.query(`SELECT * FROM members WHERE member_number = 52`);
  const yig = await db.query(`SELECT * FROM members WHERE member_number = 10`);

  const b = await memberInvoices(db, beh.rows[0].id, 'Behailu Aklilu (#52)');
  const y = await memberInvoices(db, yig.rows[0].id, 'Yigzaw Tiku (#10)');

  const bEvents = new Set(b.rows.filter(r => r.event_number).map(r => r.event_number));
  const yEvents = new Set(y.rows.filter(r => r.event_number).map(r => r.event_number));

  const allNums = new Set([...bEvents, ...yEvents]);
  console.log('\n=== Event-by-event comparison ===');
  for (const ev of [...allNums].sort((a, b) => a - b)) {
    const bHas = bEvents.has(ev);
    const yHas = yEvents.has(ev);
    const deceased = b.rows.find(r => r.event_number === ev)?.deceased_name
      || y.rows.find(r => r.event_number === ev)?.deceased_name;
    const mark = bHas && yHas ? 'both' : bHas ? 'BEHAILU ONLY' : 'YIGZAW ONLY';
    console.log(`  #${ev} ${deceased}: ${mark}`);
  }

  const bUnlinked = b.rows.filter(r => !r.event_number);
  const yUnlinked = y.rows.filter(r => !r.event_number);
  console.log(`\nBehailu unlinked: ${bUnlinked.map(r => '#' + r.invoice_number).join(', ') || 'none'}`);
  console.log(`Yigzaw unlinked: ${yUnlinked.map(r => '#' + r.invoice_number).join(', ') || 'none'}`);

  // Event 15 Daniel Deda
  const ev15 = await db.query(`
    SELECT i.invoice_number, i.status, m.paypal_name, m.member_number
    FROM invoices i JOIN events e ON i.event_id = e.id
    LEFT JOIN members m ON i.member_id = m.id
    WHERE e.event_number = 15
    ORDER BY m.paypal_name
  `);
  console.log(`\nEvent #15 Daniel Deda — who has it? (${ev15.rows.length} invoices)`);
  for (const r of ev15.rows) {
    const flag = [52, 10].includes(r.member_number) ? ' ***' : '';
    console.log(`  #${r.member_number} ${r.paypal_name} inv #${r.invoice_number}${flag}`);
  }

  // Search PayPal line items for event 22 or missing deceased for these members
  for (const name of ['Behailu Aklilu', 'Yigzaw Tiku']) {
    const r = await db.query(`
      SELECT invoice_number, status, recipient_name, event_id,
        (SELECT event_number FROM events WHERE id = invoices.event_id) ev
      FROM invoices
      WHERE member_id = (SELECT id FROM members WHERE paypal_name = $1)
      ORDER BY invoice_number
    `, [name]);
    console.log(`\n${name} member_id invoices count: ${r.rows.length}`);
  }

  // Missing event numbers in sequence 15-30 for each
  for (const [label, evSet] of [['Behailu', bEvents], ['Yigzaw', yEvents]]) {
    const missing = [];
    for (let n = 15; n <= 30; n++) {
      if (!evSet.has(n)) missing.push(n);
    }
    console.log(`${label} missing event numbers (15-30): ${missing.join(', ') || 'none'}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
