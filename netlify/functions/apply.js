// netlify/functions/apply.js — Waiting list & membership application submissions

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { checkAddressRadius, parseAddressForForm } = require('./geo');
const {
  notifyWaitingListInvited,
  notifyApplicationSubmitted,
  notifyApplicationRejected,
  notifyRegistrationInvoiceSent,
  notifyBoard,
  notifyMember,
  buildBoardReplyEmail,
  getPublicSiteUrl,
  notifyBeneficiaryChangeApproved,
  notifyBeneficiaryChangeRejected,
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
const {
  loadBoardMemberAccess,
  assertCanWriteAll,
  assertCanApproveOperations,
  assertCanManageBoard,
  assertPerm,
  hasPerm,
  assertNotesOnlyUpdate,
  assertNotRestrictedMembersOnly,
  WRITE_DENIED_MSG,
} = require('./board-permissions');
const { stampBoardNote, mergeBoardNotes } = require('./board-notes');
const { invalidateInvoiceStatsCache } = require('./invoice-stats-cache');
const { logActivity } = require('./audit');
const {
  getCurrentAnnouncementFromDb,
  searchDeceasedInCrm,
  getFundCollectionHint,
  listEventsForAnnouncement,
  getEventAnnouncementAdmin,
  getMemorialAnnouncementAdmin,
  saveEventAnnouncement,
  saveMemorialAnnouncementOnly,
  listServiceVenues,
} = require('./event-announcement');
const { createAndSendRegistrationInvoice } = require('./paypal-registration-invoice');
const {
  completeMembershipFromApplication,
  fetchApplicationForCompletion,
  REGISTRATION_FEE,
} = require('./membership-completion');
const {
  isDemoQaEnabled,
  getDemoQaStatus,
  getDemoQaEmail,
  resetDemoQaCycle,
  isDemoQaInviteEligible,
  isQaReservedSlotConfigured,
  getProductionMemberCap,
  isDemoQaWaitingListRow,
} = require('./demo-qa-reset');
const { buildMonitorHealthDashboard } = require('./demo-qa-dashboard');

const MEMBER_CAP = Number(process.env.MEMBER_CAP || 200);
const WAITING_LIST_PIPELINE_STATUSES = ['Invited to Apply', 'Application Submitted'];
// Imported rows may use Registered; new sign-ups use Pending — both are in the queue.
const WAITING_LIST_QUEUE_STATUSES = ['Pending', 'Registered'];

function isWaitingListQueueAwaiting(status) {
  return WAITING_LIST_QUEUE_STATUSES.includes(status);
}

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

function publicWaitingListStatusLabel(status) {
  const labels = publicWaitingListStatusLabels(status);
  return labels.en;
}

function publicWaitingListStatusLabels(status) {
  if (status === 'Added as Member') return { en: 'Added', am: 'ተጨምሯል' };
  if (status === 'Registered') return { en: 'Registered', am: 'ተመዝግቧል' };
  if (status === 'Invited to Apply') return { en: 'Invitation Sent', am: 'ግብአት ተላልፏል' };
  if (status === 'Application Submitted') return { en: 'Invitation Sent', am: 'ግብአት ተላልፏል' };
  if (status === 'Canceled') return { en: 'Canceled', am: 'ተሰርዟል' };
  if (status === 'Rejected') return { en: 'Removed', am: 'ተወግዷል' };
  return { en: 'Pending', am: 'በመጠባበቅ ላይ' };
}

function isWaitingListPublicAdded(row) {
  return row.status === 'Added as Member';
}

function waitingListDisplayName(row) {
  return row.full_name
    || `${row.first_name || ''} ${row.last_name || ''}`.trim()
    || row.email
    || '—';
}

function formatWaitingListAppliedDate(appliedAt) {
  if (!appliedAt) return null;
  return new Date(appliedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
}

/** Single DB query — same order for Admin waiting list and public status. */
async function queryWaitingListOrdered(db) {
  const result = await db.query(
    `SELECT wl.*,
      EXISTS (SELECT 1 FROM membership_applications ma WHERE ma.waiting_list_id = wl.id) AS has_application
     FROM waiting_list wl
     ORDER BY wl.applied_at ASC NULLS LAST, wl.id ASC`
  );
  return result.rows;
}

/** Public status hides removed and already-active members; Admin shows full queue. */
const WAITING_LIST_PUBLIC_HIDDEN = new Set(['Rejected', 'Canceled', 'Added as Member']);

function rowToPublicStatusEntry(row, displayRank) {
  const labels = publicWaitingListStatusLabels(row.status);
  return {
    position: displayRank,
    display_name: waitingListDisplayName(row),
    applied_date_text: formatWaitingListAppliedDate(row.applied_at),
    status: row.status,
    status_label: labels.en,
    status_label_en: labels.en,
    status_label_am: labels.am,
    added: isWaitingListPublicAdded(row),
  };
}

/** Same # as Admin/public: pending_rank for invite queue; pipeline rank once invited. */
function waitingListDisplayRank({ pending_rank, active_pipeline_rank, queue_position }) {
  if (pending_rank != null) return pending_rank;
  if (active_pipeline_rank != null) return active_pipeline_rank;
  return queue_position;
}

function enrichWaitingListQueue(rows, slots = null) {
  let pendingRank = 0;
  let activePipelineRank = 0;
  return rows.map((row, idx) => {
    const queue_position = idx + 1;
    let pending_rank = null;
    let eligible_for_invite = false;
    if (isWaitingListQueueAwaiting(row.status)) {
      pendingRank += 1;
      pending_rank = pendingRank;
      if (slots) {
        eligible_for_invite = pendingRank <= slots.invite_slots_remaining
          || isDemoQaInviteEligible(row, slots);
      }
    }
    let active_pipeline_rank = null;
    if (!WAITING_LIST_PUBLIC_HIDDEN.has(row.status)) {
      activePipelineRank += 1;
      active_pipeline_rank = activePipelineRank;
    }
    const display_rank = waitingListDisplayRank({
      pending_rank,
      active_pipeline_rank,
      queue_position,
    });
    return {
      row,
      queue_position,
      pending_rank,
      active_pipeline_rank,
      eligible_for_invite,
      display_rank,
    };
  });
}

function markAddedEntries(entries) {
  return (entries || []).map((entry) => {
    const added = entry.status
      ? entry.status === 'Added as Member'
      : entry.added === true;
    const labels = entry.status
      ? publicWaitingListStatusLabels(entry.status)
      : { en: added ? 'Added' : 'Pending', am: added ? 'ተጨምሯል' : 'በመጠባበቅ ላይ' };
    return {
      ...entry,
      added,
      status: entry.status || (added ? 'Added as Member' : 'Pending'),
      status_label: labels.en,
      status_label_en: labels.en,
      status_label_am: labels.am,
    };
  });
}

function loadStaticWaitingListStatus() {
  try {
    const filePath = path.join(__dirname, '../../public/waiting-list-public.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data?.entries?.length) return null;
    const addedThrough = data.added_through_position ?? 0;
    return {
      entries: markAddedEntries(data.entries),
      addedThrough,
      updatedNote: data.note || data.updated_note || '',
      count: data.count || data.entries.length,
      updatedAt: data.updated_at || new Date().toISOString(),
      source: 'static',
    };
  } catch {
    return null;
  }
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
  if (isWaitingListQueueAwaiting(row.status)) {
    return json(403, {
      error: 'The board has not invited you to apply yet. You will receive an email when it is your turn.',
    });
  }
  if (row.status !== 'Invited to Apply') {
    return json(403, {
      error: 'Your waiting list entry is not open for application. Contact the board at (424) 547-5594.',
    });
  }

  const parsedAddress = await parseAddressForForm(row.address);

  return json(200, {
    ok: true,
    waiting_list_id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    address: parsedAddress.address || row.address,
    city: parsedAddress.city || '',
    state: parsedAddress.state || 'CA',
    zip: parsedAddress.zip || '',
  });
}

async function getWaitingListAddedThrough(db) {
  const res = await db.query(`
    WITH ordered AS (
      SELECT status,
             ROW_NUMBER() OVER (ORDER BY applied_at ASC NULLS LAST, id ASC) AS position
      FROM waiting_list
      WHERE status NOT IN ('Rejected', 'Canceled')
    )
    SELECT COALESCE(MAX(position), 0)::int AS added_through
    FROM ordered
    WHERE status = 'Added as Member'
  `);
  const n = Number(res.rows[0]?.added_through || 0);
  return n;
}

async function getWaitingListAddedCount(db) {
  const res = await db.query(
    `SELECT COUNT(*)::int AS c FROM waiting_list WHERE status = 'Added as Member'`
  );
  return Number(res.rows[0]?.c || 0);
}

async function getWaitingListStatusFromDb() {
  const db = getDb();
  const [rows, joinedThrough, addedCount] = await Promise.all([
    queryWaitingListOrdered(db),
    getWaitingListAddedThrough(db),
    getWaitingListAddedCount(db),
  ]);
  if (!rows.length) {
    return null;
  }

  const enriched = enrichWaitingListQueue(rows);
  const entries = enriched
    .filter(({ row }) => !WAITING_LIST_PUBLIC_HIDDEN.has(row.status))
    .map(({ row, display_rank }) => rowToPublicStatusEntry(row, display_rank));

  if (!entries.length) {
    return null;
  }

  return { entries, addedThrough: joinedThrough, addedCount };
}

function buildWaitingListStatusPayload(source, fromData) {
  const nextEntry = fromData.entries.find((e) => e.status === 'Pending' || e.status === 'Registered')
    || fromData.entries.find((e) => !e.added);
  const nextPosition = nextEntry?.position;
  const addedCount = fromData.addedCount ?? fromData.entries.filter((e) => e.added).length;
  const updatedNote = fromData.updatedNote
    || (nextPosition
      ? `${addedCount} member${addedCount === 1 ? '' : 's'} added so far. #${nextPosition} is next in line.`
      : `${addedCount} member${addedCount === 1 ? '' : 's'} added so far.`);

  return json(200, {
    ok: true,
    source,
    count: fromData.count ?? fromData.entries.length,
    added_through_position: fromData.addedThrough ?? addedCount,
    added_count: addedCount,
    updated_note: updatedNote,
    updated_at: fromData.updatedAt || new Date().toISOString(),
    entries: fromData.entries,
  });
}

async function getWaitingListStatus() {
  if (!process.env.DATABASE_URL) {
    const fromStatic = loadStaticWaitingListStatus();
    if (fromStatic?.entries?.length) {
      return buildWaitingListStatusPayload('static', fromStatic);
    }
    return json(503, {
      error: 'Waiting list is not available. Contact the board at (424) 547-5594.',
    });
  }

  try {
    const fromDb = await getWaitingListStatusFromDb();
    if (fromDb?.entries?.length) {
      return buildWaitingListStatusPayload('database', {
        ...fromDb,
        updatedAt: new Date().toISOString(),
      });
    }
    return json(200, {
      ok: true,
      source: 'database',
      count: 0,
      added_through_position: 0,
      added_count: 0,
      updated_note: 'No one on the waiting list yet.',
      updated_at: new Date().toISOString(),
      entries: [],
    });
  } catch (err) {
    console.error('waiting list status DB read failed:', err.message || err);
    return json(503, {
      error: 'Could not load waiting list. Try again later or call (424) 547-5594.',
    });
  }
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

function checklistCompleteForVetting(checklist) {
  return checklist.name_match && checklist.fields_complete && checklist.id_uploaded;
}

function checklistComplete(checklist) {
  return checklistCompleteForVetting(checklist) && checklist.fee_paid;
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
    checklist_complete: checklistCompleteForVetting(checklist),
    registration_invoice: row.reg_invoice_id
      ? {
          id: row.reg_invoice_id,
          status: row.reg_invoice_status,
          paypal_link: row.reg_paypal_link,
          invoice_number: row.reg_invoice_number,
          amount: row.reg_invoice_amount != null ? Number(row.reg_invoice_amount) : REGISTRATION_FEE,
        }
      : null,
    id_documents: idSummary,
    applicant_signature: parseJsonField(row.applicant_signature, null),
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
      wl.status AS wl_status,
      ri.id AS reg_invoice_id,
      ri.status AS reg_invoice_status,
      ri.paypal_link AS reg_paypal_link,
      ri.invoice_number AS reg_invoice_number,
      ri.amount AS reg_invoice_amount
    FROM membership_applications ma
    JOIN waiting_list wl ON wl.id = ma.waiting_list_id
    LEFT JOIN invoices ri ON ri.id = ma.registration_invoice_id
  `;
  const values = [];
  if (status) {
    sql += ` WHERE ma.status = $1`;
    values.push(status);
  }
  sql += ` ORDER BY ma.submitted_at DESC NULLS LAST, ma.id DESC`;
  const result = await db.query(sql, values);
  let changeRows = [];
  try {
    changeRows = await listChangeRequests(db);
  } catch (err) {
    console.warn('Change requests unavailable:', err.message);
  }
  const membershipApps = result.rows.map((row) => buildApplicationSummary(row, false));
  const changeApps = changeRows
    .filter((row) => !status || row.status === status)
    .map(buildChangeRequestSummary);
  const combined = [...changeApps, ...membershipApps].sort((a, b) => {
    const da = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
    const db = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
    return db - da;
  });
  return json(200, { applications: combined });
}

async function getApplication(id) {
  const db = getDb();
  const result = await db.query(
    `SELECT ma.*,
      wl.full_name AS wl_full_name,
      wl.email AS wl_email,
      wl.phone AS wl_phone,
      wl.address AS wl_address,
      wl.status AS wl_status,
      ri.id AS reg_invoice_id,
      ri.status AS reg_invoice_status,
      ri.paypal_link AS reg_paypal_link,
      ri.invoice_number AS reg_invoice_number,
      ri.amount AS reg_invoice_amount
     FROM membership_applications ma
     JOIN waiting_list wl ON wl.id = ma.waiting_list_id
     LEFT JOIN invoices ri ON ri.id = ma.registration_invoice_id
     WHERE ma.id = $1
     LIMIT 1`,
    [id]
  );
  if (!result.rows.length) {
    return json(404, { error: 'Application not found.' });
  }
  return json(200, { application: buildApplicationSummary(result.rows[0], true) });
}

async function getApplicationForMember(db, memberId, includeIdData = true) {
  const result = await db.query(
    `SELECT ma.*,
      wl.full_name AS wl_full_name,
      wl.email AS wl_email,
      wl.phone AS wl_phone,
      wl.address AS wl_address,
      wl.status AS wl_status,
      ri.id AS reg_invoice_id,
      ri.status AS reg_invoice_status,
      ri.paypal_link AS reg_paypal_link,
      ri.invoice_number AS reg_invoice_number,
      ri.amount AS reg_invoice_amount
     FROM membership_applications ma
     JOIN waiting_list wl ON wl.id = ma.waiting_list_id
     LEFT JOIN invoices ri ON ri.id = ma.registration_invoice_id
     WHERE ma.member_id = $1
     ORDER BY ma.submitted_at DESC NULLS LAST, ma.id DESC
     LIMIT 1`,
    [memberId]
  );
  if (!result.rows.length) return null;
  return buildApplicationSummary(result.rows[0], includeIdData);
}

async function updateApplicationReview(id, body, actor, access) {
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
  if (existing.rows[0].status === 'Awaiting Payment') {
    return json(409, { error: 'Application is awaiting payment — use Mark Registration Paid after fee is received.' });
  }

  if (!hasPerm(access, 'applications_review')) {
    if (!hasPerm(access, 'board_notes')) {
      return json(403, { error: WRITE_DENIED_MSG });
    }
    const notesErr = assertNotesOnlyUpdate(body, ['notes']);
    if (notesErr && notesErr !== WRITE_DENIED_MSG) {
      return json(400, { error: notesErr });
    }
    if (notesErr === WRITE_DENIED_MSG) {
      return json(403, { error: notesErr });
    }
    const prevNotes = await db.query(`SELECT notes FROM membership_applications WHERE id = $1 LIMIT 1`, [id]);
    const notes = mergeBoardNotes(prevNotes.rows[0]?.notes, body.notes, actor?.actor_label || 'Board');
    await db.query(
      `UPDATE membership_applications SET notes = $1, reviewed_at = NOW() WHERE id = $2`,
      [notes, id]
    );
    return getApplication(id);
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
  const prevNotes = await db.query(`SELECT notes FROM membership_applications WHERE id = $1 LIMIT 1`, [id]);
  const notes = body.notes != null
    ? mergeBoardNotes(prevNotes.rows[0]?.notes, body.notes, actor?.actor_label || 'Board')
    : null;

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

async function approveForPayment(id, body, actor) {
  const db = getDb();
  const row = await fetchApplicationForCompletion(db, id);
  if (!row) {
    return json(404, { error: 'Application not found.' });
  }
  if (row.status === 'Approved' && row.member_id) {
    return json(409, { error: 'Application already approved and linked to a member.' });
  }
  if (row.status === 'Awaiting Payment') {
    return json(409, { error: 'Registration invoice already sent — awaiting payment.' });
  }
  if (row.status === 'Rejected') {
    return json(409, { error: 'Cannot approve a rejected application.' });
  }

  const incoming = body.review_checklist || parseJsonField(row.review_checklist, DEFAULT_CHECKLIST);
  const checklist = {
    name_match: incoming.name_match === true,
    fields_complete: incoming.fields_complete === true,
    id_uploaded: incoming.id_uploaded === true,
    fee_paid: false,
  };
  if (!checklistCompleteForVetting(checklist)) {
    return json(400, {
      error: 'All review items must be checked before sending invoice: name match, required fields, and ID upload.',
      review_checklist: checklist,
    });
  }

  let paypalResult;
  try {
    paypalResult = await createAndSendRegistrationInvoice(row);
  } catch (err) {
    console.error('Registration PayPal invoice failed:', err);
    return json(502, {
      error: `Could not send PayPal registration invoice: ${err.message}`,
    });
  }

  let invoiceId = row.registration_invoice_id || null;
  if (!invoiceId && paypalResult.paypal_invoice_id) {
    const existing = await db.query(
      `SELECT id FROM invoices
       WHERE paypal_invoice_id = $1 OR membership_application_id = $2
       ORDER BY id DESC LIMIT 1`,
      [paypalResult.paypal_invoice_id, id]
    );
    invoiceId = existing.rows[0]?.id || null;
  }
  if (!invoiceId) {
    const invInsert = await db.query(
      `INSERT INTO invoices (
         paypal_invoice_id, invoice_number, membership_application_id,
         status, amount, amount_due, sent_date, paypal_link, recipient_name
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        paypalResult.paypal_invoice_id || null,
        null,
        id,
        paypalResult.status || 'Unpaid',
        REGISTRATION_FEE,
        REGISTRATION_FEE,
        paypalResult.sent_date || new Date().toISOString().slice(0, 10),
        paypalResult.paypal_link || null,
        paypalResult.recipient_name || row.member_full_name,
      ]
    );
    invoiceId = invInsert.rows[0].id;
  } else {
    await db.query(
      `UPDATE invoices
       SET paypal_invoice_id = COALESCE(paypal_invoice_id, $2),
           membership_application_id = COALESCE(membership_application_id, $3),
           status = $4,
           amount = $5,
           amount_due = $6,
           sent_date = COALESCE(sent_date, $7),
           paypal_link = COALESCE(paypal_link, $8),
           recipient_name = COALESCE(recipient_name, $9),
           updated_at = NOW()
       WHERE id = $1`,
      [
        invoiceId,
        paypalResult.paypal_invoice_id || null,
        id,
        paypalResult.status || 'Unpaid',
        REGISTRATION_FEE,
        REGISTRATION_FEE,
        paypalResult.sent_date || new Date().toISOString().slice(0, 10),
        paypalResult.paypal_link || null,
        paypalResult.recipient_name || row.member_full_name,
      ]
    );
  }

  await db.query(
    `UPDATE membership_applications
     SET status = 'Awaiting Payment',
         review_checklist = $1::jsonb,
         registration_fee_paid = FALSE,
         registration_invoice_id = $2,
         reviewed_at = NOW(),
         notes = CASE WHEN $3::text IS NOT NULL
           THEN TRIM(BOTH FROM COALESCE(notes, '') || E'\n' || $3)
           ELSE notes END
     WHERE id = $4`,
    [
      JSON.stringify(checklist),
      invoiceId,
      body.notes ? stampBoardNote(body.notes, actor?.actor_label) : null,
      id,
    ]
  );

  invalidateInvoiceStatsCache();

  try {
    await notifyRegistrationInvoiceSent(db, row, paypalResult);
  } catch (notifyErr) {
    console.error('Registration invoice notification failed:', notifyErr);
  }

  if (actor) {
    await logActivity(db, {
      ...actor,
      action: 'application.invoice_sent',
      entity_type: 'membership_applications',
      table_name: 'membership_applications',
      record_id: id,
      new_value: {
        invoice_id: invoiceId,
        paypal_invoice_id: paypalResult.paypal_invoice_id || null,
        amount: REGISTRATION_FEE,
        paypal_skipped: paypalResult.skipped === true,
      },
      summary: `Registration invoice sent to ${row.member_full_name || 'applicant'} ($${REGISTRATION_FEE})`,
    });
  }

  const message = paypalResult.skipped
    ? `${row.member_full_name} approved for payment. PayPal is not configured — record the $${REGISTRATION_FEE} fee manually, then mark registration paid.`
    : `$${REGISTRATION_FEE} PayPal registration invoice sent to ${paypalResult.recipient_email || row.email}. Member will be added automatically when payment is received.`;

  return json(200, {
    ok: true,
    message,
    application_id: id,
    registration_invoice: {
      id: invoiceId,
      paypal_link: paypalResult.paypal_link || null,
      paypal_configured: !paypalResult.skipped,
    },
  });
}

async function completeRegistrationApplication(id, body, actor) {
  const db = getDb();
  const row = await fetchApplicationForCompletion(db, id);
  if (!row) {
    return json(404, { error: 'Application not found.' });
  }
  if (row.status === 'Approved' && row.member_id) {
    return json(409, { error: 'Application already approved.' });
  }
  if (row.status !== 'Awaiting Payment') {
    return json(400, {
      error: 'Application must be awaiting payment. Use Approve & Send Invoice after board review.',
    });
  }

  const result = await completeMembershipFromApplication(db, id, actor, {
    paymentMethod: body.payment_method || body.paymentMethod || 'Zelle & BofA',
    paymentReference: body.payment_reference || `manual-application-${id}`,
    source: actor?.actor_label || 'Board',
    force: true,
  });

  if (!result.ok) {
    return json(500, { error: 'Could not complete membership.' });
  }

  return json(200, {
    ok: true,
    message: `${result.member.full_name} added to Members CRM as #${result.member.member_number}.`,
    member: result.member,
    application_id: id,
  });
}

async function rejectApplication(id, body, actor) {
  const db = getDb();
  const notes = stampBoardNote(
    body.notes?.trim() || 'Application rejected by board review.',
    actor?.actor_label || 'Board'
  );
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

function validateMembershipFields(app) {
  const ben = app.beneficiary_member || {};
  const benRequired = [
    ['name', 'Full Name'],
    ['relationship', 'Relationship'],
    ['phone', 'Phone'],
    ['email', 'Email'],
    ['address', 'Address'],
  ];
  for (const [key, label] of benRequired) {
    if (!String(ben[key] || '').trim()) {
      return `Death Beneficiary (For Member): ${label} is required.`;
    }
  }
  const emergency = (app.emergency_contacts || []).filter(
    (row) => String(row?.name || '').trim() && String(row?.phone || '').trim()
  );
  if (!emergency.length) {
    return 'At least one emergency contact must include full name and phone.';
  }
  const sigName = String(app.applicant_signature?.name || '').trim();
  if (sigName.length < 2) {
    return 'Please type your full name to sign the application.';
  }
  if (app.applicant_signature?.agreed !== true) {
    return 'You must certify that the information is accurate before submitting.';
  }
  return null;
}

function buildApplicantSignature(app) {
  const name = String(app.applicant_signature?.name || '').trim();
  return {
    name,
    agreed: true,
    signed_at: new Date().toISOString(),
  };
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
  const wlRow = wl.rows[0];
  if (wlRow.status !== 'Invited to Apply') {
    return json(403, {
      error: isWaitingListQueueAwaiting(wlRow.status)
        ? 'You must be invited by the board before submitting the membership application.'
        : 'This waiting list entry cannot accept a new application.',
    });
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

  const fieldError = validateMembershipFields(app);
  if (fieldError) {
    return json(400, { error: fieldError });
  }
  const applicantSignature = buildApplicantSignature(app);

  const insertResult = await db.query(
    `INSERT INTO membership_applications (
      waiting_list_id, member_full_name, spouse_full_name, address, city, state, zip,
      home_phone, office_phone, cell_phone, email, children,
      beneficiary_member, beneficiary_spouse, emergency_contacts, additional_family,
      id_documents, applicant_signature, applicant_role, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'Submitted')
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
      JSON.stringify(applicantSignature),
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
    message: 'Membership application received. The board will review your information. If approved, you will receive a PayPal invoice for the $200 registration fee.',
    application_id: insertResult.rows[0].id,
  });
}

async function listChangeRequests(db) {
  const result = await db.query(
    `SELECT mcr.*,
      m.first_name, m.last_name, m.full_name, m.paypal_name, m.email, m.mobile, m.member_number
     FROM member_change_requests mcr
     JOIN members m ON m.id = mcr.member_id
     WHERE NOT (mcr.status = 'Rejected' AND COALESCE(mcr.notes, '') LIKE '%Superseded%')
     ORDER BY mcr.submitted_at DESC NULLS LAST, mcr.id DESC`
  );
  return result.rows;
}

function buildChangeRequestSummary(row) {
  const payload = parseJsonField(row.payload, {});
  const previous = row.previous_payload ? parseJsonField(row.previous_payload, null) : null;
  const name = row.full_name || `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.paypal_name;
  return {
    id: `cr-${row.id}`,
    change_request_id: row.id,
    kind: 'beneficiary_change',
    status: row.status,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    member_id: row.member_id,
    member_full_name: name,
    email: row.email,
    request_type: row.request_type,
    beneficiary_member: payload,
    previous_beneficiary: previous,
    is_new_beneficiary: !previous?.name,
    notes: row.notes,
    review_checklist: { beneficiary_review: row.status === 'Approved' },
  };
}

async function getChangeRequest(id) {
  const db = getDb();
  const result = await db.query(
    `SELECT mcr.*,
      m.first_name, m.last_name, m.full_name, m.paypal_name, m.email, m.mobile, m.member_number
     FROM member_change_requests mcr
     JOIN members m ON m.id = mcr.member_id
     WHERE mcr.id = $1 LIMIT 1`,
    [id]
  );
  if (!result.rows.length) return json(404, { error: 'Change request not found.' });
  return json(200, { application: buildChangeRequestSummary(result.rows[0]) });
}

async function applyBeneficiaryPayload(db, memberId, payload) {
  const name = payload.name?.trim();
  const phone = payload.phone?.trim();
  const relationship = payload.relationship?.trim();
  if (!name || !phone || !relationship) {
    throw new Error('Invalid beneficiary payload.');
  }
  const existing = await db.query(
    `SELECT id FROM beneficiaries WHERE member_id = $1 AND is_primary = true LIMIT 1`,
    [memberId]
  );
  if (existing.rows.length) {
    await db.query(
      `UPDATE beneficiaries SET name = $1, phone = $2, relationship = $3 WHERE id = $4`,
      [name, phone, relationship, existing.rows[0].id]
    );
  } else {
    await db.query(
      `INSERT INTO beneficiaries (member_id, name, phone, relationship, is_primary)
       VALUES ($1, $2, $3, $4, true)`,
      [memberId, name, phone, relationship]
    );
  }
}

async function fetchMemberForNotify(db, memberId) {
  const result = await db.query(
    `SELECT id, member_number, first_name, last_name, full_name, email, mobile, home_phone
     FROM members WHERE id = $1 LIMIT 1`,
    [memberId]
  );
  return result.rows[0] || null;
}

async function approveChangeRequest(id, body, actor) {
  const db = getDb();
  const existing = await db.query(
    `SELECT * FROM member_change_requests WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (!existing.rows.length) return json(404, { error: 'Change request not found.' });
  const row = existing.rows[0];
  if (row.status === 'Approved') return json(409, { error: 'Already approved.' });
  const payload = parseJsonField(row.payload, {});
  const previous = row.previous_payload ? parseJsonField(row.previous_payload, null) : null;
  await applyBeneficiaryPayload(db, row.member_id, payload);
  await db.query(
    `UPDATE member_change_requests SET status = 'Approved', reviewed_at = NOW(), reviewed_by = $1, notes = COALESCE($2, notes) WHERE id = $3`,
    [actor?.actor_label || 'Board', body.notes || null, id]
  );
  try {
    const { syncBeneficiaryUpdate } = require('./sync');
    await syncBeneficiaryUpdate(db, row.member_id, payload, !previous?.name, actor, { pending: false });
  } catch (err) {
    console.error('Approve change sync failed:', err);
  }
  try {
    const member = await fetchMemberForNotify(db, row.member_id);
    if (member) {
      await notifyBeneficiaryChangeApproved(db, member, payload, !previous?.name, previous);
    }
  } catch (notifyErr) {
    console.error('Beneficiary approve notification failed:', notifyErr);
  }
  return getChangeRequest(id);
}

async function rejectChangeRequest(id, body, actor) {
  const db = getDb();
  const existing = await db.query(
    `SELECT * FROM member_change_requests WHERE id = $1 LIMIT 1`,
    [id]
  );
  if (!existing.rows.length) return json(404, { error: 'Change request not found.' });
  const row = existing.rows[0];
  const payload = parseJsonField(row.payload, {});
  const result = await db.query(
    `UPDATE member_change_requests
     SET status = 'Rejected', reviewed_at = NOW(), reviewed_by = $1, notes = COALESCE($2, notes)
     WHERE id = $3
     RETURNING id`,
    [actor?.actor_label || 'Board', body.notes ? mergeBoardNotes(row.notes, body.notes, actor?.actor_label || 'Board') : null, id]
  );
  if (!result.rows.length) return json(404, { error: 'Change request not found.' });
  try {
    const member = await fetchMemberForNotify(db, row.member_id);
    if (member) {
      await notifyBeneficiaryChangeRejected(db, member, payload, body.notes ? mergeBoardNotes(row.notes, body.notes, actor?.actor_label || 'Board') : row.notes || null);
    }
  } catch (notifyErr) {
    console.error('Beneficiary reject notification failed:', notifyErr);
  }
  return getChangeRequest(id);
}

async function findMemberIdForContact(db, { member_id, member_number, email, phone }) {
  if (member_id != null && member_id !== '') {
    const id = Number(member_id);
    if (!Number.isNaN(id) && id > 0) return id;
  }
  if (member_number != null && member_number !== '') {
    const r = await db.query(
      `SELECT id FROM members WHERE member_number = $1 LIMIT 1`,
      [Number(member_number)]
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  const phoneNorm = phone ? String(phone).replace(/\D/g, '').slice(-10) : null;
  if (phoneNorm && phoneNorm.length >= 10) {
    const r = await db.query(
      `SELECT id FROM members
       WHERE RIGHT(regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g'), 10) = $1
          OR RIGHT(regexp_replace(COALESCE(home_phone, ''), '\\D', '', 'g'), 10) = $1
       LIMIT 1`,
      [phoneNorm]
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  const emailNorm = email ? String(email).trim().toLowerCase() : null;
  if (emailNorm) {
    const r = await db.query(
      `SELECT id FROM members WHERE LOWER(TRIM(email)) = $1 LIMIT 1`,
      [emailNorm]
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  return null;
}

function buildContactMessageRow(row) {
  return {
    id: row.id,
    member_id: row.member_id,
    member_number: row.member_number,
    member_name: row.member_full_name || null,
    name: row.name,
    email: row.email,
    phone: row.phone,
    message: row.message,
    source: row.source,
    status: row.status,
    board_reply: row.board_reply,
    replied_at: row.replied_at,
    replied_by_admin_id: row.replied_by_admin_id,
    created_at: row.created_at,
  };
}

const BOARD_REPLY_FOLLOWUP_RE = /\n\n\[\[FOLLOWUP:([^\]]+)\]\]\n/g;

function appendBoardReply(existing, newReply) {
  const trimmed = String(newReply || '').trim();
  const prior = String(existing || '').trim();
  if (!prior) return trimmed;
  const stamp = new Date().toISOString();
  return `${prior}\n\n[[FOLLOWUP:${stamp}]]\n${trimmed}`;
}

function parseBoardReplies(boardReply) {
  const text = String(boardReply || '').trim();
  if (!text) return [];
  const parts = text.split(/\n\n\[\[FOLLOWUP:[^\]]+\]\]\n/);
  const stamps = [...text.matchAll(BOARD_REPLY_FOLLOWUP_RE)].map((m) => m[1]);
  return parts.map((body, i) => ({
    body: body.trim(),
    label: i === 0 ? 'Board' : 'Board follow-up',
    stamp: i === 0 ? null : (stamps[i - 1] || null),
    isFollowup: i > 0,
  })).filter((p) => p.body);
}

async function submitContactForm(body) {
  const name = String(body.name || '').trim();
  const message = String(body.message || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const sourceRaw = String(body.source || 'website').toLowerCase();
  const allowedSources = new Set(['website', 'portal', 'portal-login']);
  const source = allowedSources.has(sourceRaw) ? sourceRaw : 'website';
  const memberNumber = body.member_number != null && body.member_number !== ''
    ? Number(body.member_number)
    : null;
  if (!name || !message) {
    return json(400, { error: 'Name and message are required.' });
  }
  if (source === 'portal-login') {
    if (!email) {
      return json(400, { error: 'Email is required so the board can reply to you.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(400, { error: 'Please enter a valid email address.' });
    }
  }
  const savedName = memberNumber ? `${name} (#${memberNumber})` : name;
  const text = [
    source === 'portal-login'
      ? 'New login help request from the Member Portal (phone not found on sign-in):'
      : source === 'portal'
        ? 'New message from a member via the Member Portal:'
        : 'New message from the Hibret Edir website contact form:',
    '',
    `Name: ${savedName}`,
    memberNumber ? `Member #: ${memberNumber}` : null,
    email ? `Email: ${email}` : null,
    phone ? `Phone: ${phone}` : null,
    '',
    message,
  ].filter(Boolean).join('\n');
  let savedId = null;
  try {
    const db = getDb();
    const memberId = await findMemberIdForContact(db, {
      member_id: body.member_id,
      member_number: memberNumber,
      email,
      phone,
    });
    const insert = await db.query(
      `INSERT INTO contact_messages (member_id, name, email, phone, message, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'new')
       RETURNING id`,
      [memberId, savedName, email || null, phone || null, message, source]
    );
    savedId = insert.rows[0]?.id;
    await notifyBoard({
      db,
      subject: source === 'portal-login'
        ? `Hibret Edir portal login help — ${savedName}`
        : source === 'portal'
          ? `Hibret Edir member portal — ${savedName}`
          : `Hibret Edir contact form — ${savedName}`,
      text,
    });
  } catch (err) {
    console.error('Contact save/notify failed:', err);
    if (err.message?.includes('contact_messages')) {
      try {
        await notifyBoard({
          db: getDb(),
          subject: source === 'portal-login'
            ? `Hibret Edir portal login help — ${savedName}`
            : source === 'portal'
              ? `Hibret Edir member portal — ${savedName}`
              : `Hibret Edir contact form — ${savedName}`,
          text,
        });
      } catch (notifyErr) {
        console.error('Contact notify fallback failed:', notifyErr);
      }
    }
  }
  return json(200, {
    ok: true,
    message: source === 'portal-login'
      ? 'Message sent. The board will reply to your email.'
      : 'Message sent to the board.',
    id: savedId,
  });
}

async function listContactMessages() {
  const db = getDb();
  const result = await db.query(
    `SELECT cm.id, cm.member_id, cm.name, cm.email, cm.phone, cm.message, cm.source, cm.status,
            cm.board_reply, cm.replied_at, cm.replied_by_admin_id, cm.created_at,
            m.member_number, m.full_name AS member_full_name
     FROM contact_messages cm
     LEFT JOIN members m ON m.id = cm.member_id
     ORDER BY cm.created_at DESC NULLS LAST, cm.id DESC
     LIMIT 200`
  );
  return json(200, { messages: result.rows.map(buildContactMessageRow) });
}

async function listContactMessagesForMember(memberId) {
  const db = getDb();
  const member = await db.query(
    `SELECT id, email, mobile, home_phone FROM members WHERE id = $1 LIMIT 1`,
    [memberId]
  );
  const row = member.rows[0];
  if (!row) return [];
  const phoneNorm = row.mobile ? String(row.mobile).replace(/\D/g, '').slice(-10) : null;
  const homeNorm = row.home_phone ? String(row.home_phone).replace(/\D/g, '').slice(-10) : null;
  const emailNorm = row.email ? String(row.email).trim().toLowerCase() : null;
  const result = await db.query(
    `SELECT cm.id, cm.member_id, cm.name, cm.email, cm.phone, cm.message, cm.source, cm.status,
            cm.board_reply, cm.replied_at, cm.replied_by_admin_id, cm.created_at,
            m.member_number, m.full_name AS member_full_name
     FROM contact_messages cm
     LEFT JOIN members m ON m.id = cm.member_id
     WHERE cm.member_id = $1
        OR ($2::text IS NOT NULL AND LOWER(TRIM(cm.email)) = $2)
        OR ($3::text IS NOT NULL AND RIGHT(regexp_replace(COALESCE(cm.phone, ''), '\\D', '', 'g'), 10) = $3)
        OR ($4::text IS NOT NULL AND RIGHT(regexp_replace(COALESCE(cm.phone, ''), '\\D', '', 'g'), 10) = $4)
     ORDER BY cm.created_at DESC NULLS LAST, cm.id DESC
     LIMIT 50`,
    [memberId, emailNorm, phoneNorm, homeNorm]
  );
  return result.rows.map(buildContactMessageRow);
}

async function replyContactMessage(id, body, actor) {
  const reply = String(body.reply || '').trim();
  if (!reply) return json(400, { error: 'Reply message is required.' });
  const db = getDb();
  const existing = await db.query(
    `SELECT cm.*, m.member_number, m.full_name AS member_full_name
     FROM contact_messages cm
     LEFT JOIN members m ON m.id = cm.member_id
     WHERE cm.id = $1 LIMIT 1`,
    [id]
  );
  const msg = existing.rows[0];
  if (!msg) return json(404, { error: 'Message not found.' });

  let memberId = body.member_id != null && body.member_id !== ''
    ? Number(body.member_id)
    : msg.member_id;
  if (!memberId || Number.isNaN(memberId)) {
    memberId = await findMemberIdForContact(db, {
      member_id: null,
      member_number: body.member_number,
      email: msg.email,
      phone: msg.phone,
    });
  }

  const update = await db.query(
    `UPDATE contact_messages
     SET board_reply = $1,
         replied_at = NOW(),
         replied_by_admin_id = $2,
         member_id = COALESCE($3, member_id),
         status = 'replied'
     WHERE id = $4
     RETURNING id`,
    [appendBoardReply(msg.board_reply, reply), actor?.board_member_id || null, memberId || null, id]
  );
  if (!update.rows[0]) return json(500, { error: 'Could not save reply.' });

  const isFollowup = !!String(msg.board_reply || '').trim();
  await logActivity(db, {
    actor_type: 'board',
    board_member_id: actor?.board_member_id || null,
    member_id: memberId || null,
    actor_label: actor?.actor_label || 'Board Admin',
    action: isFollowup ? 'message.followup_reply' : 'message.reply',
    entity_type: 'contact_messages',
    record_id: id,
    summary: isFollowup
      ? `Board sent follow-up to ${msg.name || 'member'}`
      : `Board replied to message from ${msg.name || 'member'}`,
    new_value: { reply: reply.slice(0, 500), contact_message_id: id, followup: isFollowup },
  });

  const isLoginHelp = String(msg.source || '').toLowerCase() === 'portal-login';
  const notifyMemberFlag = isLoginHelp || body.notify_member !== false;

  if (notifyMemberFlag) {
    let memberRow = null;
    if (memberId) {
      const mr = await db.query(
        `SELECT id, member_number, first_name, last_name, full_name, email, mobile
         FROM members WHERE id = $1 LIMIT 1`,
        [memberId]
      );
      memberRow = mr.rows[0];
    }
    const recipientEmail = String(memberRow?.email || msg.email || '').trim();
    if (isLoginHelp && !recipientEmail) {
      return json(400, {
        error: 'This login-help message has no email on file. The member must provide an email when contacting us.',
      });
    }
    const memberName = memberRow?.full_name
      || `${memberRow?.first_name || ''} ${memberRow?.last_name || ''}`.trim()
      || msg.name;
    const subject = isLoginHelp
      ? 'Hibret Edir — reply to your login help request'
      : 'Hibret Edir — reply from the board';
    const showPortalLink = !isLoginHelp && String(msg.source || '').toLowerCase() === 'portal';
    const { text, html } = buildBoardReplyEmail({
      memberName,
      reply,
      isLoginHelp,
      showPortalLink,
      portalUrl: `${getPublicSiteUrl()}/portal/`,
    });
    const sms = showPortalLink
      ? 'Hibret Edir: The board replied to your message. Sign in to the member portal to read it.'
      : `Hibret Edir: ${reply.slice(0, 140)}${reply.length > 140 ? '…' : ''}`;
    if (recipientEmail) {
      await notifyMember({
        db,
        memberId: memberRow?.id || memberId || null,
        email: recipientEmail,
        phone: isLoginHelp ? null : (memberRow?.mobile || msg.phone),
        subject,
        text,
        html,
        smsText: isLoginHelp ? null : sms,
      });
    } else if (memberRow || msg.phone) {
      await notifyMember({
        db,
        memberId: memberRow?.id || memberId || null,
        email: null,
        phone: memberRow?.mobile || msg.phone,
        subject,
        text,
        html,
        smsText: sms,
      });
    }
  }

  const refreshed = await db.query(
    `SELECT cm.id, cm.member_id, cm.name, cm.email, cm.phone, cm.message, cm.source, cm.status,
            cm.board_reply, cm.replied_at, cm.replied_by_admin_id, cm.created_at,
            m.member_number, m.full_name AS member_full_name
     FROM contact_messages cm
     LEFT JOIN members m ON m.id = cm.member_id
     WHERE cm.id = $1 LIMIT 1`,
    [id]
  );
  return json(200, {
    ok: true,
    message: isLoginHelp
      ? (isFollowup ? 'Follow-up emailed to the member.' : 'Reply emailed to the member.')
      : (isFollowup ? 'Follow-up posted and member notified.' : 'Reply posted to the member profile.'),
    contact_message: buildContactMessageRow(refreshed.rows[0]),
  });
}

function matchContactMessagesPath(path) {
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'contact-messages') return null;
  return {
    id: parts[1] ? Number(parts[1]) : null,
    action: parts[2] || null,
  };
}

function matchChangeRequestPath(path) {
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'change-requests') return null;
  const id = parts[1] ? Number(parts[1]) : null;
  const action = parts[2] || null;
  return { id, action };
}

function buildWaitingListRow(row, queuePosition, extras = {}) {
  return {
    id: row.id,
    full_name: waitingListDisplayName(row),
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    referred_by: row.referred_by,
    status: row.status,
    applied_at: row.applied_at,
    invited_at: row.invited_at,
    approved_at: row.approved_at,
    reviewed_at: row.reviewed_at,
    notes: row.notes,
    queue_position: queuePosition,
    has_application: row.has_application === true,
    pending_rank: extras.pending_rank ?? null,
    active_pipeline_rank: extras.active_pipeline_rank ?? null,
    display_rank: extras.display_rank ?? queuePosition,
    eligible_for_invite: extras.eligible_for_invite === true,
  };
}

async function getMembershipSlots(db) {
  const res = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'active')::int AS active_count,
       (SELECT COUNT(*)::int FROM waiting_list wl
        WHERE wl.status = ANY($1::text[])) AS in_pipeline
     FROM members`,
    [WAITING_LIST_PIPELINE_STATUSES]
  );
  const row = res.rows[0] || {};
  const active_count = Number(row.active_count || 0);
  const in_pipeline = Number(row.in_pipeline || 0);
  const member_cap = MEMBER_CAP;
  const production_cap = getProductionMemberCap();
  const slots_available = Math.max(0, production_cap - active_count);
  const invite_slots_remaining = Math.max(0, slots_available - in_pipeline);
  const qa_reserved_slot_open = isQaReservedSlotConfigured()
    && active_count + in_pipeline < member_cap;
  return {
    active_count,
    member_cap,
    production_cap,
    slots_available,
    in_pipeline,
    invite_slots_remaining,
    qa_reserved_slot_open,
  };
}

async function getWaitingListPendingRank(db, waitingListId) {
  const res = await db.query(
    `SELECT id FROM waiting_list
     WHERE status = ANY($1::text[])
     ORDER BY applied_at ASC NULLS LAST, id ASC`,
    [WAITING_LIST_QUEUE_STATUSES]
  );
  const idx = res.rows.findIndex((r) => Number(r.id) === Number(waitingListId));
  return idx >= 0 ? idx + 1 : null;
}

async function listWaitingListAdmin() {
  const db = getDb();
  const [rows, slots] = await Promise.all([
    queryWaitingListOrdered(db),
    getMembershipSlots(db),
  ]);
  const listRows = enrichWaitingListQueue(rows, slots).map(({ row, queue_position, pending_rank, active_pipeline_rank, display_rank, eligible_for_invite }) =>
    buildWaitingListRow(row, queue_position, {
      pending_rank,
      active_pipeline_rank,
      display_rank,
      eligible_for_invite,
    })
  );
  const pendingInvite = listRows.filter((r) => isWaitingListQueueAwaiting(r.status)).length;
  const invited = listRows.filter((r) => r.status === 'Invited to Apply').length;
  const eligible = listRows.filter((r) => r.eligible_for_invite);
  return json(200, {
    waiting_list: listRows,
    slots,
    demo_qa: getDemoQaStatus(),
    next_to_invite: eligible.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      email: r.email,
      pending_rank: r.pending_rank,
    })),
    stats: {
      pending_invite: pendingInvite,
      invited,
      eligible_to_invite: eligible.length,
      total: listRows.length,
    },
  });
}

async function inviteWaitingListEntry(id, body, actor) {
  const db = getDb();
  const existing = await db.query(
    `SELECT wl.*,
      EXISTS (SELECT 1 FROM membership_applications ma WHERE ma.waiting_list_id = wl.id) AS has_application
     FROM waiting_list wl WHERE wl.id = $1 LIMIT 1`,
    [id]
  );
  const row = existing.rows[0];
  if (!row) return json(404, { error: 'Waiting list entry not found.' });
  if (row.status === 'Added as Member') {
    return json(409, { error: 'This person is already a member.' });
  }
  if (row.status === 'Application Submitted' || row.has_application) {
    return json(409, { error: 'Application already submitted — review in Applications tab.' });
  }
  if (row.status === 'Rejected') {
    return json(409, { error: 'Rejected entries must be re-added from the public waiting list form.' });
  }
  if (row.status === 'Invited to Apply') {
    return json(409, { error: 'Already invited to apply.' });
  }
  if (!isWaitingListQueueAwaiting(row.status)) {
    return json(409, { error: 'This entry is not awaiting an invitation.' });
  }

  const [slots, pendingRank] = await Promise.all([
    getMembershipSlots(db),
    getWaitingListPendingRank(db, id),
  ]);
  if (!isDemoQaInviteEligible(row, slots) && (!pendingRank || pendingRank > slots.invite_slots_remaining)) {
    if (slots.qa_reserved_slot_open && !isDemoQaWaitingListRow(row)) {
      return json(409, {
        error: 'No member slots open for the waiting list. The reserved validation slot (QA test only) is still available — use System Health → Reset demo cycle, then invite the QA test email.',
      });
    }
    return json(409, {
      error: `No membership slots available (${slots.active_count}/${slots.member_cap} active${
        slots.in_pipeline ? `, ${slots.in_pipeline} already invited or applying` : ''
      }). Raise MEMBER_CAP or wait for a spot to open.`,
    });
  }

  const note = body.notes ? stampBoardNote(body.notes, actor?.actor_label) : null;
  await db.query(
    `UPDATE waiting_list
     SET status = 'Invited to Apply',
         invited_at = NOW(),
         reviewed_at = NOW(),
         notes = CASE WHEN $2::text IS NOT NULL THEN TRIM(BOTH FROM COALESCE(notes, '') || E'\n' || $2) ELSE notes END
     WHERE id = $1`,
    [id, note]
  );

  const refreshed = await db.query(
    `SELECT wl.*,
      EXISTS (SELECT 1 FROM membership_applications ma WHERE ma.waiting_list_id = wl.id) AS has_application
     FROM waiting_list wl WHERE wl.id = $1 LIMIT 1`,
    [id]
  );
  const updated = refreshed.rows[0];

  try {
    await notifyWaitingListInvited(db, updated);
  } catch (err) {
    console.error('Waiting list invite notification failed:', err);
  }

  await logActivity(db, {
    ...actor,
    action: 'waiting_list.invite',
    entity_type: 'waiting_list',
    record_id: id,
    summary: `Invited ${updated.full_name || 'applicant'} to apply for membership`,
    new_value: { waiting_list_id: id, email: updated.email },
  });

  return json(200, {
    ok: true,
    message: 'Invitation sent. Applicant can verify at /application/.',
    entry: buildWaitingListRow(updated, null),
  });
}

async function rejectWaitingListEntry(id, body, actor) {
  const db = getDb();
  const existing = await db.query(`SELECT * FROM waiting_list WHERE id = $1 LIMIT 1`, [id]);
  const row = existing.rows[0];
  if (!row) return json(404, { error: 'Waiting list entry not found.' });
  if (row.status === 'Added as Member') {
    return json(409, { error: 'Cannot reject — already a member.' });
  }

  const note = stampBoardNote(body.notes || body.reason || 'Removed from waiting list', actor?.actor_label);
  await db.query(
    `UPDATE waiting_list
     SET status = 'Rejected',
         reviewed_at = NOW(),
         notes = TRIM(BOTH FROM COALESCE(notes, '') || E'\n' || $2)
     WHERE id = $1`,
    [id, note]
  );

  await logActivity(db, {
    ...actor,
    action: 'waiting_list.reject',
    entity_type: 'waiting_list',
    record_id: id,
    summary: `Rejected waiting list entry: ${row.full_name || row.email || id}`,
  });

  return json(200, { ok: true, message: 'Removed from waiting list.' });
}

async function handleDemoQaReset(actor) {
  if (!isDemoQaEnabled()) {
    return json(403, { error: 'System validation reset is not enabled (DEMO_QA_ENABLED).' });
  }
  const db = getDb();
  const result = await resetDemoQaCycle(db, { actor });
  return json(200, result);
}

async function handleDemoQaTestNotify(actor) {
  const { sendEmail, getNotifyConfig } = require('./notify');
  const { getDemoQaEmail, maskEmail: maskDemoEmail } = require('./demo-qa-reset');
  const config = getNotifyConfig();
  if (!config.email.configured) {
    return json(400, { error: 'SendGrid is not configured. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL.' });
  }
  const to = getDemoQaEmail() || process.env.TEST_NOTIFY_EMAIL;
  if (!to) {
    return json(400, { error: 'Set DEMO_QA_EMAIL (production QA) or TEST_NOTIFY_EMAIL (local) in environment.' });
  }
  const from = config.email.from;
  const result = await sendEmail({
    to,
    subject: 'Hibret Edir — QA test email',
    text: [
      'This is a test message from the Hibret Edir admin QA tools.',
      '',
      `Sent by: ${actor?.actor_label || 'Board Admin'}`,
      `SendGrid from: ${from}`,
      `Time: ${new Date().toISOString()}`,
      '',
      'If you received this, invitation and application emails should work.',
    ].join('\n'),
  });
  if (!result.ok) {
    return json(502, { error: result.error || result.skipped || 'Could not send test email.' });
  }
  return json(200, {
    ok: true,
    to: maskDemoEmail(to),
    message: `Test email sent to ${maskDemoEmail(to)}.`,
  });
}

function matchWaitingListAdminPath(path) {
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'waiting-list') return null;
  // Public routes: /waiting-list/status (handled in GET handler below)
  if (parts[1] === 'status') return null;
  if (!parts[1]) {
    return { id: null, action: parts[2] || null };
  }
  const id = Number(parts[1]);
  if (!Number.isFinite(id)) return null;
  return { id, action: parts[2] || null };
}

function matchAnnouncementPath(path) {
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'announcement') return null;
  if (parts[1] === 'deceased-search') return { action: 'deceased-search' };
  if (parts[1] === 'fund-status') return { action: 'fund-status' };
  if (parts[1] === 'memorial') return { action: 'memorial' };
  if (parts[1] === 'service-venues') return { action: 'service-venues' };
  if (parts[1] === 'events' && !parts[2]) return { action: 'events-list' };
  if (parts[1] === 'events' && parts[2]) {
    const eventNumber = Number(parts[2]);
    if (Number.isFinite(eventNumber)) return { action: 'event', eventNumber };
  }
  return null;
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
  const annPath = matchAnnouncementPath(path);
  const wlPath = matchWaitingListAdminPath(path);
  const changePath = matchChangeRequestPath(path);
  const contactMsgPath = matchContactMessagesPath(path);

  if (contactMsgPath && event.httpMethod === 'GET') {
    const admin = verifyAdminRequest(event);
    if (!admin) {
      return json(401, { error: 'Admin authorization required. Please sign in.' });
    }
    try {
      const db = getDb();
      const access = await loadBoardMemberAccess(db, admin);
      const memberId = event.queryStringParameters?.member_id;
      if (!memberId) {
        const restricted = assertNotRestrictedMembersOnly(access);
        if (restricted) return json(403, { error: restricted });
      }
      if (memberId) {
        const messages = await listContactMessagesForMember(Number(memberId));
        return json(200, { messages });
      }
      return await listContactMessages();
    } catch (err) {
      console.error('contact messages error:', err);
      if (err.message?.includes('contact_messages') || err.message?.includes('does not exist')) {
        return json(200, { messages: [] });
      }
      return json(500, { error: 'Could not load contact messages.' });
    }
  }

  if (contactMsgPath?.id && contactMsgPath.action === 'reply' && event.httpMethod === 'POST') {
    const admin = verifyAdminRequest(event);
    if (!admin) {
      return json(401, { error: 'Admin authorization required. Please sign in.' });
    }
    try {
      const db = getDb();
      const access = await loadBoardMemberAccess(db, admin);
      const restricted = assertNotRestrictedMembersOnly(access);
      if (restricted) return json(403, { error: restricted });
      const denied = assertPerm(access, 'messages', 'You do not have permission to reply to contact messages.');
      if (denied) return json(403, { error: denied });
      const actor = await resolveAdminActor(admin);
      const body = parseBody(event);
      return await replyContactMessage(contactMsgPath.id, body, actor);
    } catch (err) {
      console.error('contact reply error:', err);
      if (err.message?.includes('contact_messages') || err.message?.includes('does not exist')) {
        return json(503, { error: 'Contact messages table not ready. Run npm run db:migrate.' });
      }
      return json(500, { error: 'Could not post reply.' });
    }
  }

  if (changePath && ['GET', 'POST'].includes(event.httpMethod)) {
    const admin = verifyAdminRequest(event);
    if (!admin) {
      return json(401, { error: 'Admin authorization required. Please sign in.' });
    }
    const actor = await resolveAdminActor(admin);
    const db = getDb();
    const access = await loadBoardMemberAccess(db, admin);
    const restricted = assertNotRestrictedMembersOnly(access);
    if (restricted) return json(403, { error: restricted });
    try {
      if (event.httpMethod === 'GET' && !changePath.id) {
        const rows = await listChangeRequests(db);
        return json(200, { change_requests: rows.map(buildChangeRequestSummary) });
      }
      if (event.httpMethod === 'GET' && changePath.id) {
        return await getChangeRequest(changePath.id);
      }
      const denied = assertPerm(access, 'beneficiary', 'You do not have permission to approve beneficiary changes.');
      if (denied) return json(403, { error: denied });
      const body = parseBody(event);
      if (event.httpMethod === 'POST' && changePath.id && changePath.action === 'approve') {
        return await approveChangeRequest(changePath.id, body, actor);
      }
      if (event.httpMethod === 'POST' && changePath.id && changePath.action === 'reject') {
        return await rejectChangeRequest(changePath.id, body, actor);
      }
      return json(404, { error: 'Not found' });
    } catch (err) {
      console.error('change request admin error:', err);
      if (err.message?.includes('DATABASE_URL')) {
        return json(503, { error: 'Database is not configured.' });
      }
      return json(500, { error: 'Could not process change request.' });
    }
  }

  if ((path === '/qa/dashboard' || path === '/qa/dashboard/') && event.httpMethod === 'GET') {
    const admin = verifyAdminRequest(event);
    if (!admin) {
      return json(401, { error: 'Admin authorization required. Please sign in.' });
    }
    try {
      const db = getDb();
      const access = await loadBoardMemberAccess(db, admin);
      const restricted = assertNotRestrictedMembersOnly(access);
      if (restricted) return json(403, { error: restricted });
      const dashboard = await buildMonitorHealthDashboard(db);
      return json(200, dashboard);
    } catch (err) {
      console.error('qa dashboard error:', err);
      if (err.message?.includes('DATABASE_URL')) {
        return json(503, { error: 'Database is not configured.' });
      }
      return json(500, { error: 'Could not load monitor health dashboard.' });
    }
  }

  if ((path === '/demo-qa/reset' || path === '/demo-qa/reset/') && event.httpMethod === 'POST') {
    const admin = verifyAdminRequest(event);
    if (!admin) {
      return json(401, { error: 'Admin authorization required. Please sign in.' });
    }
    try {
      const db = getDb();
      const access = await loadBoardMemberAccess(db, admin);
      const denied = assertCanManageBoard(access);
      if (denied) return json(403, { error: denied });
      const actor = await resolveAdminActor(admin);
      return await handleDemoQaReset(actor);
    } catch (err) {
      console.error('demo qa reset error:', err);
      if (err.message?.includes('DATABASE_URL')) {
        return json(503, { error: 'Database is not configured.' });
      }
      return json(400, { error: err.message || 'Could not reset demo cycle.' });
    }
  }

  if ((path === '/demo-qa/test-notify' || path === '/demo-qa/test-notify/') && event.httpMethod === 'POST') {
    const admin = verifyAdminRequest(event);
    if (!admin) {
      return json(401, { error: 'Admin authorization required. Please sign in.' });
    }
    try {
      const db = getDb();
      const access = await loadBoardMemberAccess(db, admin);
      const denied = assertCanManageBoard(access);
      if (denied) return json(403, { error: denied });
      const actor = await resolveAdminActor(admin);
      return await handleDemoQaTestNotify(actor);
    } catch (err) {
      console.error('demo qa test notify error:', err);
      return json(500, { error: err.message || 'Could not send test notification.' });
    }
  }

  const isWaitingListAdminRoute = wlPath && (
    (event.httpMethod === 'GET' && !wlPath.id)
    || (event.httpMethod === 'POST' && wlPath.id && (wlPath.action === 'invite' || wlPath.action === 'reject'))
  );

  if (isWaitingListAdminRoute) {
    const admin = verifyAdminRequest(event);
    if (!admin) {
      return json(401, { error: 'Admin authorization required. Please sign in.' });
    }
    const actor = await resolveAdminActor(admin);
    const db = getDb();
    const access = await loadBoardMemberAccess(db, admin);
    const restricted = assertNotRestrictedMembersOnly(access);
    if (restricted) return json(403, { error: restricted });
    try {
      if (event.httpMethod === 'GET' && !wlPath.id) {
        return await listWaitingListAdmin();
      }
      const body = parseBody(event);
      if (event.httpMethod === 'POST' && wlPath.id && wlPath.action === 'invite') {
        const denied = assertPerm(access, 'waiting_list_invite', 'You do not have permission to invite waiting list members.');
        if (denied) return json(403, { error: denied });
        return await inviteWaitingListEntry(wlPath.id, body, actor);
      }
      if (event.httpMethod === 'POST' && wlPath.id && wlPath.action === 'reject') {
        const denied = assertPerm(access, 'waiting_list_remove', 'You do not have permission to remove waiting list members.');
        if (denied) return json(403, { error: denied });
        return await rejectWaitingListEntry(wlPath.id, body, actor);
      }
      return json(404, { error: 'Not found' });
    } catch (err) {
      console.error('waiting list admin error:', err);
      if (err.message?.includes('DATABASE_URL')) {
        return json(503, { error: 'Database is not configured.' });
      }
      return json(500, { error: 'Could not process waiting list action.' });
    }
  }

  if (annPath && ['GET', 'PUT'].includes(event.httpMethod)) {
    const admin = verifyAdminRequest(event);
    if (!admin) {
      return json(401, { error: 'Admin authorization required. Please sign in.' });
    }
    const db = getDb();
    const access = await loadBoardMemberAccess(db, admin);
    const restricted = assertNotRestrictedMembersOnly(access);
    if (restricted) return json(403, { error: restricted });
    try {
      if (annPath.action === 'deceased-search' && event.httpMethod === 'GET') {
        const q = event.queryStringParameters?.q || '';
        const matches = await searchDeceasedInCrm(db, q, 25);
        return json(200, { matches });
      }
      if (annPath.action === 'fund-status' && event.httpMethod === 'GET') {
        const fund = await getFundCollectionHint();
        return json(200, fund);
      }
      if (annPath.action === 'service-venues' && event.httpMethod === 'GET') {
        const venues = await listServiceVenues(db);
        return json(200, { venues });
      }
      if (annPath.action === 'events-list' && event.httpMethod === 'GET') {
        const data = await listEventsForAnnouncement(db);
        return json(200, data);
      }
      if (annPath.action === 'memorial' && event.httpMethod === 'GET') {
        const payload = await getMemorialAnnouncementAdmin(db);
        if (!payload) return json(200, { source: null, announcement: null });
        return json(200, payload);
      }
      if (annPath.action === 'memorial' && event.httpMethod === 'PUT') {
        const denied = assertPerm(access, 'announce', 'You do not have permission to save funeral announcements.');
        if (denied) return json(403, { error: denied });
        const actor = await resolveAdminActor(admin);
        const body = parseBody(event);
        const result = await saveMemorialAnnouncementOnly(db, body, actor);
        await logActivity(db, {
          ...actor,
          member_id: result.announcement.member_id || null,
          action: 'announcement.save',
          entity_type: 'memorial_announcements',
          table_name: 'memorial_announcements',
          record_id: null,
          new_value: {
            deceased_name: result.announcement.deceased_name,
            collect_dues: false,
            source: 'memorial',
          },
          summary: `Saved memorial announcement (no collection) — ${result.announcement.deceased_name}`,
        });
        return json(200, result);
      }
      if (annPath.action === 'event' && event.httpMethod === 'GET') {
        const payload = await getEventAnnouncementAdmin(db, annPath.eventNumber);
        if (!payload) return json(404, { error: 'Event not found.' });
        return json(200, payload);
      }
      if (annPath.action === 'event' && event.httpMethod === 'PUT') {
        const denied = assertPerm(access, 'announce', 'You do not have permission to save funeral announcements.');
        if (denied) return json(403, { error: denied });
        const actor = await resolveAdminActor(admin);
        const body = parseBody(event);
        const result = await saveEventAnnouncement(db, annPath.eventNumber, body, actor);
        await logActivity(db, {
          ...actor,
          member_id: result.announcement.member_id || null,
          action: 'announcement.save',
          entity_type: 'events',
          table_name: 'events',
          record_id: result.event.id,
          new_value: {
            event_number: annPath.eventNumber,
            deceased_name: result.announcement.deceased_name,
            collect_dues: result.announcement.collect_dues,
          },
          summary: `Saved funeral announcement for Event #${annPath.eventNumber} — ${result.announcement.deceased_name}`,
        });
        return json(200, { ok: true, ...result });
      }
      return json(404, { error: 'Not found' });
    } catch (err) {
      console.error('announcement admin error:', err);
      if (err.status === 404) return json(404, { error: err.message });
      if (err.status === 400) return json(400, { error: err.message });
      if (err.message?.includes('DATABASE_URL')) {
        return json(503, { error: 'Database is not configured.' });
      }
      return json(500, { error: err.message || 'Could not process announcement.' });
    }
  }

  if (appPath && ['GET', 'PATCH', 'POST'].includes(event.httpMethod)) {
    const admin = verifyAdminRequest(event);
    if (!admin) {
      return json(401, { error: 'Admin authorization required. Please sign in.' });
    }
    const actor = await resolveAdminActor(admin);
    const db = getDb();
    const access = await loadBoardMemberAccess(db, admin);
    const restricted = assertNotRestrictedMembersOnly(access);
    if (restricted) return json(403, { error: restricted });
    try {
      if (event.httpMethod === 'GET' && !appPath.id) {
        return await listApplications(event.queryStringParameters || {});
      }
      if (event.httpMethod === 'GET' && appPath.id && !appPath.action) {
        const crCheck = await db.query(`SELECT id FROM member_change_requests WHERE id = $1 LIMIT 1`, [appPath.id]);
        if (crCheck.rows.length) return await getChangeRequest(appPath.id);
        return await getApplication(appPath.id);
      }
      const body = parseBody(event);
      if (event.httpMethod === 'PATCH' && appPath.id && !appPath.action) {
        return await updateApplicationReview(appPath.id, body, actor, access);
      }
      const denied = assertPerm(access, 'applications_approve', 'You do not have permission to approve or reject applications.');
      if (denied) return json(403, { error: denied });
      if (event.httpMethod === 'POST' && appPath.id && appPath.action === 'approve-for-payment') {
        return await approveForPayment(appPath.id, body, actor);
      }
      if (event.httpMethod === 'POST' && appPath.id && appPath.action === 'complete') {
        return await completeRegistrationApplication(appPath.id, body, actor);
      }
      if (event.httpMethod === 'POST' && appPath.id && appPath.action === 'approve') {
        return await approveForPayment(appPath.id, body, actor);
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
    if (path === '/site-stats' || path === '/site-stats/') {
      try {
        const db = getDb();
        const [memberRes, eventRes] = await Promise.all([
          db.query(`
            SELECT
              COUNT(*)::int AS total_count,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'active')::int AS active_count
            FROM members
          `),
          db.query(`
            SELECT amount_per_member, payout_amount
            FROM events
            WHERE deceased_name IS NOT NULL AND TRIM(deceased_name) <> ''
            ORDER BY event_number DESC NULLS LAST
            LIMIT 1
          `),
        ]);
        const row = memberRes.rows[0] || {};
        const ev = eventRes.rows[0] || {};
        return json(200, {
          active_count: Number(row.active_count || 0),
          total_count: Number(row.total_count || 0),
          member_cap: Number(process.env.MEMBER_CAP || 200),
          amount_per_member: Number(ev.amount_per_member || process.env.AMOUNT_PER_MEMBER || 110),
          payout_amount: Number(ev.payout_amount || process.env.PAYOUT_AMOUNT || 15000),
          updated_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error('site-stats error:', err);
        if (err.message?.includes('DATABASE_URL')) {
          return json(503, { error: 'Database is not configured.' });
        }
        return json(503, { error: 'Could not load site stats.' });
      }
    }
    if (path === '/current-announcement' || path === '/current-announcement/') {
      try {
        const announcement = await getCurrentAnnouncementFromDb();
        if (!announcement) {
          return json(404, { error: 'No current announcement.' });
        }
        return json(200, { announcement });
      } catch (err) {
        console.error('current-announcement error:', err);
        if (err.message?.includes('DATABASE_URL')) {
          return json(503, { error: 'Database is not configured.' });
        }
        return json(503, { error: 'Could not load announcement.' });
      }
    }
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
    if (path === '/contact' || path === '/contact/') {
      return await submitContactForm(body);
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

exports.getApplicationForMember = getApplicationForMember;
exports.buildApplicationSummary = buildApplicationSummary;
