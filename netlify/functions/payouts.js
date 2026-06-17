const { getDb } = require('./db');
const { logActivity } = require('./audit');
const {
  verifyAdminRequest,
  buildActorFromAdmin,
} = require('./admin-auth');
const {
  loadBoardMemberAccess,
  assertCanWriteAll,
  assertCanApprovePayout,
  assertPerm,
  assertNotesOnlyUpdate,
  hasPerm,
} = require('./board-permissions');
const { stampBoardNote, mergeBoardNotes } = require('./board-notes');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const MAX_DOC_BYTES = 5 * 1024 * 1024;
const ALLOWED_DOC_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const DOC_KEYS = ['deceased_ss', 'deceased_id', 'beneficiary_ss', 'beneficiary_id', 'death_certificate'];
const CHECKLIST_KEYS = [
  'deceased_ss',
  'deceased_id',
  'beneficiary_ss',
  'beneficiary_id',
  'death_certificate',
  'relationship_verified',
];
const REQUIRED_FOR_APPROVAL = [
  'deceased_id',
  'beneficiary_id',
  'relationship_verified',
];
const REQUIRED_FOR_BOARD_APPROVAL = REQUIRED_FOR_APPROVAL;
const BOARD_APPROVALS_REQUIRED = 2;

const DEFAULT_CHECKLIST = Object.fromEntries(CHECKLIST_KEYS.map((k) => [k, false]));

function json(statusCode, payload) {
  return { statusCode, headers, body: JSON.stringify(payload) };
}

function getPath(event) {
  const base = '/.netlify/functions/payouts';
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
    return {};
  }
}

function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function approxBase64Bytes(data) {
  if (!data) return 0;
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - pad;
}

function sanitizeDocument(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const data = typeof doc.data === 'string' ? doc.data.replace(/\s/g, '') : '';
  const mime_type = String(doc.mime_type || '').toLowerCase();
  const filename = String(doc.filename || 'document').slice(0, 255);
  if (!data || !mime_type || !ALLOWED_DOC_MIMES.has(mime_type)) return null;
  const size = Number(doc.size) || approxBase64Bytes(data);
  if (size > MAX_DOC_BYTES) {
    throw new Error(`File too large (max ${MAX_DOC_BYTES / (1024 * 1024)} MB).`);
  }
  return {
    filename,
    mime_type,
    size,
    uploaded_at: new Date().toISOString(),
    data,
  };
}

function mergeDocuments(existing, incoming) {
  const docs = { ...parseJsonField(existing, {}) };
  if (!incoming || typeof incoming !== 'object') return docs;
  for (const key of DOC_KEYS) {
    if (!(key in incoming)) continue;
    if (incoming[key] === null) {
      delete docs[key];
      continue;
    }
    const sanitized = sanitizeDocument(incoming[key]);
    if (sanitized) docs[key] = sanitized;
  }
  return docs;
}

function computeAutoChecks(documents) {
  const docs = parseJsonField(documents, {});
  return {
    deceased_ss: !!(docs.deceased_ss?.data || docs.deceased_ss?.filename),
    deceased_id: !!(docs.deceased_id?.data || docs.deceased_id?.filename),
    beneficiary_ss: !!(docs.beneficiary_ss?.data || docs.beneficiary_ss?.filename),
    beneficiary_id: !!(docs.beneficiary_id?.data || docs.beneficiary_id?.filename),
    death_certificate: !!(docs.death_certificate?.data || docs.death_certificate?.filename),
  };
}

function mergeChecklist(stored, auto, incoming) {
  const base = { ...DEFAULT_CHECKLIST, ...parseJsonField(stored, {}) };
  const merged = { ...base };
  if (incoming && typeof incoming === 'object') {
    for (const key of CHECKLIST_KEYS) {
      if (key in incoming) merged[key] = incoming[key] === true;
    }
  }
  for (const key of CHECKLIST_KEYS) {
    if (key in auto && auto[key]) merged[key] = true;
  }
  return { ...merged, auto };
}

function stripDocumentData(documents) {
  const docs = parseJsonField(documents, {});
  const out = {};
  for (const [key, doc] of Object.entries(docs)) {
    if (!doc || typeof doc !== 'object') continue;
    out[key] = {
      filename: doc.filename,
      mime_type: doc.mime_type,
      size: doc.size,
      uploaded_at: doc.uploaded_at,
      has_data: !!(doc.data || doc.filename),
    };
  }
  return out;
}

function buildPayoutSummary(row, includeDocData = false) {
  const auto = computeAutoChecks(row.documents);
  const checklist = mergeChecklist(row.review_checklist, auto, null);
  const approvals = parseJsonField(row.board_approvals, []);
  const docs = includeDocData
    ? parseJsonField(row.documents, {})
    : stripDocumentData(row.documents);

  return {
    id: row.id,
    event_id: row.event_id,
    event_label: row.event_label,
    member_id: row.member_id,
    member_name: row.member_name || null,
    member_number: row.member_number || null,
    deceased_name: row.deceased_name,
    deceased_relationship: row.deceased_relationship,
    beneficiary_name: row.beneficiary_name,
    beneficiary_phone: row.beneficiary_phone,
    beneficiary_relationship: row.beneficiary_relationship,
    payout_amount: Number(row.payout_amount),
    status: row.status,
    documents: docs,
    review_checklist: checklist,
    board_approvals: approvals,
    board_approvals_count: approvals.length,
    board_approvals_required: BOARD_APPROVALS_REQUIRED,
    checklist_complete: REQUIRED_FOR_APPROVAL.every((k) => checklist[k]),
    payout_method: row.payout_method,
    payout_reference: row.payout_reference,
    payout_sent_at: row.payout_sent_at,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function resolveAdminActor(adminPayload) {
  if (!adminPayload?.adminId) {
    return buildActorFromAdmin(adminPayload, null);
  }
  const db = getDb();
  const result = await db.query(
    'SELECT id, email FROM board_members WHERE id = $1 LIMIT 1',
    [adminPayload.adminId]
  );
  return buildActorFromAdmin(adminPayload, result.rows[0]);
}

const PAYOUT_FROM = `
  FROM event_payouts p
  LEFT JOIN members m ON p.member_id = m.id
`;

const PAYOUT_LIST_SELECT = `
  SELECT p.id, p.event_id, p.event_label, p.member_id, p.deceased_name, p.deceased_relationship,
    p.beneficiary_name, p.beneficiary_phone, p.beneficiary_relationship, p.payout_amount, p.status,
    p.review_checklist, p.board_approvals, p.payout_method, p.payout_reference, p.payout_sent_at,
    p.notes, p.created_at, p.updated_at,
    CASE WHEN p.documents IS NULL THEN '{}'::jsonb ELSE (
      SELECT COALESCE(jsonb_object_agg(e.key, e.value - 'data'), '{}'::jsonb)
      FROM jsonb_each(p.documents) AS e(key, value)
    ) END AS documents,
    m.full_name AS member_name,
    m.member_number
  ${PAYOUT_FROM}
`;

const PAYOUT_DETAIL_SELECT = `
  SELECT p.*,
    m.full_name AS member_name,
    m.member_number
  ${PAYOUT_FROM}
`;

async function listPayouts(query = {}) {
  const db = getDb();
  const values = [];
  const filters = [];
  let idx = 1;

  if (query.status) {
    filters.push(`p.status = $${idx}`);
    values.push(query.status);
    idx += 1;
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = Math.min(Number(query.limit) || 100, 200);

  const result = await db.query(
    `${PAYOUT_LIST_SELECT} ${where} ORDER BY p.created_at DESC LIMIT ${limit}`,
    values
  );
  return json(200, {
    payouts: result.rows.map((row) => buildPayoutSummary(row)),
  });
}

async function getPayout(id, includeDocData = false) {
  const db = getDb();
  const result = await db.query(`${PAYOUT_DETAIL_SELECT} WHERE p.id = $1 LIMIT 1`, [id]);
  if (!result.rows[0]) return json(404, { error: 'Payout case not found.' });
  return json(200, { payout: buildPayoutSummary(result.rows[0], includeDocData) });
}

async function createPayout(body, actor) {
  const deceased_name = String(body.deceased_name || '').trim();
  if (!deceased_name) {
    return json(400, { error: 'Deceased name is required.' });
  }

  const db = getDb();
  const result = await db.query(
    `INSERT INTO event_payouts (
      event_id, event_label, member_id, deceased_name, deceased_relationship,
      beneficiary_name, beneficiary_phone, beneficiary_relationship,
      payout_amount, status, notes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *`,
    [
      body.event_id ? Number(body.event_id) : null,
      body.event_label ? String(body.event_label).slice(0, 300) : null,
      body.member_id ? Number(body.member_id) : null,
      deceased_name,
      body.deceased_relationship ? String(body.deceased_relationship).slice(0, 100) : null,
      body.beneficiary_name ? String(body.beneficiary_name).slice(0, 200) : null,
      body.beneficiary_phone ? String(body.beneficiary_phone).slice(0, 32) : null,
      body.beneficiary_relationship ? String(body.beneficiary_relationship).slice(0, 100) : null,
      body.payout_amount ? Number(body.payout_amount) : 15000,
      'Documents Pending',
      body.notes ? String(body.notes).slice(0, 4000) : null,
    ]
  );

  const row = result.rows[0];
  await logActivity(db, {
    ...actor,
    action: 'payout.created',
    entity_type: 'event_payout',
    table_name: 'event_payouts',
    record_id: row.id,
    member_id: row.member_id,
    summary: `Payout case opened for ${deceased_name}`,
    new_value: { deceased_name, event_label: row.event_label },
  });

  const joined = await db.query(`${PAYOUT_DETAIL_SELECT} WHERE p.id = $1`, [row.id]);
  return json(201, { payout: buildPayoutSummary(joined.rows[0]) });
}

async function updatePayout(id, body, actor, access) {
  const db = getDb();
  const existing = await db.query('SELECT * FROM event_payouts WHERE id = $1 LIMIT 1', [id]);
  if (!existing.rows[0]) return json(404, { error: 'Payout case not found.' });
  const row = existing.rows[0];

  if (!hasPerm(access, 'payout_manage')) {
    if (!hasPerm(access, 'board_notes')) {
      return json(403, { error: 'You do not have permission to update payout cases.' });
    }
    const notesErr = assertNotesOnlyUpdate(body, ['notes']);
    if (notesErr) return json(notesErr === 'Nothing to save.' ? 400 : 403, { error: notesErr });
    const merged = mergeBoardNotes(row.notes, body.notes, actor?.actor_label || 'Board');
    await db.query(
      `UPDATE event_payouts SET notes = $1, updated_at = NOW() WHERE id = $2`,
      [String(merged || '').slice(0, 4000) || null, id]
    );
    await logActivity(db, {
      ...actor,
      action: 'payout.notes_updated',
      entity_type: 'event_payout',
      table_name: 'event_payouts',
      record_id: id,
      member_id: row.member_id,
      summary: `Payout notes updated for ${row.deceased_name}`,
    });
    return getPayout(id, true);
  }

  if (row.status === 'Paid Out' && !body.force) {
    return json(400, { error: 'This payout is already marked paid out.' });
  }

  let documents = parseJsonField(row.documents, {});
  try {
    if (body.documents) documents = mergeDocuments(documents, body.documents);
  } catch (err) {
    return json(400, { error: err.message });
  }

  const auto = computeAutoChecks(documents);
  const checklist = mergeChecklist(row.review_checklist, auto, body.review_checklist);

  const fields = [];
  const values = [];
  let idx = 1;

  function setField(column, value) {
    fields.push(`${column} = $${idx}`);
    values.push(value);
    idx += 1;
  }

  if (body.beneficiary_name !== undefined) setField('beneficiary_name', String(body.beneficiary_name || '').slice(0, 200) || null);
  if (body.beneficiary_phone !== undefined) setField('beneficiary_phone', String(body.beneficiary_phone || '').slice(0, 32) || null);
  if (body.beneficiary_relationship !== undefined) {
    setField('beneficiary_relationship', String(body.beneficiary_relationship || '').slice(0, 100) || null);
  }
  if (body.deceased_relationship !== undefined) {
    setField('deceased_relationship', String(body.deceased_relationship || '').slice(0, 100) || null);
  }
  if (body.notes !== undefined) {
    const merged = mergeBoardNotes(row.notes, body.notes, actor?.actor_label || 'Board');
    setField('notes', String(merged || '').slice(0, 4000) || null);
  }
  if (body.payout_method !== undefined) setField('payout_method', String(body.payout_method || '').slice(0, 50) || null);
  if (body.payout_reference !== undefined) setField('payout_reference', String(body.payout_reference || '').slice(0, 500) || null);
  if (body.documents) setField('documents', JSON.stringify(documents));
  if (body.review_checklist || body.documents) setField('review_checklist', JSON.stringify(checklist));

  if (body.status) {
    const allowed = ['Documents Pending', 'Under Review', 'Approved', 'Paid Out', 'On Hold'];
    if (!allowed.includes(body.status)) {
      return json(400, { error: 'Invalid status.' });
    }
    setField('status', body.status);
  } else if (body.review_checklist || body.documents) {
    const nextStatus = checklistCompleteForReview(checklist) ? 'Under Review' : 'Documents Pending';
    if (row.status !== 'Approved' && row.status !== 'Paid Out') {
      setField('status', nextStatus);
    }
  }

  setField('updated_at', new Date().toISOString());

  if (!fields.length) {
    return getPayout(id, true);
  }

  values.push(id);
  await db.query(`UPDATE event_payouts SET ${fields.join(', ')} WHERE id = $${idx}`, values);

  await logActivity(db, {
    ...actor,
    action: 'payout.updated',
    entity_type: 'event_payout',
    table_name: 'event_payouts',
    record_id: id,
    member_id: row.member_id,
    summary: `Payout case updated for ${row.deceased_name}`,
  });

  return getPayout(id, true);
}

function checklistCompleteForReview(checklist) {
  return REQUIRED_FOR_APPROVAL.every((k) => checklist[k]);
}

function checklistReadyForApproval(checklist) {
  return REQUIRED_FOR_BOARD_APPROVAL.every((k) => checklist[k]);
}

async function approvePayout(id, actor, adminPayload) {
  const db = getDb();
  const existing = await db.query('SELECT * FROM event_payouts WHERE id = $1 LIMIT 1', [id]);
  if (!existing.rows[0]) return json(404, { error: 'Payout case not found.' });
  const row = existing.rows[0];

  if (row.status === 'Paid Out') {
    return json(400, { error: 'Payout already sent.' });
  }

  const checklist = mergeChecklist(row.review_checklist, computeAutoChecks(row.documents), null);
  if (!checklistReadyForApproval(checklist)) {
    return json(400, {
      error: 'All document checklist items must be confirmed before board approval.',
      review_checklist: checklist,
    });
  }

  const approvals = parseJsonField(row.board_approvals, []);
  const adminId = adminPayload?.adminId || null;
  const adminEmail = actor.actor_label || 'Board Admin';

  if (adminId && approvals.some((a) => a.admin_id === adminId)) {
    return json(400, { error: 'You have already approved this payout.' });
  }

  approvals.push({
    admin_id: adminId,
    email: adminEmail,
    at: new Date().toISOString(),
  });

  let status = row.status;
  if (approvals.length >= BOARD_APPROVALS_REQUIRED) {
    status = 'Approved';
  } else if (status === 'Documents Pending') {
    status = 'Under Review';
  }

  await db.query(
    `UPDATE event_payouts
     SET board_approvals = $1, status = $2, updated_at = NOW()
     WHERE id = $3`,
    [JSON.stringify(approvals), status, id]
  );

  await logActivity(db, {
    ...actor,
    action: 'payout.approved',
    entity_type: 'event_payout',
    table_name: 'event_payouts',
    record_id: id,
    member_id: row.member_id,
    summary: `${adminEmail} approved payout for ${row.deceased_name} (${approvals.length}/${BOARD_APPROVALS_REQUIRED})`,
    new_value: { approvals_count: approvals.length, status },
  });

  return getPayout(id);
}

async function markPayoutPaid(id, body, actor) {
  const db = getDb();
  const existing = await db.query('SELECT * FROM event_payouts WHERE id = $1 LIMIT 1', [id]);
  if (!existing.rows[0]) return json(404, { error: 'Payout case not found.' });
  const row = existing.rows[0];

  if (row.status !== 'Approved') {
    return json(400, {
      error: `Payout must be Approved first (needs ${BOARD_APPROVALS_REQUIRED} board approvals). Current status: ${row.status}.`,
    });
  }

  const payout_method = body.payout_method || row.payout_method || 'Check';
  const payout_reference = body.payout_reference || row.payout_reference || null;

  await db.query(
    `UPDATE event_payouts
     SET status = 'Paid Out',
         payout_sent_at = NOW(),
         payout_method = $1,
         payout_reference = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [payout_method, payout_reference, id]
  );

  if (row.event_id) {
    await db.query(
      `UPDATE events SET payout_sent = TRUE, payout_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [row.event_id]
    );
  }

  await logActivity(db, {
    ...actor,
    action: 'payout.sent',
    entity_type: 'event_payout',
    table_name: 'event_payouts',
    record_id: id,
    member_id: row.member_id,
    summary: `$${Number(row.payout_amount).toLocaleString()} paid out for ${row.deceased_name} via ${payout_method}`,
    new_value: { payout_method, payout_reference },
  });

  return getPayout(id);
}

function matchPayoutPath(path) {
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
  const id = parts[0] ? Number(parts[0]) : null;
  const action = parts[1] || null;
  return { id, action, isRoot: !parts.length };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const admin = verifyAdminRequest(event);
  if (!admin) {
    return json(401, { error: 'Admin authorization required. Please sign in.' });
  }

  const path = getPath(event);
  const route = matchPayoutPath(path);
  const actor = await resolveAdminActor(admin);
  const db = getDb();
  const access = await loadBoardMemberAccess(db, admin);

  try {
    if (event.httpMethod === 'GET' && route.isRoot) {
      return await listPayouts(event.queryStringParameters || {});
    }
    if (event.httpMethod === 'GET' && route.id && !route.action) {
      return await getPayout(route.id, true);
    }
    if (event.httpMethod === 'POST' && route.isRoot) {
      const denied = assertPerm(access, 'payout_manage');
      if (denied) return json(403, { error: denied });
      return await createPayout(parseBody(event), actor);
    }
    if (event.httpMethod === 'PATCH' && route.id && !route.action) {
      return await updatePayout(route.id, parseBody(event), actor, access);
    }
    if (event.httpMethod === 'POST' && route.id && route.action === 'approve') {
      const denied = assertPerm(access, 'payout_approve', 'You do not have approval permission for payouts.');
      if (denied) return json(403, { error: denied });
      return await approvePayout(route.id, actor, admin);
    }
    if (event.httpMethod === 'POST' && route.id && route.action === 'mark-paid') {
      const denied = assertPerm(access, 'payout_mark_paid', 'You do not have permission to mark payouts as paid.');
      if (denied) return json(403, { error: denied });
      return await markPayoutPaid(route.id, parseBody(event), actor);
    }
    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error('payouts API error:', err);
    if (err.message?.includes('DATABASE_URL') || err.message?.includes('does not exist')) {
      return json(503, {
        error: 'Database is not configured or payout tables are missing. Run db/schema.sql migrations.',
      });
    }
    return json(500, { error: err.message || 'Could not process payout request.' });
  }
};
