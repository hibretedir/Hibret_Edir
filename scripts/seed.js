/**
 * Seed local PostgreSQL from exported files in data/ (gitignored).
 *
 * Place your exports here (do NOT commit):
 *   data/members.json  OR  data/members.csv
 *   data/invoices.json OR  data/invoices.csv
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/seed.js
 *   DATABASE_URL=postgres://... node scripts/seed.js --dry-run
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DRY_RUN = process.argv.includes('--dry-run');
const CONNECT_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = 30000;

function readJsonIfExists(filename) {
  const full = path.join(DATA_DIR, filename);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).filter(Boolean).map((line) => {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current.trim());
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] ?? '';
    });
    return row;
  });
}

function readCsvIfExists(filename) {
  const full = path.join(DATA_DIR, filename);
  if (!fs.existsSync(full)) return null;
  return parseCsv(fs.readFileSync(full, 'utf8'));
}

function loadMembers() {
  const json = readJsonIfExists('members.json');
  if (json) return Array.isArray(json) ? json : json.members || [];
  const csv = readCsvIfExists('members.csv');
  if (csv) return csv;
  return null;
}

function loadInvoices() {
  const json = readJsonIfExists('invoices.json');
  if (json) return Array.isArray(json) ? json : json.invoices || [];
  const csv = readCsvIfExists('invoices.csv');
  if (csv) return csv;
  return null;
}

function normalizePhone(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 10) return value || null;
  const last10 = digits.slice(-10);
  return `${last10.slice(0, 3)}-${last10.slice(3, 6)}-${last10.slice(6)}`;
}

function normalizeMember(row, index) {
  const first = row.first_name || row.first || row.First || '';
  const last = row.last_name || row.last || row.Last || '';
  return {
    member_number: Number(row.member_number || row.id || row.ID || index + 1),
    status: row.status || row.Status || 'Active',
    first_name: first || null,
    last_name: last || null,
    full_name: row.full_name || row.full_name_spouse || row['Full Name'] || `${first} ${last}`.trim() || null,
    paypal_name: row.paypal_name || row.paypal_name_exact || row['PayPal Name'] || null,
    email: row.email || row.Email || null,
    mobile: normalizePhone(row.mobile || row.Mobile || row.cell),
    home_phone: normalizePhone(row.home_phone || row.home || row.Home),
    address: row.address || row.Address || null,
    notes: row.notes || row.Notes || '',
    joined_date: row.joined_date || row.joined || null,
  };
}

function normalizeInvoice(row) {
  return {
    invoice_number: row.invoice_number || row.invoice_num || row['Invoice Number'] || null,
    paypal_invoice_id: row.paypal_invoice_id || row.paypal_id || row['PayPal Invoice ID'] || null,
    paypal_name: row.paypal_name || row.name || row.recipient || row['PayPal Name'] || null,
    email: row.email || row.member_email || row['Email'] || null,
    event_number: row.event_number || row.event || row.event_num || null,
    deceased_name: row.deceased_name || row.item || row.event_name || null,
    status: row.status || row.Status || 'Unpaid',
    amount: Number(row.amount || row.total || row.Amount || 110),
    amount_due: Number(row.amount_due ?? row.amount ?? row.Amount || 110),
    sent_date: row.sent_date || row.date || row['Sent Date'] || null,
    paid_date: row.paid_date || row['Paid Date'] || null,
    payment_method: row.payment_method || row.method || 'PayPal',
    paypal_link: row.paypal_link || row.link || null,
  };
}

async function withClient(fn) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Add it to .env (never commit .env).');
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  });

  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

async function upsertMembers(client, members) {
  let count = 0;
  for (const raw of members) {
    const m = normalizeMember(raw, count);
    if (!m.member_number) continue;

    if (DRY_RUN) {
      console.log('[dry-run] member', m.member_number, m.paypal_name || m.full_name);
      count += 1;
      continue;
    }

    await client.query(
      `INSERT INTO members (
         member_number, status, first_name, last_name, full_name, paypal_name,
         email, mobile, home_phone, address, notes, joined_date
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (member_number) DO UPDATE SET
         status = EXCLUDED.status,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         full_name = EXCLUDED.full_name,
         paypal_name = EXCLUDED.paypal_name,
         email = EXCLUDED.email,
         mobile = EXCLUDED.mobile,
         home_phone = EXCLUDED.home_phone,
         address = EXCLUDED.address,
         notes = EXCLUDED.notes,
         joined_date = EXCLUDED.joined_date,
         updated_at = NOW()`,
      [
        m.member_number, m.status, m.first_name, m.last_name, m.full_name, m.paypal_name,
        m.email, m.mobile, m.home_phone, m.address, m.notes, m.joined_date,
      ]
    );
    count += 1;
  }
  return count;
}

async function findMemberId(client, { paypal_name, email }) {
  if (email) {
    const byEmail = await client.query(
      'SELECT id FROM members WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email]
    );
    if (byEmail.rows[0]) return byEmail.rows[0].id;
  }
  if (paypal_name) {
    const byPaypal = await client.query(
      'SELECT id FROM members WHERE LOWER(paypal_name) = LOWER($1) LIMIT 1',
      [paypal_name]
    );
    if (byPaypal.rows[0]) return byPaypal.rows[0].id;
  }
  return null;
}

async function upsertEvent(client, eventNumber, deceasedName) {
  if (!eventNumber) return null;
  const result = await client.query(
    `INSERT INTO events (event_number, deceased_name, status)
     VALUES ($1, $2, 'Active')
     ON CONFLICT (event_number) DO UPDATE SET
       deceased_name = COALESCE(EXCLUDED.deceased_name, events.deceased_name),
       updated_at = NOW()
     RETURNING id`,
    [eventNumber, deceasedName || `Event #${eventNumber}`]
  );
  return result.rows[0].id;
}

async function upsertInvoices(client, invoices) {
  let count = 0;
  let unmatched = 0;

  for (const raw of invoices) {
    const inv = normalizeInvoice(raw);
    const memberId = await findMemberId(client, {
      paypal_name: inv.paypal_name,
      email: inv.email,
    });

    if (!memberId) {
      unmatched += 1;
      console.warn('No member match for invoice:', inv.invoice_number, inv.paypal_name || inv.email);
    }

    const eventId = inv.event_number
      ? await upsertEvent(client, Number(inv.event_number), inv.deceased_name)
      : null;

    if (DRY_RUN) {
      console.log('[dry-run] invoice', inv.invoice_number, inv.paypal_name, 'memberId=', memberId);
      count += 1;
      continue;
    }

    if (inv.paypal_invoice_id) {
      await client.query(
        `INSERT INTO invoices (
           paypal_invoice_id, invoice_number, member_id, event_id, status,
           amount, amount_due, sent_date, paid_date, payment_method, paypal_link
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (paypal_invoice_id) DO UPDATE SET
           invoice_number = EXCLUDED.invoice_number,
           member_id = EXCLUDED.member_id,
           event_id = EXCLUDED.event_id,
           status = EXCLUDED.status,
           amount = EXCLUDED.amount,
           amount_due = EXCLUDED.amount_due,
           sent_date = EXCLUDED.sent_date,
           paid_date = EXCLUDED.paid_date,
           payment_method = EXCLUDED.payment_method,
           paypal_link = EXCLUDED.paypal_link,
           updated_at = NOW()`,
        [
          inv.paypal_invoice_id, inv.invoice_number, memberId, eventId, inv.status,
          inv.amount, inv.amount_due, inv.sent_date, inv.paid_date, inv.payment_method, inv.paypal_link,
        ]
      );
    } else {
      await client.query(
        `INSERT INTO invoices (
           invoice_number, member_id, event_id, status,
           amount, amount_due, sent_date, paid_date, payment_method, paypal_link
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING`,
        [
          inv.invoice_number, memberId, eventId, inv.status,
          inv.amount, inv.amount_due, inv.sent_date, inv.paid_date, inv.payment_method, inv.paypal_link,
        ]
      );
    }
    count += 1;
  }

  return { count, unmatched };
}

async function main() {
  const members = loadMembers();
  const invoices = loadInvoices();

  if (!members?.length) {
    console.error('No member data found. Add data/members.json or data/members.csv');
    process.exit(1);
  }

  console.log(`Loaded ${members.length} members`);
  if (invoices?.length) {
    console.log(`Loaded ${invoices.length} invoices`);
  }

  if (DRY_RUN) {
    console.log('Dry run only — no database writes.');
  }

  await withClient(async (client) => {
    const memberCount = await upsertMembers(client, members);
    console.log(`Members processed: ${memberCount}`);

    if (invoices?.length) {
      const { count, unmatched } = await upsertInvoices(client, invoices);
      console.log(`Invoices processed: ${count}`);
      if (unmatched) {
        console.warn(`Invoices without member match: ${unmatched}`);
      }
    }
  });

  console.log('Seed complete.');
}

main().catch((error) => {
  console.error('Seed failed:', error.message);
  process.exit(1);
});
