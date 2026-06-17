const { getDb } = require('./db');
const { verifyAdminRequest, verifyMemberRequest, buildActorFromAdmin } = require('./admin-auth');
const { loadBoardMemberAccess, assertCanApproveOperations, assertPerm } = require('./board-permissions');
const { logActivity } = require('./audit');
const { invalidateInvoiceStatsCache } = require('./invoice-stats-cache');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heif', 'image/heic', 'application/pdf']);

function json(statusCode, payload) {
  return { statusCode, headers, body: JSON.stringify(payload) };
}

function getPath(event) {
  const base = '/.netlify/functions/receipts';
  if (event.path && event.path.startsWith(base)) {
    return event.path.slice(base.length) || '/';
  }
  return event.path || '/';
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function approxBase64Bytes(data) {
  if (!data) return 0;
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - pad;
}

function sanitizeFile(file) {
  if (!file || typeof file !== 'object') return null;
  const data = typeof file.data === 'string' ? file.data.replace(/\s/g, '') : '';
  const mime = String(file.mime_type || file.type || '').toLowerCase();
  const filename = String(file.filename || file.name || 'receipt').slice(0, 255);
  if (!data || !mime || !ALLOWED_MIMES.has(mime)) return null;
  const size = Number(file.size) || approxBase64Bytes(data);
  if (size > MAX_FILE_BYTES) {
    throw new Error(`File too large (max ${MAX_FILE_BYTES / (1024 * 1024)} MB).`);
  }
  return { data, mime, filename, size };
}

async function findInvoiceForMember(db, memberId, invoiceNum) {
  if (!invoiceNum) return null;
  const result = await db.query(
    `SELECT id, event_id, amount_due FROM invoices
     WHERE member_id = $1 AND invoice_number = $2
     LIMIT 1`,
    [memberId, Number(invoiceNum)]
  );
  return result.rows[0] || null;
}

async function findEventForDeceased(db, deceasedName) {
  if (!deceasedName) return null;
  const result = await db.query(
    `SELECT id FROM events
     WHERE LOWER(TRIM(deceased_name)) = LOWER(TRIM($1))
     ORDER BY event_date DESC NULLS LAST, event_number DESC
     LIMIT 1`,
    [deceasedName]
  );
  return result.rows[0]?.id || null;
}

const RECEIPT_FROM = `
  FROM receipts r
  LEFT JOIN members m ON m.id = r.member_id
  LEFT JOIN events e ON e.id = r.event_id
  LEFT JOIN invoices i ON i.id = r.invoice_id
`;

const RECEIPT_LIST_SELECT = `
  SELECT r.id, r.member_id, r.invoice_id, r.event_id, r.payment_method, r.amount, r.notes,
    r.status, r.submitted_at, r.reviewed_at,
    (r.file_url IS NOT NULL AND LENGTH(r.file_url) > 20) AS has_file,
    m.first_name, m.last_name, m.full_name, m.paypal_name, m.member_number,
    e.deceased_name AS event_deceased_name,
    i.invoice_number
  ${RECEIPT_FROM}
`;

const RECEIPT_DETAIL_SELECT = `
  SELECT r.*,
    m.first_name, m.last_name, m.full_name, m.paypal_name, m.member_number,
    e.deceased_name AS event_deceased_name,
    i.invoice_number
  ${RECEIPT_FROM}
`;

function mapReceiptRow(row, { includePreview = false } = {}) {
  const out = {
    id: row.id,
    member_id: row.member_id,
    member_name: row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.paypal_name,
    member_number: row.member_number,
    invoice_id: row.invoice_id,
    invoice_number: row.invoice_number,
    event_id: row.event_id,
    deceased_name: row.event_deceased_name || null,
    payment_method: row.payment_method,
    amount: row.amount,
    notes: row.notes,
    status: row.status,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    has_file: row.has_file === true || !!(row.file_url && row.file_url.length > 20),
  };
  if (includePreview) {
    out.file_preview = row.file_url && row.file_url.startsWith('data:') ? row.file_url : null;
  }
  return out;
}

async function listReceipts(query) {
  const db = getDb();
  const status = query.status || null;
  let sql = RECEIPT_LIST_SELECT;
  const values = [];
  if (status) {
    sql += ` WHERE r.status = $1`;
    values.push(status);
  }
  sql += ` ORDER BY r.submitted_at DESC NULLS LAST, r.id DESC LIMIT 100`;
  const result = await db.query(sql, values);
  return json(200, {
    receipts: result.rows.map((row) => mapReceiptRow(row)),
  });
}

async function getReceipt(id) {
  const db = getDb();
  const result = await db.query(`${RECEIPT_DETAIL_SELECT} WHERE r.id = $1 LIMIT 1`, [id]);
  if (!result.rows[0]) return json(404, { error: 'Receipt not found.' });
  return json(200, { receipt: mapReceiptRow(result.rows[0], { includePreview: true }) });
}

async function submitReceipt(memberId, body) {
  const paymentMethod = String(body.payment_method || 'Zelle').trim().slice(0, 50);
  const deceasedName = String(body.deceased_name || body.person_name || '').trim();
  const notes = String(body.notes || '').trim().slice(0, 2000) || null;
  const file = sanitizeFile(body.file);
  if (!file) {
    return json(400, { error: 'Receipt file is required (JPG, PNG, or PDF, max 5 MB).' });
  }
  if (!deceasedName) {
    return json(400, { error: 'Please select who you are paying for.' });
  }

  const db = getDb();
  const invoice = await findInvoiceForMember(db, memberId, body.invoice_num);
  let eventId = invoice?.event_id || null;
  if (!eventId) {
    eventId = await findEventForDeceased(db, deceasedName);
  }

  const fileUrl = `data:${file.mime};base64,${file.data}`;
  const insert = await db.query(
    `INSERT INTO receipts (member_id, invoice_id, event_id, payment_method, amount, file_url, notes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending')
     RETURNING id, submitted_at, status`,
    [
      memberId,
      invoice?.id || null,
      eventId,
      paymentMethod,
      invoice?.amount_due || null,
      fileUrl,
      notes ? `${notes}\nPaying for: ${deceasedName}` : `Paying for: ${deceasedName}`,
    ]
  );

  return json(201, {
    ok: true,
    receipt: insert.rows[0],
    message: 'Receipt submitted. The board will review and confirm your payment.',
  });
}

async function updateReceiptStatus(id, status, adminPayload) {
  const db = getDb();
  const existing = await db.query(`SELECT * FROM receipts WHERE id = $1 LIMIT 1`, [id]);
  if (!existing.rows.length) return json(404, { error: 'Receipt not found.' });
  const row = existing.rows[0];
  if (row.status === status) return json(409, { error: `Receipt is already ${status}.` });

  await db.query(
    `UPDATE receipts SET status = $1, reviewed_at = NOW(), reviewed_by = $2 WHERE id = $3`,
    [status, adminPayload?.adminId || null, id]
  );

  let paypal = null;
  if (status === 'Approved' && row.invoice_id) {
    const method = row.payment_method || 'Zelle';
    const paidNote = `Receipt approved — ${method}${row.notes ? `: ${String(row.notes).trim().slice(0, 500)}` : ''}`;
    await db.query(
      `UPDATE invoices
       SET status = 'Paid',
           paid_date = COALESCE(paid_date, CURRENT_DATE),
           payment_method = COALESCE(NULLIF(TRIM($2), ''), payment_method, 'Zelle'),
           paid_note = COALESCE(paid_note, $3),
           updated_at = NOW()
       WHERE id = $1 AND status IS DISTINCT FROM 'Paid'`,
      [row.invoice_id, method, paidNote]
    );
    invalidateInvoiceStatsCache();

    const actor = buildActorFromAdmin(adminPayload, adminPayload?.adminRow);
    try {
      const { recordPayPalPaymentForInvoice } = require('./paypal-invoice-actions');
      paypal = await recordPayPalPaymentForInvoice(db, { invoiceId: row.invoice_id }, {
        paymentMethod: method,
        note: paidNote,
        source: `receipt #${id}`,
        approvedBy: actor.actor_label,
      });
      if (paypal?.ok && !paypal?.skipped) {
        await logActivity(db, {
          ...actor,
          member_id: row.member_id,
          action: 'invoice.paypal_marked_paid',
          entity_type: 'invoices',
          record_id: row.invoice_id,
          summary: `PayPal invoice updated after receipt #${id} approval`,
          new_value: { receipt_id: id, paypal_invoice_id: paypal.paypal_invoice_id },
        });
      }
    } catch (err) {
      console.error('PayPal mark paid after receipt failed:', err.message);
      paypal = { ok: false, error: err.message };
      await logActivity(db, {
        ...actor,
        member_id: row.member_id,
        action: 'invoice.paypal_mark_paid_failed',
        entity_type: 'invoices',
        record_id: row.invoice_id,
        summary: `PayPal update failed after receipt #${id}: ${err.message}`,
      });
    }
  }

  const detail = await db.query(`${RECEIPT_DETAIL_SELECT} WHERE r.id = $1 LIMIT 1`, [id]);
  return json(200, {
    receipt: mapReceiptRow(detail.rows[0] || row, { includePreview: false }),
    paypal,
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const path = getPath(event);
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
  const receiptId = parts[0] ? Number(parts[0]) : null;
  const action = parts[1] || null;

  try {
    if (event.httpMethod === 'GET') {
      const admin = verifyAdminRequest(event);
      if (!admin) return json(401, { error: 'Admin authorization required.' });
      if (receiptId && !action) return await getReceipt(receiptId);
      return await listReceipts(event.queryStringParameters || {});
    }

    if (event.httpMethod === 'POST' && !receiptId) {
      const member = verifyMemberRequest(event);
      if (!member) return json(401, { error: 'Member authorization required.' });
      const body = parseBody(event);
      if (!body) return json(400, { error: 'Invalid JSON payload.' });
      try {
        return await submitReceipt(member.memberId, body);
      } catch (err) {
        return json(400, { error: err.message || 'Could not upload receipt.' });
      }
    }

    if (event.httpMethod === 'POST' && receiptId && (action === 'approve' || action === 'reject')) {
      const admin = verifyAdminRequest(event);
      if (!admin) return json(401, { error: 'Admin authorization required.' });
      const db = getDb();
      const access = await loadBoardMemberAccess(db, admin);
      const denied = assertPerm(access, 'receipts', 'You do not have permission to approve receipts.');
      if (denied) return json(403, { error: denied });
      const status = action === 'approve' ? 'Approved' : 'Rejected';
      return await updateReceiptStatus(receiptId, status, admin);
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error('receipts error:', err);
    if (err.message?.includes('DATABASE_URL')) {
      return json(503, { error: 'Database is not configured.' });
    }
    return json(500, { error: 'Could not process receipt request.' });
  }
};
