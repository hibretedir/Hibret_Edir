const { getDb } = require('./db');
const { toDateOnlyString } = require('./datetime-la');
const { notifyProfileUpdate, notifyBeneficiaryUpdate, notifyBeneficiaryChangeRequested } = require('./notify');
const { getActivityLog, getMemberJourney, logActivity } = require('./audit');
const { getApplicationForMember } = require('./apply');
const {
  syncMemberFromAdminUpdate,
  syncMemberSelfUpdate,
  syncBeneficiaryUpdate,
  syncInvoiceStatusChange,
} = require('./sync');
const {
  verifyAdminRequest,
  verifyMemberRequest,
  buildActorFromAdmin,
  buildActorFromMember,
} = require('./admin-auth');
const {
  loadBoardMemberAccess,
  assertCanWriteAll,
  assertCanApproveOperations,
  assertCanManageBoard,
  assertPerm,
  filterMemberUpdateForAccess,
  isRestrictedMembersOnly,
  isPortalMembersCrmReadRoute,
  WRITE_DENIED_MSG,
} = require('./board-permissions');
const { stampBoardNote, mergeBoardNotes } = require('./board-notes');
const {
  getInvoiceStatsCache,
  setInvoiceStatsCache,
  isInvoiceStatsCacheFresh,
  invalidateInvoiceStatsCache,
} = require('./invoice-stats-cache');
const { ZELLE_BOFA_SQL, outstandingInvoiceSql, unpaidOnlyInvoiceSql, partialOnlyInvoiceSql } = require('./payment-methods');
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(payload)
  };
}

function getPath(event) {
  const basePath = '/.netlify/functions/portal';
  const candidates = [event.path, event.rawUrl, event.rawPath].filter(Boolean);
  for (const raw of candidates) {
    const p = String(raw).split('?')[0].replace(/\/+$/, '') || '/';
    if (p.startsWith(basePath)) {
      const sub = p.slice(basePath.length) || '/';
      return sub === '' ? '/' : sub;
    }
  }
  const fallback = String(event.path || '/').split('?')[0].replace(/\/+$/, '') || '/';
  return fallback === '' ? '/' : fallback;
}

function normalizePhone(phone) {
  if (!phone) return null;
  return phone.toString().replace(/\D/g, '').slice(-10);
}

function parseBearerToken(authorizationHeader) {
  if (!authorizationHeader) return null;
  const parts = authorizationHeader.split(' ');
  if (parts[0] !== 'Bearer' || !parts[1]) return null;
  return parts[1];
}

async function resolveAdminActor(adminPayload) {
  if (!adminPayload?.adminId) {
    return buildActorFromAdmin(adminPayload, null);
  }
  const db = getDb();
  const result = await db.query(
    `SELECT id, email FROM board_members WHERE id = $1 LIMIT 1`,
    [adminPayload.adminId]
  );
  return buildActorFromAdmin(adminPayload, result.rows[0]);
}

function isLegacyDateInAddressField(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  return /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/.test(s);
}

function normalizePortalAddress(value) {
  if (isLegacyDateInAddressField(value)) return '';
  return String(value || '').trim();
}

function buildMemberPayload(member) {
  return {
    id: member.id,
    member_number: member.member_number,
    first: member.first_name,
    last: member.last_name,
    full_name: member.full_name || `${member.first_name || ''} ${member.last_name || ''}`.trim(),
    spouse_name: member.spouse_name || '',
    paypal_name: member.paypal_name,
    email: member.email,
    mobile: member.mobile,
    home: member.home_phone,
    address: normalizePortalAddress(member.address),
    status: member.status,
    joined_date: member.joined_date,
    notes: member.notes != null ? member.notes : '',
    application_drive_url: member.application_drive_url || '',
    created_at: member.created_at,
    updated_at: member.updated_at
  };
}

async function findMember({ phone, email, id }) {
  const db = getDb();
  const normalizedPhone = normalizePhone(phone);

  const conditions = [];
  const values = [];
  let index = 1;

  if (normalizedPhone) {
    conditions.push(`regexp_replace(mobile, '\\D', '', 'g') = $${index}`);
    values.push(normalizedPhone);
    index += 1;
    conditions.push(`regexp_replace(home_phone, '\\D', '', 'g') = $${index}`);
    values.push(normalizedPhone);
    index += 1;
  }

  if (email) {
    conditions.push(`LOWER(email) = LOWER($${index})`);
    values.push(email);
    index += 1;
  }

  if (id) {
    conditions.push(`id = $${index}`);
    values.push(id);
    index += 1;
  }

  if (!conditions.length) {
    return null;
  }

  const sql = `SELECT id, member_number, first_name, last_name, full_name, spouse_name, paypal_name, email, mobile, home_phone, address, status, joined_date, created_at, updated_at, notes, application_drive_url
               FROM members
               WHERE ${conditions.join(' OR ')}
               LIMIT 1`;

  const result = await db.query(sql, values);
  return result.rows[0] ? buildMemberPayload(result.rows[0]) : null;
}

/** Names used to match PayPal recipient_name when member_id was linked incorrectly. */
function collectMemberInvoiceNames(member) {
  const names = new Set();
  const add = (value) => {
    const trimmed = String(value || '').trim();
    if (trimmed) names.add(trimmed);
  };
  if (!member) return [];
  add(member.paypal_name);
  add(member.spouse_name);
  add(member.full_name);
  if (member.full_name && String(member.full_name).includes('/')) {
    for (const part of String(member.full_name).split('/')) add(part);
  }
  add([member.first_name, member.last_name].filter(Boolean).join(' '));
  return [...names];
}

async function getInvoices({ memberId, email, status, outstanding, limit = 500, activeOnly = false }) {
  const db = getDb();
  const values = [];
  const filters = ['invoices.invoice_number IS NOT NULL'];
  let idx = 1;
  const rowLimit = Math.min(Math.max(Number(limit) || 500, 1), 2500);

  if (memberId) {
    const memberRow = await fetchMemberRow(memberId);
    const matchNames = collectMemberInvoiceNames(memberRow);
    if (matchNames.length) {
      filters.push(`(
        invoices.member_id = $${idx}
        OR (
          NULLIF(TRIM(invoices.recipient_name), '') IS NOT NULL
          AND TRIM(invoices.recipient_name) ILIKE ANY($${idx + 1}::text[])
        )
      )`);
      values.push(memberId, matchNames);
      idx += 2;
    } else {
      filters.push(`invoices.member_id = $${idx}`);
      values.push(memberId);
      idx += 1;
    }
  }

  if (email) {
    filters.push(`LOWER(members.email) = LOWER($${idx})`);
    values.push(email);
    idx += 1;
  }

  if (status) {
    filters.push(`LOWER(invoices.status) = LOWER($${idx})`);
    values.push(status);
    idx += 1;
  } else if (outstanding) {
    filters.push(outstandingInvoiceSql('invoices.status'));
  }

  if (activeOnly) {
    filters.push(`LOWER(COALESCE(members.status, '')) = 'active'`);
  }

  const sql = `
    SELECT
      invoices.id,
      invoices.invoice_number,
      invoices.paypal_invoice_id AS paypal_id,
      invoices.status,
      invoices.amount,
      invoices.amount_due,
      invoices.sent_date AS date,
      invoices.paid_date,
      invoices.payment_method,
      invoices.paypal_link,
      invoices.paid_note,
      events.event_number,
      COALESCE(events.deceased_name, '') AS deceased_name,
      COALESCE(events.deceased_name, '') AS item,
      invoices.recipient_name,
      invoices.member_id,
      members.paypal_name AS member_paypal_name,
      members.full_name AS member_full_name,
      members.email AS member_email,
      members.status AS member_status
    FROM invoices
    LEFT JOIN events ON invoices.event_id = events.id
    LEFT JOIN members ON invoices.member_id = members.id
    WHERE ${filters.join(' AND ')}
    ORDER BY invoices.sent_date DESC NULLS LAST, invoices.invoice_number DESC
    LIMIT $${idx}
  `;
  values.push(rowLimit);

  const result = await db.query(sql, values);
  return result.rows.map(buildInvoicePayload);
}

async function getInvoiceStats() {
  if (isInvoiceStatsCacheFresh()) {
    return getInvoiceStatsCache().data;
  }
  const db = getDb();
  const [result, activeResult, syncResult, eventSummaryResult] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*) FILTER (WHERE LOWER(COALESCE(members.status, '')) = 'active')::int AS total,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(invoices.status, '')) = 'paid'
            AND LOWER(COALESCE(members.status, '')) = 'active'
        )::int AS paid,
        COUNT(*) FILTER (
          WHERE ${unpaidOnlyInvoiceSql('invoices.status')}
            AND LOWER(COALESCE(members.status, '')) = 'active'
        )::int AS unpaid_active,
        COUNT(*) FILTER (
          WHERE ${partialOnlyInvoiceSql('invoices.status')}
            AND LOWER(COALESCE(members.status, '')) = 'active'
        )::int AS partial_active,
        COUNT(*) FILTER (
          WHERE ${unpaidOnlyInvoiceSql('invoices.status')}
            AND LOWER(COALESCE(members.status, '')) = 'active'
            AND invoices.sent_date IS NOT NULL
            AND invoices.sent_date < (CURRENT_DATE - INTERVAL '45 days')
        )::int AS late_active,
        COUNT(*) FILTER (
        WHERE LOWER(COALESCE(invoices.status, '')) = 'paid'
          AND LOWER(COALESCE(members.status, '')) = 'active'
          AND ${ZELLE_BOFA_SQL}
      )::int AS paid_zelle_bofa,
      COUNT(*) FILTER (
        WHERE LOWER(COALESCE(invoices.status, '')) = 'paid'
          AND LOWER(COALESCE(members.status, '')) = 'active'
          AND NOT ${ZELLE_BOFA_SQL}
      )::int AS paid_paypal,
      COALESCE(SUM(invoices.amount_due) FILTER (
          WHERE ${outstandingInvoiceSql('invoices.status')}
            AND LOWER(COALESCE(members.status, '')) = 'active'
        ), 0)::float AS total_owed,
      COALESCE(SUM(invoices.amount_due) FILTER (
          WHERE ${partialOnlyInvoiceSql('invoices.status')}
            AND LOWER(COALESCE(members.status, '')) = 'active'
        ), 0)::float AS partial_owed,
        (SELECT COUNT(*)::int FROM events e
          WHERE e.deceased_name IS NOT NULL AND TRIM(e.deceased_name) <> '') AS events
      FROM invoices
      LEFT JOIN members ON invoices.member_id = members.id
      LEFT JOIN events ON invoices.event_id = events.id
      WHERE invoices.invoice_number IS NOT NULL
    `),
    db.query(`
      SELECT COUNT(*)::int AS active_members
      FROM members
      WHERE LOWER(COALESCE(status, '')) = 'active'
    `),
    db.query(`
      SELECT GREATEST(
        COALESCE(
          (SELECT MAX(created_at) FROM audit_log WHERE action = 'paypal_sync'),
          'epoch'::timestamptz
        ),
        COALESCE(
          (SELECT MAX(updated_at) FROM invoices WHERE paypal_invoice_id IS NOT NULL),
          'epoch'::timestamptz
        )
      ) AS paypal_last_sync_at
    `),
    db.query(`
      SELECT e.id, e.event_number, e.deceased_name, e.event_date,
             COUNT(i.id) FILTER (
               WHERE i.invoice_number IS NOT NULL
                 AND LOWER(COALESCE(m.status, '')) = 'active'
             )::int AS total,
             COUNT(i.id) FILTER (
               WHERE i.invoice_number IS NOT NULL
                 AND LOWER(COALESCE(m.status, '')) = 'active'
                 AND ${outstandingInvoiceSql('i.status')}
             )::int AS unpaid,
             COALESCE(SUM(i.amount_due) FILTER (
               WHERE i.invoice_number IS NOT NULL
                 AND LOWER(COALESCE(m.status, '')) = 'active'
                 AND ${outstandingInvoiceSql('i.status')}
             ), 0)::float AS amount_owed,
             COALESCE(
               e.event_date,
               MIN(i.sent_date) FILTER (WHERE i.sent_date IS NOT NULL)
             ) AS memorial_date
      FROM events e
      LEFT JOIN invoices i ON i.event_id = e.id
      LEFT JOIN members m ON i.member_id = m.id
      WHERE e.deceased_name IS NOT NULL AND TRIM(e.deceased_name) <> ''
      GROUP BY e.id, e.event_number, e.deceased_name, e.event_date
      ORDER BY e.event_number DESC NULLS LAST, memorial_date DESC NULLS LAST
    `),
  ]);
  const row = result.rows[0] || {};
  const syncAt = syncResult.rows[0]?.paypal_last_sync_at;
  const stats = {
    total: Number(row.total || 0),
    paid: Number(row.paid || 0),
    paid_paypal: Number(row.paid_paypal || 0),
    paid_zelle_bofa: Number(row.paid_zelle_bofa || 0),
    unpaid_active: Number(row.unpaid_active || 0),
    partial_active: Number(row.partial_active || 0),
    partial_owed: Number(row.partial_owed || 0),
    late_active: Number(row.late_active || 0),
    total_owed: Number(row.total_owed || 0),
    events: Number(row.events || 0),
    active_members: Number(activeResult.rows[0]?.active_members || 0),
    event_summary: (eventSummaryResult.rows || []).map(mapEventSummaryRow),
    paypal_last_sync_at: syncAt && String(syncAt) !== '1970-01-01T00:00:00.000Z'
      ? new Date(syncAt).toISOString()
      : null,
  };
  setInvoiceStatsCache(stats);
  return stats;
}

function buildInvoicePayload(row) {
  const invoiceName = row.recipient_name
    || row.member_paypal_name
    || row.member_full_name
    || '';
  const dateStr = toDateOnlyString(row.date) || null;
  const daysSinceSent = invoiceDaysSinceSent(dateStr, row.status);
  const daysOverdue = computeDaysPastDue(dateStr, row.status);
  return {
    id: row.id,
    invoice_num: row.invoice_number,
    paypal_id: row.paypal_id,
    status: row.status,
    total: Number(row.amount),
    amount_due: Number(row.amount_due),
    date: dateStr,
    item: row.item || row.deceased_name || '',
    deceased_name: row.deceased_name || row.item || '',
    event_number: row.event_number != null ? Number(row.event_number) : null,
    event_id: row.event_id != null ? Number(row.event_id) : null,
    payment_method: row.payment_method,
    paypal_link: row.paypal_link,
    member_email: row.member_email,
    member_full_name: row.member_full_name,
    member_paypal_name: row.member_paypal_name,
    member_id: row.member_id,
    member_status: row.member_status || null,
    recipient_name: row.recipient_name,
    paid_note: row.paid_note || null,
    name: invoiceName,
    email: row.member_email,
    days_since_sent: daysSinceSent,
    days_overdue: daysOverdue,
    is_late: daysSinceSent > INVOICE_LATE_DAYS && String(row.status || '').toLowerCase().trim() === 'unpaid',
  };
}

const INVOICE_DUE_DAYS = 3;
const INVOICE_LATE_DAYS = 45;

function invoiceEventGroupKey(row) {
  const evNum = row.event_number != null ? Number(row.event_number) : null;
  if (evNum != null) return `ev:${evNum}`;
  const name = String(row.deceased_name || row.item || '').trim().toLowerCase();
  if (name) return `name:${name}`;
  return `inv:${row.invoice_number || row.id}`;
}

function pickPreferredMemberInvoice(existing, candidate) {
  if (!existing) return candidate;
  const existPaid = String(existing.status || '').toLowerCase() === 'paid';
  const candPaid = String(candidate.status || '').toLowerCase() === 'paid';
  if (candPaid && !existPaid) return candidate;
  if (existPaid && !candPaid) return existing;
  const existNum = Number(existing.invoice_number || existing.invoice_num || 0);
  const candNum = Number(candidate.invoice_number || candidate.invoice_num || 0);
  return candNum >= existNum ? candidate : existing;
}

function dedupeInvoicesByEvent(invoices) {
  const byEvent = new Map();
  for (const inv of invoices || []) {
    const key = invoiceEventGroupKey(inv);
    byEvent.set(key, pickPreferredMemberInvoice(byEvent.get(key), inv));
  }
  return Array.from(byEvent.values()).sort((a, b) => {
    const nA = Number(a.invoice_num || a.invoice_number || 0);
    const nB = Number(b.invoice_num || b.invoice_number || 0);
    return nB - nA;
  });
}

function isClosedInvoiceStatus(status) {
  const s = String(status || '').toLowerCase().trim();
  if (s === 'paid') return true;
  if (s.includes('partial')) return false;
  if (s.includes('cancel') || s === 'refunded' || s === 'refund') return true;
  return false;
}

function invoiceDaysSinceSent(dateStr, status) {
  if (!dateStr || isClosedInvoiceStatus(status)) return 0;
  const sent = new Date(String(dateStr).split(' ')[0]);
  if (Number.isNaN(sent.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - sent.getTime()) / 86400000));
}

function computeDaysPastDue(dateStr, status) {
  return Math.max(0, invoiceDaysSinceSent(dateStr, status) - INVOICE_DUE_DAYS);
}

async function updateMember(data, actor) {
  const db = getDb();
  if (!data?.id) return null;

  const oldRes = await db.query(
    `SELECT id, member_number, first_name, last_name, full_name, spouse_name, paypal_name, email, mobile, home_phone, address, status, joined_date, created_at, updated_at, notes, application_drive_url
     FROM members WHERE id = $1`,
    [data.id]
  );
  const oldRow = oldRes.rows[0];
  if (!oldRow) return null;

  const fieldMap = {
    first: 'first_name',
    last: 'last_name',
    full_name: 'full_name',
    spouse_name: 'spouse_name',
    home: 'home_phone',
    mobile: 'mobile',
    email: 'email',
    address: 'address',
    paypal_name: 'paypal_name',
    notes: 'notes',
    application_drive_url: 'application_drive_url',
    status: 'status'
  };

  const fields = [];
  const values = [];
  let idx = 1;
  for (const key of Object.keys(fieldMap)) {
    if (data[key] !== undefined) {
      fields.push(`${fieldMap[key]} = $${idx}`);
      let value = key === 'email' ? String(data[key]).trim().toLowerCase() : data[key];
      if (key === 'application_drive_url') {
        value = String(value || '').trim() || null;
      }
      if (key === 'spouse_name') {
        value = String(value || '').trim() || null;
      }
      if (key === 'notes' && actor) {
        value = mergeBoardNotes(oldRow.notes, value, actor.actor_label);
      }
      values.push(value);
      idx += 1;
    }
  }

  if (!fields.length) return buildMemberPayload(oldRow);
  fields.push(`updated_at = NOW()`);
  values.push(data.id);

  const result = await db.query(
    `UPDATE members SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, member_number, first_name, last_name, full_name, spouse_name, paypal_name, email, mobile, home_phone, address, status, joined_date, created_at, updated_at, notes, application_drive_url`,
    values
  );
  const newRow = result.rows[0];
  invalidateInvoiceStatsCache();
  if (actor) {
    try {
      await syncMemberFromAdminUpdate(db, data.id, oldRow, newRow, actor);
    } catch (err) {
      console.error('Member sync failed:', err);
    }
  }
  return result.rows[0] ? buildMemberPayload(result.rows[0]) : null;
}

async function updateInvoice(data, actor) {
  const db = getDb();
  const updates = [];
  const values = [];
  let idx = 1;

  if (data.status !== undefined) {
    updates.push(`status = $${idx}`);
    values.push(data.status);
    idx += 1;
  }
  if (data.paid_date !== undefined) {
    updates.push(`paid_date = $${idx}`);
    values.push(data.paid_date);
    idx += 1;
  }
  if (data.paid_note !== undefined) {
    updates.push(`paid_note = $${idx}`);
    values.push(data.paid_note);
    idx += 1;
  }
  if (data.payment_method !== undefined) {
    updates.push(`payment_method = $${idx}`);
    values.push(data.payment_method);
    idx += 1;
  }

  if (!updates.length) return null;
  if (data.status === 'Paid') {
    const note = String(data.paid_note || '').trim();
    if (!note) {
      throw new Error('A reason note is required when marking an invoice as paid');
    }
    if (data.paid_date === undefined) {
      updates.push('paid_date = NOW()');
    }
  }

  let lookupColumn;
  let lookupValue;
  if (data.invoice_num !== undefined) {
    lookupColumn = 'invoice_number';
    lookupValue = data.invoice_num;
  } else if (data.id !== undefined) {
    lookupColumn = 'id';
    lookupValue = data.id;
  } else {
    return null;
  }

  const existing = await db.query(
    `SELECT id, invoice_number, status, member_id, sent_date FROM invoices WHERE ${lookupColumn} = $1`,
    [lookupValue]
  );
  const oldInvoice = existing.rows[0];

  if (data.status === 'Paid' && oldInvoice) {
    const prior = String(oldInvoice.status || '').toLowerCase();
    if (prior.includes('cancel')) {
      throw new Error('This invoice was cancelled by the member and cannot be marked paid.');
    }
  }

  updates.push('updated_at = NOW()');
  const whereParam = idx;
  values.push(lookupValue);

  const result = await db.query(
    `UPDATE invoices SET ${updates.join(', ')} WHERE ${lookupColumn} = $${whereParam} RETURNING id, invoice_number, paypal_invoice_id AS paypal_id, status, amount, amount_due, sent_date AS date, paid_date, payment_method, paypal_link, event_id, member_id, recipient_name, paid_note`,
    values
  );
  if (!result.rows[0]) return null;
  invalidateInvoiceStatsCache();

  if (actor && oldInvoice && data.status !== undefined) {
    try {
      await syncInvoiceStatusChange(db, result.rows[0], oldInvoice.status, data.status, actor, oldInvoice.member_id, {
        paid_note: data.paid_note,
      });
    } catch (err) {
      console.error('Invoice sync failed:', err);
    }
  }

  const joined = await db.query(
    `SELECT events.event_number,
            COALESCE(events.deceased_name, '') AS deceased_name,
            COALESCE(events.deceased_name, '') AS item,
            invoices.recipient_name,
            members.paypal_name AS member_paypal_name,
            members.full_name AS member_full_name,
            members.email AS member_email
     FROM invoices
     LEFT JOIN events ON invoices.event_id = events.id
     LEFT JOIN members ON invoices.member_id = members.id
     WHERE invoices.id = $1`,
    [result.rows[0].id]
  );

  return buildInvoicePayload({ ...result.rows[0], ...joined.rows[0] });
}

async function getMembers({ search, limit = 500 }) {
  const db = getDb();
  const values = [];
  let sql = `SELECT id, member_number, first_name, last_name, full_name, spouse_name, paypal_name, email, mobile, home_phone AS home, address, status, joined_date, created_at, updated_at FROM members`;

  if (search) {
    const normalizedSearch = search.replace(/\D/g, '');
    const parts = search.split(/\s+/).filter(Boolean);
    const likeSearch = `%${search.toLowerCase()}%`;
    const clauses = [
      `LOWER(full_name) LIKE $1`,
      `LOWER(spouse_name) LIKE $1`,
      `LOWER(first_name) LIKE $1`,
      `LOWER(last_name) LIKE $1`,
      `LOWER(email) LIKE $1`,
      `LOWER(paypal_name) LIKE $1`
    ];
    values.push(likeSearch);
    let idx = 2;
    if (normalizedSearch) {
      clauses.push(`regexp_replace(mobile, '\\D', '', 'g') LIKE $${idx}`);
      values.push(`%${normalizedSearch}%`);
      idx += 1;
      clauses.push(`regexp_replace(home_phone, '\\D', '', 'g') LIKE $${idx}`);
      values.push(`%${normalizedSearch}%`);
    }
    sql += ` WHERE (${clauses.join(' OR ')})`;
  }

  sql += ` ORDER BY member_number ASC NULLS LAST, id ASC LIMIT $${values.length + 1}`;
  values.push(limit);

  const result = await db.query(sql, values);
  return result.rows.map((row) => {
    const payload = buildMemberPayload(row);
    payload.notes = '';
    return payload;
  });
}

const MEMBER_EDIT_FIELDS = {
  mobile: 'mobile',
  home: 'home_phone',
  email: 'email',
  address: 'address',
};

const FIELD_LABELS = {
  mobile: 'Mobile',
  home: 'Home Phone',
  email: 'Email',
  address: 'Address',
};

async function fetchMemberRow(id) {
  const db = getDb();
  const result = await db.query(
    `SELECT id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone, address, status, joined_date, created_at, updated_at, notes, application_drive_url
     FROM members WHERE id = $1 LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

async function beneficiaryImportPending(db, memberId, member) {
  if (!member) return false;
  const ben = await db.query(
    `SELECT 1 FROM beneficiaries WHERE member_id = $1 AND is_primary = true LIMIT 1`,
    [memberId]
  );
  if (ben.rows.length) return false;

  if (String(member.application_drive_url || '').trim()) return true;

  const app = await db.query(
    `SELECT id FROM membership_applications WHERE member_id = $1 LIMIT 1`,
    [memberId]
  );
  if (app.rows.length) return true;

  return member.member_number != null && String(member.status || '').toLowerCase() === 'active';
}

async function getMemberProfile(memberId) {
  const member = await fetchMemberRow(memberId);
  if (!member) return null;
  const db = getDb();
  const ben = await db.query(
    `SELECT id, name, phone, relationship, is_primary
     FROM beneficiaries
     WHERE member_id = $1 AND is_primary = true
     ORDER BY id DESC LIMIT 1`,
    [memberId]
  );
  let pendingBeneficiaryChange = null;
  try {
    const pending = await db.query(
      `SELECT id, payload, previous_payload, submitted_at, status
       FROM member_change_requests
       WHERE member_id = $1 AND request_type = 'beneficiary' AND status IN ('Pending', 'Under Review')
       ORDER BY submitted_at DESC LIMIT 1`,
      [memberId]
    );
    if (pending.rows[0]) {
      pendingBeneficiaryChange = {
        id: pending.rows[0].id,
        payload: pending.rows[0].payload,
        submitted_at: pending.rows[0].submitted_at,
        status: pending.rows[0].status,
      };
    }
  } catch (err) {
    console.warn('Pending beneficiary lookup skipped:', err.message);
  }
  return {
    member: buildMemberPayload(member),
    beneficiary: ben.rows[0] || null,
    pending_beneficiary_change: pendingBeneficiaryChange,
    beneficiary_import_pending: await beneficiaryImportPending(db, memberId, member),
  };
}

async function getMemberBoardMessages(memberId) {
  const db = getDb();
  const member = await fetchMemberRow(memberId);
  if (!member) return [];
  const phoneNorm = member.mobile ? String(member.mobile).replace(/\D/g, '').slice(-10) : null;
  const homeNorm = member.home_phone ? String(member.home_phone).replace(/\D/g, '').slice(-10) : null;
  const emailNorm = member.email ? String(member.email).trim().toLowerCase() : null;
  try {
    const result = await db.query(
      `SELECT cm.id, cm.message, cm.board_reply, cm.source, cm.status, cm.created_at, cm.replied_at
       FROM contact_messages cm
       WHERE cm.member_id = $1
          OR ($2::text IS NOT NULL AND LOWER(TRIM(cm.email)) = $2)
          OR ($3::text IS NOT NULL AND RIGHT(regexp_replace(COALESCE(cm.phone, ''), '\\D', '', 'g'), 10) = $3)
          OR ($4::text IS NOT NULL AND RIGHT(regexp_replace(COALESCE(cm.phone, ''), '\\D', '', 'g'), 10) = $4)
       ORDER BY cm.created_at DESC NULLS LAST, cm.id DESC
       LIMIT 50`,
      [memberId, emailNorm, phoneNorm, homeNorm]
    );
    return result.rows.map((row) => ({
      id: row.id,
      message: row.message,
      board_reply: row.board_reply,
      source: row.source,
      status: row.status,
      created_at: row.created_at,
      replied_at: row.replied_at,
    }));
  } catch (err) {
    console.warn('Member board messages lookup skipped:', err.message);
    return [];
  }
}

async function patchMemberProfile(memberId, body, actor) {
  const old = await fetchMemberRow(memberId);
  if (!old) return null;

  const changes = {};
  const updates = [];
  const values = [];
  let idx = 1;

  for (const [key, col] of Object.entries(MEMBER_EDIT_FIELDS)) {
    if (body[key] === undefined) continue;
    const newVal = String(body[key]).trim();
    const oldVal = old[col] || '';
    if (newVal === oldVal) continue;
    changes[FIELD_LABELS[key] || key] = { from: oldVal || '(empty)', to: newVal || '(empty)' };
    updates.push(`${col} = $${idx}`);
    values.push(key === 'email' ? newVal.toLowerCase() : newVal);
    idx += 1;
  }

  if (!updates.length) {
    return { member: buildMemberPayload(old), message: 'No changes.' };
  }

  updates.push('updated_at = NOW()');
  values.push(memberId);
  const db = getDb();
  const result = await db.query(
    `UPDATE members SET ${updates.join(', ')}
     WHERE id = $${idx}
     RETURNING id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone, address, status, joined_date, created_at, updated_at, notes`,
    values
  );
  const updated = result.rows[0];

  if (actor) {
    try {
      await syncMemberSelfUpdate(db, memberId, old, updated, actor, changes);
    } catch (err) {
      console.error('Profile sync failed:', err);
    }
  }

  try {
    await notifyProfileUpdate(db, updated, changes);
  } catch (err) {
    console.error('Profile update notification failed:', err);
  }

  return { member: buildMemberPayload(updated), changes };
}

async function upsertMemberBeneficiary(memberId, body, actor, { requireApproval = true } = {}) {
  const name = body.name?.trim();
  const phone = body.phone?.trim();
  const relationship = body.relationship?.trim();
  if (!name || !phone || !relationship) {
    return { error: 'Name, phone, and relationship are required.', status: 400 };
  }

  const member = await fetchMemberRow(memberId);
  if (!member) return { error: 'Member not found.', status: 404 };

  const db = getDb();
  const existing = await db.query(
    `SELECT id, name, phone, relationship FROM beneficiaries WHERE member_id = $1 AND is_primary = true LIMIT 1`,
    [memberId]
  );
  const beneficiary = { name, phone, relationship };
  const isNew = !existing.rows.length;
  const previous = existing.rows[0]
    ? { name: existing.rows[0].name, phone: existing.rows[0].phone, relationship: existing.rows[0].relationship }
    : null;

  if (requireApproval && actor?.actor_type === 'member') {
    await db.query(
      `UPDATE member_change_requests
       SET status = 'Rejected', notes = COALESCE(notes, '') || ' Superseded.', reviewed_at = NOW()
       WHERE member_id = $1 AND request_type = 'beneficiary' AND status IN ('Pending', 'Under Review')`,
      [memberId]
    );
    const insert = await db.query(
      `INSERT INTO member_change_requests (member_id, request_type, payload, previous_payload, status)
       VALUES ($1, 'beneficiary', $2::jsonb, $3::jsonb, 'Pending')
       RETURNING id, submitted_at`,
      [memberId, JSON.stringify(beneficiary), JSON.stringify(previous)]
    );
    if (actor) {
      try {
        await syncBeneficiaryUpdate(db, memberId, beneficiary, isNew, actor, { pending: true, requestId: insert.rows[0].id });
      } catch (err) {
        console.error('Beneficiary change request sync failed:', err);
      }
    }
    try {
      const { notifyBoard } = require('./notify');
      const memberName = member.full_name || `${member.first_name || ''} ${member.last_name || ''}`.trim();
      await notifyBoard({
        db,
        subject: `Hibret Edir — beneficiary change pending approval: ${memberName}`,
        text: `Member ${memberName} (#${member.member_number || member.id}) ${isNew ? 'requested to add' : 'requested to update'} a beneficiary:\n\nName: ${name}\nRelationship: ${relationship}\nPhone: ${phone}\n\nReview in Admin → Approval.`,
      });
      await notifyBeneficiaryChangeRequested(db, member, beneficiary, isNew, previous);
    } catch (err) {
      console.error('Beneficiary request notification failed:', err);
    }
    return {
      pending: true,
      request_id: insert.rows[0].id,
      message: 'Beneficiary change submitted for board approval.',
    };
  }

  if (isNew) {
    await db.query(
      `INSERT INTO beneficiaries (member_id, name, phone, relationship, is_primary)
       VALUES ($1, $2, $3, $4, true)`,
      [memberId, name, phone, relationship]
    );
  } else {
    await db.query(
      `UPDATE beneficiaries SET name = $1, phone = $2, relationship = $3 WHERE id = $4`,
      [name, phone, relationship, existing.rows[0].id]
    );
  }

  if (actor) {
    try {
      await syncBeneficiaryUpdate(db, memberId, beneficiary, isNew, actor);
    } catch (err) {
      console.error('Beneficiary sync failed:', err);
    }
  }

  try {
    await notifyBeneficiaryUpdate(db, member, beneficiary, isNew);
  } catch (err) {
    console.error('Beneficiary notification failed:', err);
  }

  return { beneficiary, message: isNew ? 'Beneficiary added.' : 'Beneficiary updated.' };
}

function formatDeceasedMemberLabel(eventNumber, deceasedName) {
  const name = String(deceasedName || '').trim();
  if (!name) return '';
  return eventNumber != null && eventNumber !== '' ? `#${eventNumber} ${name}` : name;
}

function mapDeceasedMemberRow(row) {
  const name = String(row.deceased_name || '').trim();
  const eventNumber = row.event_number;
  const dateStr = toDateOnlyString(row.memorial_date || row.event_date || null);
  const yearMatch = dateStr.match(/^(\d{4})/);
  return {
    id: row.id,
    event_number: eventNumber,
    deceased_name: name,
    name,
    label: formatDeceasedMemberLabel(eventNumber, name),
    date: dateStr || null,
    year: yearMatch ? yearMatch[1] : null,
    status: row.status,
  };
}

function mapEventSummaryRow(row) {
  const mapped = mapDeceasedMemberRow(row);
  return {
    ...mapped,
    total: Number(row.total || 0),
    unpaid: Number(row.unpaid || 0),
    amount_owed: Number(row.amount_owed || 0),
  };
}

/** Deceased-member list for admin Invoices filter and Event Summary. */
async function getDeceasedMembers() {
  const db = getDb();
  const result = await db.query(
    `SELECT e.id, e.event_number, e.deceased_name, e.event_date, e.status,
            COALESCE(
              e.event_date,
              (SELECT MIN(i.sent_date) FROM invoices i
               WHERE i.event_id = e.id AND i.sent_date IS NOT NULL)
            ) AS memorial_date
     FROM events e
     WHERE e.deceased_name IS NOT NULL AND TRIM(e.deceased_name) <> ''
     ORDER BY e.event_number DESC NULLS LAST, memorial_date DESC NULLS LAST`
  );
  return result.rows.map(mapDeceasedMemberRow);
}

async function getEdirEvents() {
  return getDeceasedMembers();
}

const MEMBER_CAP = Number(process.env.MEMBER_CAP || 200);

async function getPublicMemberStats() {
  const db = getDb();
  const result = await db.query(`
    SELECT
      COUNT(*)::int AS total_count,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'active')::int AS active_count,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) != 'active')::int AS inactive_count
    FROM members
  `);
  const row = result.rows[0] || {};
  return {
    active_count: row.active_count || 0,
    total_count: row.total_count || 0,
    inactive_count: row.inactive_count || 0,
    member_cap: MEMBER_CAP,
    updated_at: new Date().toISOString(),
  };
}

const MARK_PAID_REQUEST_SELECT = `
  SELECT r.*,
    i.recipient_name, i.amount_due, i.status AS invoice_status,
    e.deceased_name, e.event_number,
    m.first_name, m.last_name, m.full_name, m.paypal_name, m.email, m.member_number
  FROM invoice_mark_paid_requests r
  JOIN invoices i ON i.id = r.invoice_id
  LEFT JOIN events e ON e.id = i.event_id
  LEFT JOIN members m ON m.id = r.member_id
`;

function buildMarkPaidRequestSummary(row) {
  const memberName = row.recipient_name
    || row.full_name
    || `${row.first_name || ''} ${row.last_name || ''}`.trim()
    || row.paypal_name
    || 'Member';
  return {
    id: `mp-${row.id}`,
    mark_paid_request_id: row.id,
    kind: 'mark_paid',
    status: row.status,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    member_id: row.member_id,
    member_full_name: memberName,
    email: row.email,
    invoice_num: row.invoice_number,
    invoice_id: row.invoice_id,
    amount_due: row.amount_due != null ? Number(row.amount_due) : null,
    deceased_name: row.deceased_name || null,
    event_number: row.event_number != null ? Number(row.event_number) : null,
    reason: row.reason,
    requested_by: row.requested_by_label,
    requested_by_admin_id: row.requested_by_admin_id,
    reviewed_by: row.reviewed_by_label,
    notes: row.review_notes,
  };
}

async function listMarkPaidRequests(query = {}) {
  const db = getDb();
  const values = [];
  let sql = MARK_PAID_REQUEST_SELECT;
  if (query.status) {
    sql += ` WHERE r.status = $1`;
    values.push(query.status);
  }
  sql += ` ORDER BY r.submitted_at DESC NULLS LAST, r.id DESC LIMIT 200`;
  const result = await db.query(sql, values);
  return result.rows.map(buildMarkPaidRequestSummary);
}

async function getMarkPaidRequestRow(id) {
  const db = getDb();
  const result = await db.query(`${MARK_PAID_REQUEST_SELECT} WHERE r.id = $1 LIMIT 1`, [id]);
  return result.rows[0] || null;
}

function isClosedInvoiceStatusForMarkPaid(status) {
  const s = String(status || '').toLowerCase().trim();
  if (s === 'paid') return true;
  if (s.includes('cancel') || s === 'refunded' || s === 'refund') return true;
  return false;
}

async function createMarkPaidRequest(data, actor, adminPayload) {
  const note = stampBoardNote(data.paid_note || data.reason, actor.actor_label);
  if (!note) {
    throw new Error('A reason is required when requesting mark paid');
  }
  const invoiceNum = Number(data.invoice_num);
  if (!invoiceNum) {
    throw new Error('invoice_num is required');
  }

  const db = getDb();
  const invRes = await db.query(
    `SELECT id, invoice_number, status, member_id FROM invoices WHERE invoice_number = $1 LIMIT 1`,
    [invoiceNum]
  );
  const inv = invRes.rows[0];
  if (!inv) {
    throw new Error('Invoice not found');
  }
  if (isClosedInvoiceStatusForMarkPaid(inv.status)) {
    throw new Error('This invoice cannot be marked paid');
  }

  const pending = await db.query(
    `SELECT id FROM invoice_mark_paid_requests WHERE invoice_id = $1 AND status = 'Pending' LIMIT 1`,
    [inv.id]
  );
  if (pending.rows.length) {
    throw new Error('This invoice already has a pending mark-paid request — check Admin → Approval');
  }

  const requesterLabel = (adminPayload?.bypass && data.requested_by_label)
    ? String(data.requested_by_label).trim()
    : actor.actor_label;

  const insert = await db.query(
    `INSERT INTO invoice_mark_paid_requests
      (invoice_id, invoice_number, member_id, reason, requested_by_admin_id, requested_by_label)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [inv.id, inv.invoice_number, inv.member_id, note, adminPayload?.adminId || null, requesterLabel]
  );

  await logActivity(db, {
    ...actor,
    member_id: inv.member_id,
    action: 'invoice.mark_paid_requested',
    entity_type: 'invoice_mark_paid_requests',
    table_name: 'invoice_mark_paid_requests',
    record_id: insert.rows[0].id,
    summary: `Mark paid requested for Invoice #${inv.invoice_number}: ${note}`,
    new_value: { invoice_number: inv.invoice_number, reason: note },
  });

  const row = await getMarkPaidRequestRow(insert.rows[0].id);
  return buildMarkPaidRequestSummary(row);
}

function approverIsRequester(row, adminPayload, actor) {
  if (row.requested_by_admin_id && adminPayload?.adminId) {
    return row.requested_by_admin_id === adminPayload.adminId;
  }
  if (row.requested_by_label && actor?.actor_label) {
    return String(row.requested_by_label).toLowerCase() === String(actor.actor_label).toLowerCase();
  }
  return false;
}

async function approveMarkPaidRequest(id, body, actor, adminPayload) {
  const db = getDb();
  const row = await getMarkPaidRequestRow(id);
  if (!row) {
    throw new Error('Mark paid request not found');
  }
  if (row.status !== 'Pending') {
    throw new Error(`Request is already ${row.status}`);
  }
  if (approverIsRequester(row, adminPayload, actor)) {
    throw new Error('You cannot approve your own mark-paid request. Another board member must approve.');
  }
  if (isClosedInvoiceStatusForMarkPaid(row.invoice_status)) {
    throw new Error('Invoice is no longer unpaid');
  }

  const updatedInvoice = await updateInvoice(
    {
      invoice_num: row.invoice_number,
      status: 'Paid',
      paid_note: row.reason,
      payment_method: 'Zelle & BofA',
    },
    actor
  );
  if (!updatedInvoice) {
    throw new Error('Could not mark invoice paid');
  }

  await db.query(
    `UPDATE invoice_mark_paid_requests
     SET status = 'Approved',
         reviewed_at = NOW(),
         reviewed_by_admin_id = $1,
         reviewed_by_label = $2,
         review_notes = COALESCE($3, review_notes)
     WHERE id = $4`,
    [adminPayload?.adminId || null, actor.actor_label, stampBoardNote(body.review_notes || body.notes || '', actor.actor_label) || null, id]
  );

  let paypal = null;
  try {
    const { recordPayPalPaymentForInvoice } = require('./paypal-invoice-actions');
    paypal = await recordPayPalPaymentForInvoice(db, { invoiceNum: row.invoice_number }, {
      paymentMethod: 'Zelle & BofA',
      note: row.reason,
      source: 'board mark-paid',
      approvedBy: actor.actor_label,
    });
    if (paypal?.ok && !paypal?.skipped) {
      await logActivity(db, {
        ...actor,
        member_id: row.member_id,
        action: 'invoice.paypal_marked_paid',
        entity_type: 'invoices',
        record_id: row.invoice_id,
        summary: `PayPal invoice updated for #${row.invoice_number}`,
        new_value: { paypal_invoice_id: paypal.paypal_invoice_id, payment_id: paypal.payment_id },
      });
    }
  } catch (err) {
    console.error('PayPal mark paid failed:', err.message);
    paypal = { ok: false, error: err.message };
    await logActivity(db, {
      ...actor,
      member_id: row.member_id,
      action: 'invoice.paypal_mark_paid_failed',
      entity_type: 'invoices',
      record_id: row.invoice_id,
      summary: `PayPal update failed for Invoice #${row.invoice_number}: ${err.message}`,
    });
  }

  const summary = await getMarkPaidRequestRow(id);
  return { request: buildMarkPaidRequestSummary(summary), invoice: updatedInvoice, paypal };
}

async function rejectMarkPaidRequest(id, body, actor, adminPayload) {
  const db = getDb();
  const row = await getMarkPaidRequestRow(id);
  if (!row) {
    throw new Error('Mark paid request not found');
  }
  if (row.status !== 'Pending') {
    throw new Error(`Request is already ${row.status}`);
  }

  await db.query(
    `UPDATE invoice_mark_paid_requests
     SET status = 'Rejected',
         reviewed_at = NOW(),
         reviewed_by_admin_id = $1,
         reviewed_by_label = $2,
         review_notes = COALESCE($3, review_notes)
     WHERE id = $4`,
    [adminPayload?.adminId || null, actor.actor_label, stampBoardNote(body.review_notes || body.notes || 'Rejected by board', actor.actor_label), id]
  );

  await logActivity(db, {
    ...actor,
    member_id: row.member_id,
    action: 'invoice.mark_paid_rejected',
    entity_type: 'invoice_mark_paid_requests',
    table_name: 'invoice_mark_paid_requests',
    record_id: id,
    summary: `Mark paid request rejected for Invoice #${row.invoice_number}`,
  });

  const summary = await getMarkPaidRequestRow(id);
  return buildMarkPaidRequestSummary(summary);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const path = getPath(event);
  const query = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (parseError) {
      return jsonResponse(400, { error: 'Invalid JSON payload' });
    }
  }

  try {
    if (event.httpMethod === 'GET' && (path === '/events' || path === '/deceased-members')) {
      const [events, memberStats] = await Promise.all([
        getEdirEvents(),
        getPublicMemberStats().catch(() => null),
      ]);
      const payload = { events, deceased_members: events };
      if (memberStats) {
        payload.active_count = memberStats.active_count;
        payload.member_cap = memberStats.member_cap;
      }
      return jsonResponse(200, payload);
    }

    if (event.httpMethod === 'GET' && (path === '/member-stats' || path === '/stats')) {
      const stats = await getPublicMemberStats();
      return jsonResponse(200, stats);
    }

    const adminPayload = verifyAdminRequest(event);
    const memberPayload = verifyMemberRequest(event);

    // Member portal — own data only (JWT required)
    if (memberPayload) {
      if (event.httpMethod === 'GET' && path === '/invoices') {
        const memberId = query.memberId ? Number(query.memberId) : memberPayload.memberId;
        if (memberId !== memberPayload.memberId) {
          return jsonResponse(403, { error: 'Forbidden' });
        }
        const invoices = dedupeInvoicesByEvent(await getInvoices({
          memberId,
          status: query.status,
          limit: query.limit ? Number(query.limit) : 500,
        }));
        return jsonResponse(200, { invoices });
      }

      if (event.httpMethod === 'GET' && path === '/profile') {
        const profile = await getMemberProfile(memberPayload.memberId);
        if (!profile) {
          return jsonResponse(404, { error: 'Member not found' });
        }
        return jsonResponse(200, profile);
      }

      if (event.httpMethod === 'GET' && path === '/messages') {
        const messages = await getMemberBoardMessages(memberPayload.memberId);
        return jsonResponse(200, { messages });
      }

      if (event.httpMethod === 'GET' && path === '/activity') {
        const db = getDb();
        const activity = await getActivityLog(db, {
          memberId: memberPayload.memberId,
          limit: query.limit ? Number(query.limit) : 50,
        });
        return jsonResponse(200, { activity });
      }

      if (event.httpMethod === 'PATCH' && path === '/profile') {
        const memberRow = await fetchMemberRow(memberPayload.memberId);
        const actor = buildActorFromMember(memberPayload, memberRow);
        const result = await patchMemberProfile(memberPayload.memberId, body, actor);
        if (!result) {
          return jsonResponse(404, { error: 'Member not found' });
        }
        return jsonResponse(200, result);
      }

      if (event.httpMethod === 'PUT' && path === '/beneficiary') {
        const memberRow = await fetchMemberRow(memberPayload.memberId);
        const actor = buildActorFromMember(memberPayload, memberRow);
        const result = await upsertMemberBeneficiary(memberPayload.memberId, body, actor);
        if (result.error) {
          return jsonResponse(result.status || 400, { error: result.error });
        }
        return jsonResponse(200, result);
      }
    }

    if (!adminPayload) {
      return jsonResponse(401, { error: 'Authorization token required' });
    }

    const db = getDb();
    const adminAccess = await loadBoardMemberAccess(db, adminPayload);
    if (isRestrictedMembersOnly(adminAccess) && !isPortalMembersCrmReadRoute(event.httpMethod, path)) {
      return jsonResponse(403, { error: 'Your access is limited to Members CRM only.' });
    }

    if (event.httpMethod === 'GET' && path === '/member') {
      const member = await findMember({ phone: query.phone, email: query.email, id: query.id });
      return jsonResponse(200, { member });
    }

    if (event.httpMethod === 'GET' && path === '/members') {
      const members = await getMembers({ search: query.search, limit: query.limit ? Number(query.limit) : undefined });
      return jsonResponse(200, { members });
    }

    if (event.httpMethod === 'GET' && path === '/invoice-stats') {
      const stats = await getInvoiceStats();
      return jsonResponse(200, { stats });
    }

    if (event.httpMethod === 'GET' && path === '/invoices') {
      const invoices = await getInvoices({
        memberId: query.memberId ? Number(query.memberId) : undefined,
        email: query.email,
        status: query.status,
        outstanding: query.outstanding === '1' || query.outstanding === 'true',
        limit: query.limit ? Number(query.limit) : undefined,
        activeOnly: query.activeOnly === '1' || query.activeOnly === 'true',
      });
      return jsonResponse(200, { invoices });
    }

    if (event.httpMethod === 'GET' && path === '/activity') {
      const db = getDb();
      const access = await loadBoardMemberAccess(db, adminPayload);
      const denied = assertCanManageBoard(access);
      if (denied) return jsonResponse(403, { error: denied });
      const activity = await getActivityLog(db, {
        memberId: query.memberId ? Number(query.memberId) : undefined,
        limit: query.limit ? Number(query.limit) : 100,
        entityType: query.entityType || undefined,
      });
      return jsonResponse(200, { activity });
    }

    if (event.httpMethod === 'GET' && path === '/member/application') {
      const memberId = query.memberId ? Number(query.memberId) : null;
      if (!memberId) {
        return jsonResponse(400, { error: 'memberId is required.' });
      }
      const db = getDb();
      const application = await getApplicationForMember(db, memberId, true);
      return jsonResponse(200, { application });
    }

    if (event.httpMethod === 'GET' && path === '/member/journey') {
      const memberId = query.memberId ? Number(query.memberId) : null;
      if (!memberId) {
        return jsonResponse(400, { error: 'memberId is required' });
      }
      const db = getDb();
      const journey = await getMemberJourney(db, memberId);
      return jsonResponse(200, journey);
    }

    if (event.httpMethod === 'POST' && path === '/member') {
      const db = getDb();
      const access = await loadBoardMemberAccess(db, adminPayload);
      const memberData = filterMemberUpdateForAccess(body, access);
      const hasUpdate = Object.keys(memberData).some((k) => k !== 'id' && memberData[k] !== undefined);
      if (!hasUpdate) {
        return jsonResponse(400, { error: 'Nothing to save.' });
      }
      const actor = await resolveAdminActor(adminPayload);
      const updated = await updateMember(memberData, actor);
      if (!updated) {
        return jsonResponse(400, { error: 'Unable to update member' });
      }
      return jsonResponse(200, { member: updated });
    }

    if (event.httpMethod === 'GET' && path === '/mark-paid-requests') {
      const requests = await listMarkPaidRequests(query);
      return jsonResponse(200, { requests });
    }

    const markPaidDetailMatch = path.match(/^\/mark-paid-requests\/(\d+)$/);
    if (event.httpMethod === 'GET' && markPaidDetailMatch) {
      const row = await getMarkPaidRequestRow(Number(markPaidDetailMatch[1]));
      if (!row) {
        return jsonResponse(404, { error: 'Mark paid request not found' });
      }
      return jsonResponse(200, { application: buildMarkPaidRequestSummary(row) });
    }

    if (event.httpMethod === 'POST' && path === '/mark-paid-request') {
      const db = getDb();
      const access = await loadBoardMemberAccess(db, adminPayload);
      const denied = assertPerm(access, 'mark_paid', 'You do not have permission to mark invoices paid.');
      if (denied) return jsonResponse(403, { error: denied });
      const actor = await resolveAdminActor(adminPayload);
      const request = await createMarkPaidRequest(body, actor, adminPayload);
      return jsonResponse(201, { request, message: 'Submitted for board approval. Another board member must approve in Admin → Approval.' });
    }

    const markPaidActionMatch = path.match(/^\/mark-paid-requests\/(\d+)\/(approve|reject)$/);
    if (event.httpMethod === 'POST' && markPaidActionMatch) {
      const db = getDb();
      const access = await loadBoardMemberAccess(db, adminPayload);
      const denied = assertPerm(access, 'mark_paid', 'You do not have permission to mark invoices paid.');
      if (denied) return jsonResponse(403, { error: denied });
      const actor = await resolveAdminActor(adminPayload);
      const reqId = Number(markPaidActionMatch[1]);
      if (markPaidActionMatch[2] === 'approve') {
        const result = await approveMarkPaidRequest(reqId, body, actor, adminPayload);
        return jsonResponse(200, result);
      }
      const request = await rejectMarkPaidRequest(reqId, body, actor, adminPayload);
      return jsonResponse(200, { request });
    }

    if (event.httpMethod === 'POST' && path === '/invoice') {
      const db = getDb();
      const access = await loadBoardMemberAccess(db, adminPayload);
      const denied = assertPerm(access, 'mark_paid', 'You do not have permission to mark invoices paid.');
      if (denied) return jsonResponse(403, { error: denied });
      const actor = await resolveAdminActor(adminPayload);
      if (body.status === 'Paid' && !body.approved_mark_paid_request_id) {
        return jsonResponse(400, {
          error: 'Manual mark paid requires board approval. Use Mark Paid on the invoice to submit a request.',
        });
      }
      const updatedInvoice = await updateInvoice(body, actor);
      if (!updatedInvoice) {
        return jsonResponse(400, { error: 'Unable to update invoice' });
      }
      return jsonResponse(200, { invoice: updatedInvoice });
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Portal API error:', error);
    return jsonResponse(500, { error: error.message });
  }
};