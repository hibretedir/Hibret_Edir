const { getDb } = require('./db');
const { notifyProfileUpdate, notifyBeneficiaryUpdate, notifyBeneficiaryChangeRequested } = require('./notify');
const { getActivityLog, getMemberJourney } = require('./audit');
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
} = require('./admin-auth');const headers = {
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
  if (event.path && event.path.startsWith(basePath)) {
    return event.path.slice(basePath.length) || '/';
  }
  return event.path || '/';
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

function buildMemberPayload(member) {
  return {
    id: member.id,
    member_number: member.member_number,
    first: member.first_name,
    last: member.last_name,
    full_name: member.full_name || `${member.first_name || ''} ${member.last_name || ''}`.trim(),
    paypal_name: member.paypal_name,
    email: member.email,
    mobile: member.mobile,
    home: member.home_phone,
    address: member.address,
    status: member.status,
    joined_date: member.joined_date,
    notes: member.notes || '',
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

  const sql = `SELECT id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone, address, status, joined_date, created_at, updated_at, notes
               FROM members
               WHERE ${conditions.join(' OR ')}
               LIMIT 1`;

  const result = await db.query(sql, values);
  return result.rows[0] ? buildMemberPayload(result.rows[0]) : null;
}

async function getInvoices({ memberId, email, status, limit = 500 }) {
  const db = getDb();
  const values = [];
  const filters = ['invoices.invoice_number IS NOT NULL'];
  let idx = 1;

  let innerQuery = `
    SELECT DISTINCT ON (invoices.invoice_number)
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
      COALESCE(events.deceased_name, '') AS item,
      invoices.recipient_name,
      invoices.member_id,
      members.paypal_name AS member_paypal_name,
      members.full_name AS member_full_name,
      members.email AS member_email
    FROM invoices
    LEFT JOIN events ON invoices.event_id = events.id
    LEFT JOIN members ON invoices.member_id = members.id
  `;

  if (memberId) {
    filters.push(`invoices.member_id = $${idx}`);
    values.push(memberId);
    idx += 1;
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
  }

  innerQuery += ` WHERE ${filters.join(' AND ')}`;
  innerQuery += `
    ORDER BY invoices.invoice_number DESC,
      (CASE WHEN invoices.recipient_name IS NOT NULL AND TRIM(invoices.recipient_name) <> '' THEN 0 ELSE 1 END),
      invoices.updated_at DESC NULLS LAST,
      invoices.id DESC
  `;

  const baseQuery = `
    SELECT * FROM (${innerQuery}) AS deduped_invoices
    ORDER BY date DESC NULLS LAST, invoice_number DESC
    LIMIT $${idx}
  `;
  values.push(limit);

  const result = await db.query(baseQuery, values);
  return result.rows.map(buildInvoicePayload);
}

function buildInvoicePayload(row) {
  const invoiceName = row.recipient_name
    || row.member_paypal_name
    || row.member_full_name
    || '';
  const dateStr = row.date ? row.date.toISOString().slice(0, 19).replace('T', ' ') : null;
  const daysOverdue = computeDaysOverdue(dateStr, row.status);
  return {
    id: row.id,
    invoice_num: row.invoice_number,
    paypal_id: row.paypal_id,
    status: row.status,
    total: Number(row.amount),
    amount_due: Number(row.amount_due),
    date: dateStr,
    item: row.item || '',
    payment_method: row.payment_method,
    paypal_link: row.paypal_link,
    member_email: row.member_email,
    member_full_name: row.member_full_name,
    member_paypal_name: row.member_paypal_name,
    member_id: row.member_id,
    recipient_name: row.recipient_name,
    name: invoiceName,
    email: row.member_email,
    days_overdue: daysOverdue,
    is_late: daysOverdue > 0 && String(row.status || '').toLowerCase() !== 'paid',
  };
}

const INVOICE_DUE_DAYS = 3;

function computeDaysOverdue(dateStr, status) {
  if (!dateStr || String(status || '').toLowerCase() === 'paid') return 0;
  const sent = new Date(String(dateStr).split(' ')[0]);
  if (Number.isNaN(sent.getTime())) return 0;
  const due = new Date(sent.getTime() + INVOICE_DUE_DAYS * 86400000);
  return Math.max(0, Math.floor((Date.now() - due.getTime()) / 86400000));
}

async function updateMember(data, actor) {
  const db = getDb();
  if (!data?.id) return null;

  const oldRes = await db.query(
    `SELECT id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone, address, status, joined_date, created_at, updated_at, notes
     FROM members WHERE id = $1`,
    [data.id]
  );
  const oldRow = oldRes.rows[0];
  if (!oldRow) return null;

  const fieldMap = {
    first: 'first_name',
    last: 'last_name',
    full_name: 'full_name',
    home: 'home_phone',
    mobile: 'mobile',
    email: 'email',
    address: 'address',
    paypal_name: 'paypal_name',
    notes: 'notes',
    status: 'status'
  };

  const fields = [];
  const values = [];
  let idx = 1;
  for (const key of Object.keys(fieldMap)) {
    if (data[key] !== undefined) {
      fields.push(`${fieldMap[key]} = $${idx}`);
      values.push(key === 'email' ? String(data[key]).trim().toLowerCase() : data[key]);
      idx += 1;
    }
  }

  if (!fields.length) return buildMemberPayload(oldRow);
  fields.push(`updated_at = NOW()`);
  values.push(data.id);

  const result = await db.query(
    `UPDATE members SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone, address, status, joined_date, created_at, updated_at, notes`,
    values
  );
  const newRow = result.rows[0];
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

  if (!updates.length) return null;
  if (data.status === 'Paid' && data.paid_date === undefined) {
    updates.push(`paid_date = NOW()`);
  }

  let whereClause;
  if (data.invoice_num !== undefined) {
    whereClause = `invoice_number = $${idx}`;
    values.push(data.invoice_num);
    idx += 1;
  } else if (data.id !== undefined) {
    whereClause = `id = $${idx}`;
    values.push(data.id);
    idx += 1;
  } else {
    return null;
  }

  const lookupValue = values[values.length - 1];
  const existing = await db.query(
    `SELECT id, invoice_number, status, member_id, sent_date FROM invoices WHERE ${whereClause}`,
    [lookupValue]
  );
  const oldInvoice = existing.rows[0];

  updates.push(`updated_at = NOW()`);

  const result = await db.query(
    `UPDATE invoices SET ${updates.join(', ')} WHERE ${whereClause} RETURNING id, invoice_number, paypal_invoice_id AS paypal_id, status, amount, amount_due, sent_date AS date, paid_date, payment_method, paypal_link, event_id, member_id, recipient_name`,
    values
  );
  if (!result.rows[0]) return null;

  if (actor && oldInvoice && data.status !== undefined) {
    try {
      await syncInvoiceStatusChange(db, result.rows[0], oldInvoice.status, data.status, actor, oldInvoice.member_id);
    } catch (err) {
      console.error('Invoice sync failed:', err);
    }
  }

  const joined = await db.query(
    `SELECT COALESCE(events.deceased_name, '') AS item,
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
  let sql = `SELECT id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone AS home, address, status, joined_date, created_at, updated_at, notes FROM members`;

  if (search) {
    const normalizedSearch = search.replace(/\D/g, '');
    const parts = search.split(/\s+/).filter(Boolean);
    const likeSearch = `%${search.toLowerCase()}%`;
    const clauses = [
      `LOWER(full_name) LIKE $1`,
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

  sql += ` ORDER BY id DESC LIMIT $${values.length + 1}`;
  values.push(limit);

  const result = await db.query(sql, values);
  return result.rows.map(buildMemberPayload);
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
    `SELECT id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone, address, status, joined_date, created_at, updated_at, notes
     FROM members WHERE id = $1 LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
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
  };
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

async function getEdirEvents() {
  const db = getDb();
  const result = await db.query(
    `SELECT id, event_number, deceased_name, event_date, status
     FROM events
     WHERE deceased_name IS NOT NULL AND TRIM(deceased_name) <> ''
     ORDER BY event_date DESC NULLS LAST, event_number DESC`
  );
  return result.rows.map((row) => ({
    id: row.id,
    event_number: row.event_number,
    name: row.deceased_name.trim(),
    date: row.event_date,
    status: row.status,
  }));
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
    const adminPayload = verifyAdminRequest(event);
    const memberPayload = verifyMemberRequest(event);

    // Member portal — own data only (JWT required)
    if (memberPayload) {
      if (event.httpMethod === 'GET' && path === '/invoices') {
        const memberId = query.memberId ? Number(query.memberId) : memberPayload.memberId;
        if (memberId !== memberPayload.memberId) {
          return jsonResponse(403, { error: 'Forbidden' });
        }
        const invoices = await getInvoices({
          memberId,
          status: query.status,
          limit: query.limit ? Number(query.limit) : 50,
        });
        return jsonResponse(200, { invoices });
      }

      if (event.httpMethod === 'GET' && path === '/profile') {
        const profile = await getMemberProfile(memberPayload.memberId);
        if (!profile) {
          return jsonResponse(404, { error: 'Member not found' });
        }
        return jsonResponse(200, profile);
      }

      if (event.httpMethod === 'GET' && path === '/activity') {
        const db = getDb();
        const activity = await getActivityLog(db, {
          memberId: memberPayload.memberId,
          limit: query.limit ? Number(query.limit) : 50,
        });
        return jsonResponse(200, { activity });
      }

      if (event.httpMethod === 'GET' && path === '/events') {
        const events = await getEdirEvents();
        return jsonResponse(200, { events });
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

    if (event.httpMethod === 'GET' && path === '/member') {
      const member = await findMember({ phone: query.phone, email: query.email, id: query.id });
      return jsonResponse(200, { member });
    }

    if (event.httpMethod === 'GET' && path === '/members') {
      const members = await getMembers({ search: query.search, limit: query.limit ? Number(query.limit) : undefined });
      return jsonResponse(200, { members });
    }

    if (event.httpMethod === 'GET' && path === '/invoices') {
      const invoices = await getInvoices({ memberId: query.memberId ? Number(query.memberId) : undefined, email: query.email, status: query.status, limit: query.limit ? Number(query.limit) : undefined });
      return jsonResponse(200, { invoices });
    }

    if (event.httpMethod === 'GET' && path === '/activity') {
      const db = getDb();
      const activity = await getActivityLog(db, {
        memberId: query.memberId ? Number(query.memberId) : undefined,
        limit: query.limit ? Number(query.limit) : 100,
        entityType: query.entityType || undefined,
      });
      return jsonResponse(200, { activity });
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
      const actor = await resolveAdminActor(adminPayload);
      const updated = await updateMember(body, actor);
      if (!updated) {
        return jsonResponse(400, { error: 'Unable to update member' });
      }
      return jsonResponse(200, { member: updated });
    }

    if (event.httpMethod === 'POST' && path === '/invoice') {
      const actor = await resolveAdminActor(adminPayload);
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