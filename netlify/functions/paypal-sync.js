// netlify/functions/paypal-sync.js
// GET  — preview PayPal invoices (debug)
// POST — admin: pull PayPal → update PostgreSQL invoices

const { getDb } = require('./db');
const { invalidateInvoiceStatsCache } = require('./invoice-stats-cache');
const { paymentMethodFromPaypalStatus, SYNC_PROTECT_LOCAL_PAID_SQL } = require('./payment-methods');
const { verifyAdminRequest } = require('./admin-auth');
const { loadLocalEnv, paypalApiBase } = require('./paypal-env');
const { getPayPalAccessToken, fetchPayPalInvoiceDetail } = require('./paypal-client');

loadLocalEnv();

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(statusCode, payload) {
  return { statusCode, headers, body: JSON.stringify(payload) };
}

const getAccessToken = getPayPalAccessToken;

async function fetchPayPalBalance(accessToken, currencyCode = 'USD') {
  const base = paypalApiBase();
  const url = `${base}/v1/reporting/balances?currency_code=${encodeURIComponent(currencyCode)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.message || data.error_description || data.name || 'PayPal balance request failed';
    throw new Error(msg);
  }
  const balances = Array.isArray(data.balances) ? data.balances : [];
  const primary = balances.find((b) => b.primary) || balances[0];
  const available = primary?.available_balance || primary?.total_balance;
  const value = available?.value != null ? Number(available.value) : null;
  return {
    currency: available?.currency_code || currencyCode,
    available_balance: Number.isFinite(value) ? value : null,
    as_of: data.as_of_time || new Date().toISOString(),
  };
}

async function fetchInvoiceSummaries(accessToken) {
  const base = paypalApiBase();
  let url = `${base}/v2/invoicing/invoices?page=1&page_size=100&total_count_required=true`;
  const all = [];

  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || data.error || 'PayPal invoice fetch failed');
    }
    all.push(...(data.items || []));
    const next = (data.links || []).find((link) => link.rel === 'next' && link.href);
    url = next?.href || null;
  }

  return all;
}

const fetchInvoiceDetail = fetchPayPalInvoiceDetail;

/** Fetch full invoice details for a batch of PayPal invoice IDs. */
async function fetchPaypalDetailsByIds(accessToken, ids) {
  const CONCURRENCY = 10;
  const full = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const details = await Promise.all(
      batch.map((id) => fetchInvoiceDetail(accessToken, id))
    );
    full.push(...details);
  }
  return full;
}

/** List API omits line items — fetch each invoice detail to read "#30 Deceased Name". */
async function fetchAllPaypalInvoices(accessToken) {
  const summaries = await fetchInvoiceSummaries(accessToken);
  return fetchPaypalDetailsByIds(accessToken, summaries.map((s) => s.id));
}

function mapPaypalStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'PAID' || s === 'MARKED_AS_PAID' || s === 'PARTIALLY_PAID') return 'Paid';
  if (s.startsWith('CANCEL') || s === 'REFUNDED' || s === 'REFUND') return 'Cancelled';
  return 'Unpaid';
}

/** CRM invoice_number is numeric event invoice # only — not PayPal refs like REG-1. */
function parseCrmInvoiceNumber(raw) {
  if (raw == null || raw === '') return null;
  const text = String(raw).trim();
  if (/^REG-/i.test(text)) return null;
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function isRegistrationPaypalInvoice(inv) {
  const ref = String(inv.detail?.invoice_number || '').trim();
  if (/^REG-/i.test(ref)) return true;
  const lines = (inv.items || []).flatMap((item) => [item.name, item.description].filter(Boolean));
  return lines.some((line) => /registration fee|membership registration/i.test(String(line)));
}

function extractEventFromItems(inv) {
  const lines = (inv.items || []).flatMap((item) => [item.name, item.description].filter(Boolean));
  for (const line of lines) {
    const m = String(line).match(/#\s*(\d+)\s+(.+)/i);
    if (m) return { event_number: Number(m[1]), deceased_name: m[2].trim() };
  }
  for (const line of lines) {
    const m = String(line).match(/invoice is for\s+(.+)/i);
    if (m) return { event_number: null, deceased_name: m[1].trim() };
  }
  return { event_number: null, deceased_name: null };
}

function normalizePaypalInvoice(inv) {
  const recipient = inv.primary_recipients?.[0]?.billing_info;
  const name = recipient?.name?.full_name
    || [recipient?.name?.given_name, recipient?.name?.surname].filter(Boolean).join(' ')
    || '';
  const email = recipient?.email_address || '';
  const { event_number, deceased_name } = extractEventFromItems(inv);
  const status = mapPaypalStatus(inv.status);
  const paidTx = inv.payments?.transactions?.[0];
  const payerView = (inv.links || []).find((link) => link.rel === 'payer-view')?.href;
  const payment_method = status === 'Paid'
    ? paymentMethodFromPaypalStatus(inv.status)
    : null;

  return {
    paypal_invoice_id: inv.id,
    invoice_number: isRegistrationPaypalInvoice(inv)
      ? null
      : parseCrmInvoiceNumber(inv.detail?.invoice_number),
    paypal_name: name,
    email,
    event_number,
    deceased_name,
    status,
    amount: Number(inv.amount?.breakdown?.item_total?.value || inv.amount?.value || 110),
    amount_due: status === 'Paid' ? 0 : Number(inv.amount?.value || 110),
    sent_date: inv.detail?.invoice_date || null,
    paid_date: status === 'Paid'
      ? (paidTx?.payment_date ? String(paidTx.payment_date).slice(0, 10) : inv.detail?.invoice_date || null)
      : null,
    payment_method,
    paypal_link: payerView || (inv.id ? `https://www.paypal.com/invoice/p/#${inv.id}` : null),
  };
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

function findMemberIdFromMaps(inv, byEmail, byPaypal) {
  const email = String(inv.email || '').toLowerCase();
  const name = String(inv.paypal_name || '').toLowerCase();
  if (name && byPaypal.has(name)) return byPaypal.get(name);
  if (email && !/noemail/i.test(email) && byEmail.has(email)) return byEmail.get(email);
  return null;
}

async function sanitizeInvoiceNumbers(client, rows) {
  const nums = [...new Set(rows.map((row) => row.invoice_number).filter((n) => n != null))];
  const ownersByNum = new Map();
  if (nums.length) {
    const existing = await client.query(
      `SELECT invoice_number, paypal_invoice_id
       FROM invoices
       WHERE invoice_number = ANY($1::int[])`,
      [nums]
    );
    for (const row of existing.rows) {
      const num = Number(row.invoice_number);
      if (!ownersByNum.has(num)) ownersByNum.set(num, new Set());
      ownersByNum.get(num).add(row.paypal_invoice_id);
    }
  }

  const usedInBatch = new Map();
  return rows.map((row) => {
    const num = row.invoice_number;
    if (num == null) return row;

    const dbOwners = ownersByNum.get(num);
    if (dbOwners) {
      const sameOwnerOnly = dbOwners.size === 1 && dbOwners.has(row.paypal_invoice_id);
      if (!sameOwnerOnly) {
        return { ...row, invoice_number: null };
      }
    }

    const batchOwner = usedInBatch.get(num);
    if (batchOwner && batchOwner !== row.paypal_invoice_id) {
      return { ...row, invoice_number: null };
    }

    usedInBatch.set(num, row.paypal_invoice_id);
    return row;
  });
}

async function applyPaypalRowToInvoice(client, invoiceId, inv) {
  await client.query(
    `UPDATE invoices SET
       paypal_invoice_id = COALESCE(paypal_invoice_id, $2),
       member_id = COALESCE($3, member_id),
       event_id = COALESCE($4, event_id),
       status = CASE
         WHEN $5 IN ('Paid', 'Cancelled') THEN $5
         WHEN ${SYNC_PROTECT_LOCAL_PAID_SQL} AND $5 = 'Unpaid' THEN status
         ELSE $5
       END,
       amount = $6,
       amount_due = CASE
         WHEN $5 IN ('Paid', 'Cancelled') THEN $7
         WHEN ${SYNC_PROTECT_LOCAL_PAID_SQL} AND $5 = 'Unpaid'
           AND LOWER(TRIM(COALESCE(status, ''))) = 'paid' THEN 0
         ELSE $7
       END,
       sent_date = COALESCE($8, sent_date),
       paid_date = CASE
         WHEN $5 = 'Paid' THEN COALESCE($9, paid_date)
         WHEN ${SYNC_PROTECT_LOCAL_PAID_SQL} AND $5 = 'Unpaid'
           AND LOWER(TRIM(COALESCE(status, ''))) = 'paid' THEN paid_date
         ELSE COALESCE($9, paid_date)
       END,
       payment_method = CASE
         WHEN $10 = 'Zelle & BofA' THEN 'Zelle & BofA'
         WHEN LOWER(COALESCE(payment_method, '')) IN ('zelle', 'bofa') THEN payment_method
         WHEN ${SYNC_PROTECT_LOCAL_PAID_SQL} AND $5 = 'Unpaid'
           AND payment_method IS NOT NULL THEN payment_method
         WHEN $10 IS NOT NULL THEN $10
         ELSE payment_method
       END,
       paypal_link = COALESCE($11, paypal_link),
       recipient_name = COALESCE(NULLIF($12, ''), recipient_name),
       updated_at = NOW()
     WHERE id = $1`,
    [
      invoiceId,
      inv.paypal_invoice_id,
      inv.member_id,
      inv.event_id,
      inv.status,
      inv.amount,
      inv.amount_due,
      inv.sent_date,
      inv.paid_date,
      inv.payment_method,
      inv.paypal_link,
      inv.recipient_name,
    ]
  );
}

/** Legacy seeded rows often have invoice_number but no paypal_invoice_id — link instead of inserting duplicates. */
async function linkOrphanInvoices(client, rows) {
  const nums = [...new Set(rows.map((row) => row.invoice_number).filter((n) => n != null))];
  if (!nums.length) return rows;

  const orphans = await client.query(
    `SELECT id, invoice_number
     FROM invoices
     WHERE invoice_number = ANY($1::int[]) AND paypal_invoice_id IS NULL`,
    [nums]
  );
  if (!orphans.rows.length) return rows;

  const orphanByNum = new Map(orphans.rows.map((row) => [Number(row.invoice_number), row.id]));
  const remaining = [];

  for (const inv of rows) {
    const orphanId = inv.invoice_number != null ? orphanByNum.get(inv.invoice_number) : null;
    if (orphanId != null) {
      await applyPaypalRowToInvoice(client, orphanId, inv);
      orphanByNum.delete(inv.invoice_number);
    } else {
      remaining.push(inv);
    }
  }

  return remaining;
}

async function upsertInvoiceBatch(client, rows) {
  if (!rows.length) return;

  const linkedRows = await linkOrphanInvoices(client, rows);
  const safeRows = await sanitizeInvoiceNumbers(client, linkedRows);
  if (!safeRows.length) return;

  const values = [];
  const params = [];
  safeRows.forEach((inv, index) => {
    const offset = index * 12;
    values.push(
      `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11},$${offset + 12})`
    );
    params.push(
      inv.paypal_invoice_id,
      inv.invoice_number,
      inv.member_id,
      inv.event_id,
      inv.status,
      inv.amount,
      inv.amount_due,
      inv.sent_date,
      inv.paid_date,
      inv.payment_method,
      inv.paypal_link,
      inv.recipient_name
    );
  });

  await client.query(
    `INSERT INTO invoices (
       paypal_invoice_id, invoice_number, member_id, event_id, status,
       amount, amount_due, sent_date, paid_date, payment_method, paypal_link, recipient_name
     ) VALUES ${values.join(', ')}
     ON CONFLICT (paypal_invoice_id) DO UPDATE SET
       invoice_number = CASE
         WHEN EXCLUDED.invoice_number IS NULL THEN invoices.invoice_number
         WHEN invoices.invoice_number = EXCLUDED.invoice_number THEN invoices.invoice_number
         WHEN EXISTS (
           SELECT 1 FROM invoices i2
           WHERE i2.invoice_number = EXCLUDED.invoice_number
             AND i2.paypal_invoice_id IS DISTINCT FROM EXCLUDED.paypal_invoice_id
         ) THEN invoices.invoice_number
         ELSE EXCLUDED.invoice_number
       END,
       member_id = COALESCE(EXCLUDED.member_id, invoices.member_id),
       event_id = COALESCE(EXCLUDED.event_id, invoices.event_id),
       status = CASE
         WHEN EXCLUDED.status IN ('Paid', 'Cancelled') THEN EXCLUDED.status
         WHEN ${SYNC_PROTECT_LOCAL_PAID_SQL} AND EXCLUDED.status = 'Unpaid' THEN invoices.status
         ELSE EXCLUDED.status
       END,
       amount = EXCLUDED.amount,
       amount_due = CASE
         WHEN EXCLUDED.status IN ('Paid', 'Cancelled') THEN EXCLUDED.amount_due
         WHEN ${SYNC_PROTECT_LOCAL_PAID_SQL} AND EXCLUDED.status = 'Unpaid'
           AND LOWER(TRIM(COALESCE(invoices.status, ''))) = 'paid' THEN 0
         ELSE EXCLUDED.amount_due
       END,
       sent_date = COALESCE(EXCLUDED.sent_date, invoices.sent_date),
       paid_date = CASE
         WHEN EXCLUDED.status = 'Paid' THEN COALESCE(EXCLUDED.paid_date, invoices.paid_date)
         WHEN ${SYNC_PROTECT_LOCAL_PAID_SQL} AND EXCLUDED.status = 'Unpaid'
           AND LOWER(TRIM(COALESCE(invoices.status, ''))) = 'paid' THEN invoices.paid_date
         ELSE COALESCE(EXCLUDED.paid_date, invoices.paid_date)
       END,
       payment_method = CASE
         WHEN EXCLUDED.payment_method = 'Zelle & BofA' THEN 'Zelle & BofA'
         WHEN LOWER(COALESCE(invoices.payment_method, '')) IN ('zelle', 'bofa') THEN invoices.payment_method
         WHEN ${SYNC_PROTECT_LOCAL_PAID_SQL} AND EXCLUDED.status = 'Unpaid'
           AND invoices.payment_method IS NOT NULL THEN invoices.payment_method
         WHEN EXCLUDED.payment_method IS NOT NULL THEN EXCLUDED.payment_method
         ELSE invoices.payment_method
       END,
       paypal_link = COALESCE(EXCLUDED.paypal_link, invoices.paypal_link),
       recipient_name = COALESCE(NULLIF(EXCLUDED.recipient_name, ''), invoices.recipient_name),
       updated_at = NOW()`,
    params
  );
}

async function syncInvoicesToDb(paypalItems) {
  const db = getDb();
  const client = await db.connect();
  let synced = 0;
  let unmatched = 0;

  try {
    const membersRes = await client.query(
      'SELECT id, LOWER(email) AS email, LOWER(paypal_name) AS paypal_name FROM members'
    );
    const byEmail = new Map();
    const byPaypal = new Map();
    for (const row of membersRes.rows) {
      if (row.email) byEmail.set(row.email, row.id);
      if (row.paypal_name) byPaypal.set(row.paypal_name, row.id);
    }

    const eventIds = new Map();
    for (const raw of paypalItems) {
      const inv = normalizePaypalInvoice(raw);
      if (!inv.event_number || eventIds.has(inv.event_number)) continue;
      const eventId = await upsertEvent(client, inv.event_number, inv.deceased_name);
      eventIds.set(inv.event_number, eventId);
    }

    const prepared = [];
    const seenPaypalIds = new Set();
    for (const raw of paypalItems) {
      const inv = normalizePaypalInvoice(raw);
      if (!inv.paypal_invoice_id || seenPaypalIds.has(inv.paypal_invoice_id)) continue;
      seenPaypalIds.add(inv.paypal_invoice_id);
      const memberId = findMemberIdFromMaps(inv, byEmail, byPaypal);
      if (!memberId) unmatched += 1;
      const paidDate = inv.status === 'Paid'
        ? (inv.paid_date || new Date().toISOString().slice(0, 10))
        : null;
      prepared.push({
        paypal_invoice_id: inv.paypal_invoice_id,
        invoice_number: inv.invoice_number,
        member_id: memberId,
        event_id: inv.event_number ? eventIds.get(inv.event_number) || null : null,
        status: inv.status,
        amount: inv.amount,
        amount_due: inv.amount_due,
        sent_date: inv.sent_date,
        paid_date: paidDate,
        payment_method: inv.payment_method,
        paypal_link: inv.paypal_link,
        recipient_name: inv.paypal_name || null,
      });
    }

    const BATCH = 40;
    for (let i = 0; i < prepared.length; i += BATCH) {
      await client.query('BEGIN');
      try {
        await upsertInvoiceBatch(client, prepared.slice(i, i + BATCH));
        await client.query('COMMIT');
        synced += Math.min(BATCH, prepared.length - i);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }

  const paid = paypalItems.filter((item) => mapPaypalStatus(item.status) === 'Paid').length;
  const withEvent = paypalItems.filter((item) => extractEventFromItems(item).event_number).length;

  let membership_completed = [];
  try {
    const { processPaidRegistrationInvoices } = require('./membership-completion');
    membership_completed = await processPaidRegistrationInvoices(db, { source: 'PayPal sync' });
  } catch (err) {
    console.error('Registration membership completion after sync failed:', err);
  }

  return {
    ok: true,
    paypal_total: paypalItems.length,
    synced,
    updated: synced,
    created: 0,
    unmatched,
    with_event: withEvent,
    paid_on_paypal: paid,
    unpaid_on_paypal: paypalItems.length - paid,
    membership_completed,
    synced_at: new Date().toISOString(),
  };
}

function verifyCronSecret(event) {
  const secret = process.env.CRON_SECRET || process.env.PAYPAL_CRON_SECRET;
  if (!secret) {
    console.warn('CRON_SECRET not set — cron PayPal sync disabled');
    return false;
  }
  const headers = event.headers || {};
  const provided = headers['x-cron-secret']
    || headers['X-Cron-Secret']
    || event.queryStringParameters?.secret;
  return provided === secret;
}

function getLosAngelesHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      hour12: false,
    }).format(date)
  );
}

/** Full PayPal pull in batches (for cron / CLI — avoids single-request timeouts). */
async function runPayPalSyncFullBatched() {
  const accessToken = await getAccessToken();
  const summaries = await fetchInvoiceSummaries(accessToken);
  const ids = summaries.map((s) => s.id).filter(Boolean);
  if (!ids.length) {
    return {
      ok: true,
      paypal_total: 0,
      synced: 0,
      batches: 0,
      synced_at: new Date().toISOString(),
    };
  }

  const BATCH = 40;
  const aggregate = {
    ok: true,
    paypal_total: ids.length,
    synced: 0,
    unmatched: 0,
    with_event: 0,
    paid_on_paypal: 0,
    unpaid_on_paypal: 0,
    batches: 0,
  };

  for (let i = 0; i < ids.length; i += BATCH) {
    const batchIds = ids.slice(i, i + BATCH);
    const paypalItems = await fetchPaypalDetailsByIds(accessToken, batchIds);
    const result = await syncInvoicesToDb(paypalItems);
    aggregate.synced += result.synced || 0;
    aggregate.unmatched += result.unmatched || 0;
    aggregate.with_event += result.with_event || 0;
    aggregate.paid_on_paypal += result.paid_on_paypal || 0;
    aggregate.unpaid_on_paypal += result.unpaid_on_paypal || 0;
    aggregate.batches += 1;
    console.log(`PayPal sync batch ${aggregate.batches}: ${batchIds.length} invoices`);
  }

  invalidateInvoiceStatsCache();
  aggregate.synced_at = new Date().toISOString();
  return aggregate;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }
  }

  try {
    if (event.httpMethod === 'POST') {
      const admin = verifyAdminRequest(event);
      if (!admin) return json(401, { error: 'Admin authorization required.' });

      const accessToken = await getAccessToken();
      const invoiceIds = Array.isArray(body.invoice_ids)
        ? body.invoice_ids.filter(Boolean)
        : null;
      const paypalItems = invoiceIds?.length
        ? await fetchPaypalDetailsByIds(accessToken, invoiceIds)
        : await fetchAllPaypalInvoices(accessToken);
      const result = await syncInvoicesToDb(paypalItems);
      invalidateInvoiceStatsCache();
      return json(200, {
        ...result,
        batch_size: paypalItems.length,
        mode: invoiceIds?.length ? 'batch' : 'full',
      });
    }

    if (event.httpMethod === 'GET') {
      const query = event.queryStringParameters || {};
      const accessToken = await getAccessToken();
      if (query.balance === '1' || query.balance === 'true') {
        const admin = verifyAdminRequest(event);
        if (!admin) return json(401, { error: 'Admin authorization required.' });
        const balance = await fetchPayPalBalance(accessToken, query.currency || 'USD');
        return json(200, { success: true, ...balance });
      }
      const summaries = await fetchInvoiceSummaries(accessToken);
      const normalized = summaries.map(normalizePaypalInvoice);
      const paid = normalized.filter((inv) => inv.status === 'Paid').length;
      return json(200, {
        success: true,
        count: summaries.length,
        paid,
        unpaid: summaries.length - paid,
        invoice_ids: summaries.map((s) => s.id),
      });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('PayPal sync error:', err);
    if (err.message?.includes('DATABASE_URL')) {
      return json(503, { error: 'Database is not configured.' });
    }
    return json(500, { error: err.message || 'PayPal sync failed.' });
  }
};

exports.runPayPalSyncFullBatched = runPayPalSyncFullBatched;
exports.verifyCronSecret = verifyCronSecret;
exports.getLosAngelesHour = getLosAngelesHour;
exports.normalizePaypalInvoice = normalizePaypalInvoice;
exports.isRegistrationPaypalInvoice = isRegistrationPaypalInvoice;
exports.sanitizeInvoiceNumbers = sanitizeInvoiceNumbers;
exports.syncInvoicesToDb = syncInvoicesToDb;
