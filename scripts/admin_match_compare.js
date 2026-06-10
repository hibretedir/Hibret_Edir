require('dotenv').config();
const { getDb } = require('../netlify/functions/db');

function norm(s) { return String(s || '').trim().toLowerCase(); }
function placeholder(e) { const x = norm(e); return !x || x === 'noemailinfile@gmail.com'; }

function nameMatches(invName, member) {
  const n = norm(invName);
  const paypal = norm(member.paypal_name);
  const full = norm(member.full_name);
  const first = norm(member.first_name);
  const last = norm(member.last_name);
  if (paypal && n === paypal) return true;
  if (full && (n === full || full.includes(n) || n.includes(full))) return true;
  if (first && last && n.includes(first) && n.includes(last)) return true;
  return false;
}

function belongs(inv, member, members) {
  const invName = norm(inv.name || inv.recipient_name);
  if (invName) {
    if (nameMatches(invName, member)) return true;
    if (members.some(m => m.id !== member.id && nameMatches(invName, m))) return false;
  }
  const invEmail = norm(inv.email || inv.member_email);
  const memEmail = norm(member.email);
  if (!placeholder(memEmail) && invEmail && memEmail && invEmail === memEmail) return true;
  return false;
}

function eventKey(inv) {
  const ev = inv.event_number;
  if (ev != null) return `ev:${ev}`;
  const name = norm(inv.deceased_name);
  if (name) return `name:${name}`;
  return `unlinked:${inv.invoice_number}`;
}

async function main() {
  const db = getDb();
  const members = (await db.query(`SELECT * FROM members WHERE paypal_name ILIKE '%behailu aklilu%' OR paypal_name ILIKE '%yigzaw%'`)).rows;
  const invRows = (await db.query(`
    SELECT DISTINCT ON (i.invoice_number)
      i.invoice_number AS invoice_num, i.status, i.recipient_name,
      COALESCE(i.recipient_name, m.paypal_name, m.full_name) AS name,
      m.email AS member_email, i.member_id,
      e.event_number, COALESCE(e.deceased_name,'') AS deceased_name
    FROM invoices i
    LEFT JOIN events e ON i.event_id = e.id
    LEFT JOIN members m ON i.member_id = m.id
    WHERE i.invoice_number IS NOT NULL
    ORDER BY i.invoice_number DESC,
      (CASE WHEN i.event_id IS NOT NULL THEN 0 ELSE 1 END),
      i.updated_at DESC
  `)).rows;

  for (const member of members) {
    const matched = invRows.filter(inv => belongs(inv, member, members));
    const byEvent = new Map();
    for (const inv of matched) byEvent.set(eventKey(inv), inv);
    console.log(`\n=== ${member.paypal_name} (#${member.member_number}) — ${matched.length} invoices (${byEvent.size} unique events) ===`);
    for (const inv of matched.sort((a,b)=>(a.event_number||0)-(b.event_number||0)||a.invoice_num-b.invoice_num)) {
      console.log(`  #${inv.event_number??'—'} ${inv.deceased_name||'(no event)'} — inv #${inv.invoice_num} ${inv.status}`);
    }
  }

  const beh = members.find(m => m.paypal_name.includes('Behailu'));
  const yig = members.find(m => m.paypal_name.includes('Yigzaw'));
  const behInv = invRows.filter(inv => belongs(inv, beh, members));
  const yigInv = invRows.filter(inv => belongs(inv, yig, members));
  const behKeys = new Map(behInv.map(i => [eventKey(i), i]));
  const yigKeys = new Map(yigInv.map(i => [eventKey(i), i]));

  console.log('\n=== Yigzaw MISSING (in Behailu, not in Yigzaw) ===');
  for (const [k, inv] of behKeys) {
    if (!yigKeys.has(k)) {
      console.log(`  Event #${inv.event_number??'—'} ${inv.deceased_name||'unlinked inv #'+inv.invoice_num} — Behailu inv #${inv.invoice_num}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
