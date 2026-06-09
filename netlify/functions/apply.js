// netlify/functions/apply.js — Waiting list & membership application submissions

const { getDb } = require('./db');
const { checkAddressRadius } = require('./geo');
const {
  notifyApplicationSubmitted,
  notifyApplicationApproved,
  notifyApplicationRejected,
} = require('./notify');
const {
  syncApplicationSubmitted,
  syncApplicationReview,
  syncApplicationApproved,
  syncApplicationRejected,
} = require('./sync');
const {
  verifyAdminRequest,
  buildActorFromAdmin,
  buildSystemActor,
} = require('./admin-auth');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const DEFAULT_CHECKLIST = {
  name_match: false,
  fields_complete: false,
  id_uploaded: false,
  fee_paid: false,
};

function json(statusCode, payload) {
  return { statusCode, headers, body: JSON.stringify(payload) };
}

function getPath(event) {
  const base = '/.netlify/functions/apply';
  if (event.path && event.path.startsWith(base)) {
    return event.path.slice(base.length) || '/';
  }
  return event.path || '/';
}

// Queue places 1–11 have joined as members (through Martha Mekonnen).
const ADDED_THROUGH_POSITION = 11;

function markAddedEntries(entries) {
  return (entries || []).map((entry) => ({
    ...entry,
    added: Number(entry.position) <= ADDED_THROUGH_POSITION,
  }));
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function splitName(full) {
  const text = String(full || '').trim();
  if (!text) return { first_name: null, last_name: null, full_name: null };
  const parts = text.split(/\s+/);
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: null, full_name: parts[0] };
  }
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(' '),
    full_name: text,
  };
}

async function submitWaitingList(body) {
  const {
    name,
    first_name: firstIn,
    last_name: lastIn,
    email,
    phone,
    address,
    referred_by,
    message,
  } = body;

  const parsed = name?.trim()
    ? splitName(name)
    : splitName(`${firstIn || ''} ${lastIn || ''}`.trim());

  if (!parsed.full_name || !email?.trim() || !phone?.trim() || !address?.trim()) {
    return json(400, { error: 'Please complete name, email, phone, and address.' });
  }

  const area = await checkAddressRadius(address);
  if (!area.ok) {
    return json(400, { error: area.error, address_check: area });
  }

  const db = getDb();
  const mobile = normPhone(phone);

  const existing = await db.query(
    `SELECT id, status FROM waiting_list
     WHERE LOWER(email) = LOWER($1) OR RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10) = $2
     LIMIT 1`,
    [email.trim(), mobile]
  );

  if (existing.rows.length) {
    const row = existing.rows[0];
    if (row.status !== 'Rejected') {
      return json(409, { error: 'This email or phone is already on the waiting list.' });
    }
  }

  const notes = message?.trim() ? message.trim() : null;

  const result = await db.query(
    `INSERT INTO waiting_list (
      first_name, last_name, full_name, email, phone, address,
      referred_by, applicant_role, notes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'primary',$8)
    RETURNING id, status, applied_at`,
    [
      parsed.first_name,
      parsed.last_name,
      parsed.full_name,
      email.trim().toLowerCase(),
      phone.trim(),
      address.trim(),
      referred_by?.trim() || null,
      notes,
    ]
  );

  return json(201, {
    ok: true,
    message: 'You are on the waiting list. We will contact you when a spot opens.',
    id: result.rows[0].id,
  });
}

async function verifyApproved(body) {
  const { email, phone } = body;
  if (!email?.trim() || !phone?.trim()) {
    return json(400, { error: 'Email and phone from your waiting list sign-up are required.' });
  }

  const db = getDb();
  const mobile = normPhone(phone);

  const result = await db.query(
    `SELECT wl.*,
      EXISTS (SELECT 1 FROM membership_applications ma WHERE ma.waiting_list_id = wl.id) AS has_application
     FROM waiting_list wl
     WHERE LOWER(wl.email) = LOWER($1)
       AND RIGHT(REGEXP_REPLACE(wl.phone, '[^0-9]', '', 'g'), 10) = $2
       AND wl.status NOT IN ('Rejected', 'Canceled')
     LIMIT 1`,
    [email.trim(), mobile]
  );

  if (!result.rows.length) {
    return json(404, {
      error: 'No waiting list record found for this email and phone. Contact the board at (424) 547-5594.',
    });
  }

  const row = result.rows[0];
  if (row.has_application) {
    return json(409, { error: 'A membership application has already been submitted for this waiting list entry.' });
  }

  return json(200, {
    ok: true,
    waiting_list_id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
  });
}

async function getWaitingListStatusFromDb() {
  const db = getDb();
  const result = await db.query(
    `SELECT full_name, first_name, last_name, status, applied_at
     FROM waiting_list
     ORDER BY applied_at ASC NULLS LAST, id ASC`
  );
  if (!result.rows.length) {
    return null;
  }

  const hidden = new Set(['Rejected', 'Canceled']);
  return result.rows
    .map((row, idx) => ({
      row,
      queuePosition: idx + 1,
    }))
    .filter(({ row }) => !hidden.has(row.status))
    .map(({ row, queuePosition }) => ({
      position: queuePosition,
      display_name: row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      applied_date_text: row.applied_at
        ? new Date(row.applied_at).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'America/Los_Angeles',
          })
        : null,
      added: queuePosition <= ADDED_THROUGH_POSITION,
    }));
}

async function getWaitingListStatus() {
  const fromDb = await getWaitingListStatusFromDb();
  if (!fromDb?.length) {
    return json(503, {
      error: 'Waiting list has not been loaded yet. Contact the board at (424) 547-5594.',
    });
  }

  return json(200, {
    ok: true,
    source: 'database',
    count: fromDb.length,
    updated_note: `Places 1–${ADDED_THROUGH_POSITION} have been added as members. #12 is next in line.`,
    entries: fromDb,
  });
}

const MAX_ID_BYTES = 5 * 1024 * 1024;
const ALLOWED_ID_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

function normPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function approxBase64Bytes(data) {
  if (!data) return 0;
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - pad;
}

function sanitizeIdDocument(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const data = typeof doc.data === 'string' ? doc.data.replace(/\s/g, '') : '';
  const mime_type = String(doc.mime_type || '').toLowerCase();
  const filename = String(doc.filename || 'id-upload').slice(0, 255);
  if (!data || !mime_type) return null;
  return {
    filename,
    mime_type,
    size: Number(doc.size) || approxBase64Bytes(data),
    uploaded_at: new Date().toISOString(),
    data,
  };
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

function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesLikelyMatch(appName, wlName) {
  const a = normalizeName(appName);
  const b = normalizeName(wlName);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

function computeAutoChecks(row) {
  const beneficiary = parseJsonField(row.beneficiary_member, {});
  const docs = parseJsonField(row.id_documents, {});
  const phone = row.cell_phone || row.home_phone || row.office_phone || row.wl_phone;
  return {
    name_match: namesLikelyMatch(row.member_full_name, row.wl_full_name),
    fields_complete: !!(
      String(row.member_full_name || '').trim()
      && String(phone || '').trim()
      && String(row.address || row.wl_address || '').trim()
      && String(beneficiary?.name || '').trim()
    ),
    id_uploaded: !!(docs.member && (docs.member.data || docs.member.filename)),
    fee_paid: row.registration_fee_paid === true,
  };
}

function mergeChecklist(stored, auto) {
  const base = { ...DEFAULT_CHECKLIST, ...parseJsonField(stored, {}) };
  return {
    name_match: base.name_match === true,
    fields_complete: base.fields_complete === true,
    id_uploaded: base.id_uploaded === true,
    fee_paid: base.fee_paid === true,
    auto,
  };
}

function checklistComplete(checklist) {
  return checklist.name_match && checklist.fields_complete && checklist.id_uploaded && checklist.fee_paid;
}

function buildApplicationSummary(row, includeIdData = false) {
  const auto = computeAutoChecks(row);
  const checklist = mergeChecklist(row.review_checklist, auto);
  const docs = parseJsonField(row.id_documents, {});
  const idSummary = {};
  if (docs.member) {
    idSummary.member = {
      filename: docs.member.filename,
      mime_type: docs.member.mime_type,
      size: docs.member.size,
      uploaded_at: docs.member.uploaded_at,
    };
    if (includeIdData && docs.member.data && docs.member.mime_type?.startsWith('image/')) {
      idSummary.member.preview = `data:${docs.member.mime_type};base64,${docs.member.data}`;
    }
  }
  if (docs.spouse) {
    idSummary.spouse = {
      filename: docs.spouse.filename,
      mime_type: docs.spouse.mime_type,
      size: docs.spouse.size,
      uploaded_at: docs.spouse.uploaded_at,
    };
    if (includeIdData && docs.spouse.data && docs.spouse.mime_type?.startsWith('image/')) {
      idSummary.spouse.preview = `data:${docs.spouse.mime_type};base64,${docs.spouse.data}`;
    }
  }

  return {
    id: row.id,
    waiting_list_id: row.waiting_list_id,
    status: row.status,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    member_id: row.member_id,
    notes: row.notes,
    member_full_name: row.member_full_name,
    spouse_full_name: row.spouse_full_name,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    home_phone: row.home_phone,
    office_phone: row.office_phone,
    cell_phone: row.cell_phone,
    email: row.email,
    children: parseJsonField(row.children, []),
    beneficiary_member: parseJsonField(row.beneficiary_member, null),
    beneficiary_spouse: parseJsonField(row.beneficiary_spouse, null),
    emergency_contacts: parseJsonField(row.emergency_contacts, []),
    additional_family: parseJsonField(row.additional_family, []),
    waiting_list: {
      full_name: row.wl_full_name,
      email: row.wl_email,
      phone: row.wl_phone,
      address: row.wl_address,
      status: row.wl_status,
    },
    review_checklist: checklist,
    checklist_complete: checklistComplete(checklist),
    id_documents: idSummary,
  };
}

async function listApplications(query) {
  const db = getDb();
  const status = query.status || null;
  let sql = `
    SELECT ma.*,
      wl.full_name AS wl_full_name,
      wl.email AS wl_email,
      wl.phone AS wl_phone,
      wl.address AS wl_address,
      wl.status AS wl_status
    FROM membership_applications ma
    JOIN waiting_list wl ON wl.id = ma.waiting_list_id
  `;
  const values = [];
  if (status) {
    sql += ` WHERE ma.status = $1`;
    values.push(status);
  }
  sql += ` ORDER BY ma.submitted_at DESC NULLS LAST, ma.id DESC`;
  const result = await db.query(sql, values);
  return json(200, {
    applications: result.rows.map((row) => buildApplicationSummary(row, false)),
  });
}

async function getApplication(id) {
  const db = getDb();
  const result = await db.query(
    `SELECT ma.*,
      wl.full_name AS wl_full_name,
      wl.email AS wl_email,
      wl.phone AS wl_phone,
      wl.address AS wl_address,
      wl.status AS wl_status
     FROM membership_applications ma
     JOIN waiting_list wl ON wl.id = ma.waiting_list_id
     WHERE ma.id = $1
     LIMIT 1`,
    [id]
  );
  if (!result.rows.length) {
    return json(404, { error: 'Application not found.' });
  }
  return json(200, { application: buildApplicationSummary(result.rows[0], true) });
}

async function updateApplicationReview(id, body, actor) {
  const db = getDb();
  const existing = await db.query(
    `SELECT id, status, member_id FROM membership_applications WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (!existing.rows.length) {
    return json(404, { error: 'Application not found.' });
  }
  if (existing.rows[0].status === 'Approved' && existing.rows[0].member_id) {
    return json(409, { error: 'Application is already approved and linked to a member.' });
  }

  const checklist = body.review_checklist || {};
  const reviewChecklist = {
    name_match: checklist.name_match === true,
    fields_complete: checklist.fields_complete === true,
    id_uploaded: checklist.id_uploaded === true,
    fee_paid: checklist.fee_paid === true,
  };
  const registrationFeePaid = reviewChecklist.fee_paid;
  const status = body.status || 'Under Review';
  const notes = body.notes != null ? String(body.notes).trim() : null;

  await db.query(
    `UPDATE membership_applications
     SET review_checklist = $1::jsonb,
         registration_fee_paid = $2,
         status = $3,
         notes = COALESCE($4, notes),
         reviewed_at = NOW()
     WHERE id = $5`,
    [JSON.stringify(reviewChecklist), registrationFeePaid, status, notes, id]
  );

  if (actor) {
    try {
      await syncApplicationReview(db, id, status, actor, notes);
    } catch (err) {
      console.error('Application review sync failed:', err);
    }
  }

  return getApplication(id);
}

function splitMemberName(full) {
  const text = String(full || '').trim();
  if (!text) return { first_name: 'Member', last_name: 'Unknown', full_name: 'Member Unknown' };
  const parts = text.split(/\s+/);
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: parts[0], full_name: parts[0] };
  }
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(' '),
    full_name: text,
  };
}

function formatAddress(app) {
  const parts = [app.address, app.city, app.state, app.zip].filter((p) => String(p || '').trim());
  return parts.join(', ') || app.wl_address || null;
}

async function approveApplication(id, body, actor) {
  const db = getDb();
  const result = await db.query(
    `SELECT ma.*,
      wl.full_name AS wl_full_name,
      wl.email AS wl_email,
      wl.phone AS wl_phone,
      wl.address AS wl_address,
      wl.status AS wl_status
     FROM membership_applications ma
     JOIN waiting_list wl ON wl.id = ma.waiting_list_id
     WHERE ma.id = $1
     LIMIT 1`,
    [id]
  );
  if (!result.rows.length) {
    return json(404, { error: 'Application not found.' });
  }

  const row = result.rows[0];
  if (row.status === 'Approved' && row.member_id) {
    return json(409, { error: 'Application already approved.' });
  }

  const incoming = body.review_checklist || parseJsonField(row.review_checklist, DEFAULT_CHECKLIST);
  const checklist = {
    name_match: incoming.name_match === true,
    fields_complete: incoming.fields_complete === true,
    id_uploaded: incoming.id_uploaded === true,
    fee_paid: incoming.fee_paid === true,
  };
  if (!checklistComplete(checklist)) {
    return json(400, {
      error: 'All review items must be checked before approval: name match, required fields, ID upload, and $200 fee.',
      review_checklist: checklist,
    });
  }

  const names = splitMemberName(row.member_full_name || row.wl_full_name);
  const mobile = row.cell_phone || row.home_phone || row.wl_phone;
  const email = (row.email || row.wl_email || '').trim().toLowerCase() || null;
  const address = formatAddress(row);

  const nextNum = await db.query(`SELECT COALESCE(MAX(member_number), 0) + 1 AS num FROM members`);
  const memberNumber = nextNum.rows[0].num;

  const memberInsert = await db.query(
    `INSERT INTO members (
      member_number, status, first_name, last_name, full_name, paypal_name,
      email, mobile, home_phone, address, joined_date, notes
    ) VALUES ($1, 'Active', $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE, $10)
    RETURNING id, member_number, first_name, last_name, full_name, email, mobile, home_phone, address, status`,
    [
      memberNumber,
      names.first_name,
      names.last_name,
      row.member_full_name || names.full_name,
      names.full_name,
      email,
      mobile,
      row.home_phone || null,
      address,
      row.notes ? `Approved from application #${row.id}. ${row.notes}` : `Approved from application #${row.id}.`,
    ]
  );
  const member = memberInsert.rows[0];

  const beneficiary = parseJsonField(row.beneficiary_member, null);
  if (beneficiary?.name) {
    await db.query(
      `INSERT INTO beneficiaries (member_id, name, phone, relationship, is_primary)
       VALUES ($1, $2, $3, $4, true)`,
      [member.id, beneficiary.name, beneficiary.phone || null, beneficiary.relationship || null]
    );
  }

  if (checklist.fee_paid) {
    await db.query(
      `INSERT INTO payments (member_id, amount, method, reference, notes)
       VALUES ($1, 200.00, 'Registration', $2, 'Hibret Edir membership registration fee')`,
      [member.id, `application-${row.id}`]
    );
  }

  await db.query(
    `UPDATE membership_applications
     SET status = 'Approved',
         member_id = $1,
         review_checklist = $2::jsonb,
         registration_fee_paid = $3,
         reviewed_at = NOW()
     WHERE id = $4`,
    [member.id, JSON.stringify(checklist), checklist.fee_paid, id]
  );

  await db.query(
    `UPDATE waiting_list
     SET status = 'Added as Member',
         approved_at = NOW(),
         reviewed_at = NOW(),
         notes = COALESCE(notes || ' ', '') || 'Approved and added to member CRM.'
     WHERE id = $1`,
    [row.waiting_list_id]
  );

  try {
    await notifyApplicationApproved(db, row, member);
  } catch (notifyErr) {
    console.error('Application approve notification failed:', notifyErr);
  }

  if (actor) {
    try {
      await syncApplicationApproved(db, id, member.id, member.member_number, actor);
    } catch (syncErr) {
      console.error('Application approve sync failed:', syncErr);
    }
  }

  return json(200, {
    ok: true,
    message: `${member.full_name} approved and added to Members CRM as #${member.member_number}.`,
    member,
    application_id: id,
  });
}

async function rejectApplication(id, body, actor) {
  const db = getDb();
  const notes = body.notes?.trim() || 'Application rejected by board review.';
  const result = await db.query(
    `UPDATE membership_applications
     SET status = 'Rejected', notes = $1, reviewed_at = NOW()
     WHERE id = $2 AND status NOT IN ('Approved')
     RETURNING id, member_full_name, email, cell_phone, home_phone`,
    [notes, id]
  );
  if (!result.rows.length) {
    return json(404, { error: 'Application not found or already approved.' });
  }

  try {
    await notifyApplicationRejected(db, result.rows[0], notes);
  } catch (notifyErr) {
    console.error('Application reject notification failed:', notifyErr);
  }

  if (actor) {
    try {
      await syncApplicationRejected(db, id, actor, notes);
    } catch (syncErr) {
      console.error('Application reject sync failed:', syncErr);
    }
  }

  return json(200, { ok: true, message: 'Application marked as rejected.' });
}

function sanitizeIdDocumentsOptional(idDocuments, spouseName) {
  const docs = idDocuments && typeof idDocuments === 'object' ? idDocuments : {};
  const payload = {};
  const member = sanitizeIdDocument(docs.member);
  if (member) {
    if (!ALLOWED_ID_MIMES.has(member.mime_type)) {
      return 'Member ID must be a JPG, PNG, WEBP, or PDF file.';
    }
    if (approxBase64Bytes(member.data) > MAX_ID_BYTES) {
      return 'Member ID file is too large (maximum 5 MB).';
    }
    payload.member = member;
  }
  if (spouseName) {
    const spouse = sanitizeIdDocument(docs.spouse);
    if (spouse) {
      if (!ALLOWED_ID_MIMES.has(spouse.mime_type)) {
        return 'Spouse ID must be a JPG, PNG, WEBP, or PDF file.';
      }
      if (approxBase64Bytes(spouse.data) > MAX_ID_BYTES) {
        return 'Spouse ID file is too large (maximum 5 MB).';
      }
      payload.spouse = spouse;
    }
  }
  return payload;
}

async function submitMembership(body) {
  const { waiting_list_id, ...app } = body;
  if (!waiting_list_id) {
    return json(400, { error: 'Waiting list reference is required.' });
  }

  const db = getDb();
  const wl = await db.query(
    `SELECT * FROM waiting_list
     WHERE id = $1 AND status NOT IN ('Rejected', 'Canceled')
     LIMIT 1`,
    [waiting_list_id]
  );
  if (!wl.rows.length) {
    return json(403, { error: 'Waiting list entry not found.' });
  }

  const existing = await db.query(
    `SELECT id FROM membership_applications WHERE waiting_list_id = $1 LIMIT 1`,
    [waiting_list_id]
  );
  if (existing.rows.length) {
    return json(409, { error: 'Membership application already submitted.' });
  }

  const row = wl.rows[0];
  const memberName = app.member_full_name?.trim() || row.full_name;
  const spouseName = app.spouse_full_name?.trim() || null;
  const applicant_role = 'primary';

  const idCheck = sanitizeIdDocumentsOptional(app.id_documents, spouseName);
  if (typeof idCheck === 'string') {
    return json(400, { error: idCheck });
  }

  const insertResult = await db.query(
    `INSERT INTO membership_applications (
      waiting_list_id, member_full_name, spouse_full_name, address, city, state, zip,
      home_phone, office_phone, cell_phone, email, children,
      beneficiary_member, beneficiary_spouse, emergency_contacts, additional_family,
      id_documents, applicant_role, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'Submitted')
    RETURNING id, member_full_name, email, cell_phone, home_phone`,
    [
      waiting_list_id,
      memberName,
      spouseName,
      app.address?.trim() || row.address,
      app.city?.trim() || null,
      app.state?.trim() || 'CA',
      app.zip?.trim() || null,
      app.home_phone?.trim() || null,
      app.office_phone?.trim() || null,
      app.cell_phone?.trim() || row.phone,
      app.email?.trim()?.toLowerCase() || row.email,
      JSON.stringify(app.children || []),
      JSON.stringify(app.beneficiary_member || null),
      JSON.stringify(app.beneficiary_spouse || null),
      JSON.stringify(app.emergency_contacts || []),
      JSON.stringify(app.additional_family || []),
      JSON.stringify(idCheck),
      applicant_role,
    ]
  );

  await db.query(
    `UPDATE waiting_list SET status = 'Application Submitted',
      notes = COALESCE(notes || ' ', '') || 'Membership form submitted (board to verify names match waiting list).'
     WHERE id = $1`,
    [waiting_list_id]
  );

  try {
    await notifyApplicationSubmitted(db, insertResult.rows[0]);
  } catch (notifyErr) {
    console.error('Application submit notification failed:', notifyErr);
  }

  try {
    await syncApplicationSubmitted(
      db,
      insertResult.rows[0].id,
      waiting_list_id,
      memberName,
      buildSystemActor('Application Form')
    );
  } catch (syncErr) {
    console.error('Application submit sync failed:', syncErr);
  }

  return json(201, {
    ok: true,
    message: 'Membership application received. The board will review your information and contact you about the $200 registration fee.',
    application_id: insertResult.rows[0].id,
  });
}

function matchApplicationPath(path) {
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'applications') return null;
  const id = parts[1] ? Number(parts[1]) : null;
  const action = parts[2] || null;
  return { id, action };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const path = getPath(event);
  const appPath = matchApplicationPath(path);

  if (appPath && ['GET', 'PATCH', 'POST'].includes(event.httpMethod)) {
    const admin = verifyAdminRequest(event);
    if (!admin) {
      return json(401, { error: 'Admin authorization required. Please sign in.' });
    }
    const actor = await resolveAdminActor(admin);
    try {
      if (event.httpMethod === 'GET' && !appPath.id) {
        return await listApplications(event.queryStringParameters || {});
      }
      if (event.httpMethod === 'GET' && appPath.id && !appPath.action) {
        return await getApplication(appPath.id);
      }
      const body = parseBody(event);
      if (event.httpMethod === 'PATCH' && appPath.id && !appPath.action) {
        return await updateApplicationReview(appPath.id, body, actor);
      }
      if (event.httpMethod === 'POST' && appPath.id && appPath.action === 'approve') {
        return await approveApplication(appPath.id, body, actor);
      }
      if (event.httpMethod === 'POST' && appPath.id && appPath.action === 'reject') {
        return await rejectApplication(appPath.id, body, actor);
      }
      return json(404, { error: 'Not found' });
    } catch (err) {
      console.error('applications admin error:', err);
      if (err.message?.includes('DATABASE_URL')) {
        return json(503, { error: 'Database is not configured.' });
      }
      return json(500, { error: 'Could not process application review.' });
    }
  }

  if (event.httpMethod === 'GET') {
    if (path === '/waiting-list/status' || path === '/waiting-list/status/') {
      try {
        return await getWaitingListStatus();
      } catch (err) {
        console.error('waiting list status error:', err);
        if (err.message?.includes('DATABASE_URL')) {
          return json(503, {
            error: 'Database is not configured. Waiting list status is unavailable.',
          });
        }
        return json(503, {
          error: 'Could not load waiting list status. Try again later or call (424) 547-5594.',
        });
      }
    }
    if (path === '/validate-address' || path === '/validate-address/') {
      const address = event.queryStringParameters?.address;
      if (!address?.trim()) {
        return json(400, { error: 'Address is required.' });
      }
      try {
        const result = await checkAddressRadius(address);
        if (!result.ok) {
          return json(400, { ok: false, error: result.error, ...result });
        }
        return json(200, { ok: true, ...result });
      } catch (err) {
        console.error('address validate error:', err);
        return json(503, {
          error: 'Address check is temporarily unavailable. Please try again or call (424) 547-5594.',
        });
      }
    }
    return json(404, { error: 'Not found' });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const body = parseBody(event);

  try {
    if (path === '/waiting-list' || path === '/waiting-list/') {
      return await submitWaitingList(body);
    }
    if (path === '/verify' || path === '/verify/') {
      return await verifyApproved(body);
    }
    if (path === '/membership' || path === '/membership/') {
      return await submitMembership(body);
    }
    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error('apply.js error:', err);
    if (err.message?.includes('DATABASE_URL')) {
      return json(503, { error: 'Database is not configured yet. Your form was not saved — please try again later or call (424) 547-5594.' });
    }
    return json(500, { error: 'Something went wrong. Please try again or call (424) 547-5594.' });
  }
};
