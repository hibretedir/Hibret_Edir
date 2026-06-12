/**
 * Seed waiting_list from public/waiting-list-public.json when the DB queue is empty.
 * Names and dates only — run import:waiting-list:seed with the board Excel for real email/phone.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getDb } = require('../netlify/functions/db');

const PUBLIC_JSON = path.join(__dirname, '..', 'public', 'waiting-list-public.json');

function splitName(full) {
  const text = String(full || '').trim();
  if (!text) return { first_name: null, last_name: null, full_name: null };
  const parts = text.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: null, full_name: text };
  return { first_name: parts[0], last_name: parts.slice(1).join(' '), full_name: text };
}

function parseAppliedDate(text) {
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to .env first.');
    process.exit(1);
  }
  if (!fs.existsSync(PUBLIC_JSON)) {
    console.error('Missing public/waiting-list-public.json');
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(PUBLIC_JSON, 'utf8'));
  const entries = payload.entries || [];
  if (!entries.length) {
    console.error('No entries in waiting-list-public.json');
    process.exit(1);
  }

  const db = getDb();
  const existing = await db.query('SELECT COUNT(*)::int AS n FROM waiting_list');
  if (existing.rows[0].n > 0) {
    console.log(`waiting_list already has ${existing.rows[0].n} rows — skipping seed.`);
    console.log('To re-import from Excel: npm run import:waiting-list:seed');
    await db.end();
    return;
  }

  const sorted = [...entries].sort((a, b) => Number(a.position) - Number(b.position));
  let inserted = 0;

  for (const entry of sorted) {
    const pos = Number(entry.position);
    const names = splitName(entry.display_name);
    const status = entry.added ? 'Added as Member' : 'Registered';
    const appliedAt = parseAppliedDate(entry.applied_date_text);
    const email = `waiting-list-${pos}@import.local`;
    const phone = `(000) 000-${String(pos).padStart(4, '0').slice(-4)}`;
    const notes = `Seeded from waiting-list-public.json (#${pos}). Re-import board Excel for real email/phone.`;

    await db.query(
      `INSERT INTO waiting_list (
         first_name, last_name, full_name, email, phone, status, applied_at, notes, applicant_role
       ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()), $8, 'primary')`,
      [
        names.first_name,
        names.last_name,
        names.full_name,
        email,
        phone,
        status,
        appliedAt,
        notes,
      ]
    );
    inserted += 1;
  }

  console.log(`Seeded ${inserted} waiting list rows from waiting-list-public.json.`);
  console.log('Next: npm run dev → Admin → Approval → Waiting List → Ready to Invite');
  console.log('For real invite emails, place data/Hibret Waiting list.xlsx and run: npm run import:waiting-list:seed');
  await db.end();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
