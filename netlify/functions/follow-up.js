const { getDb } = require('./db');
const { verifyAdminRequest } = require('./admin-auth');
const { logActivity } = require('./audit');
const {
  loadBoardMemberAccess,
  assertPerm,
  assertNotRestrictedMembersOnly,
  getSuperAdminEmails,
  deriveBoardAccess,
  hasPerm,
} = require('./board-permissions');
const { outstandingInvoiceSql } = require('./payment-methods');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const INVOICE_DUE_DAYS = 3;
const FOLLOW_UP_MIN_AMOUNT_DUE = 10;
const OUTSTANDING_AMOUNT_SQL = `(
  (
    LOWER(TRIM(COALESCE(invoices.status, ''))) = 'unpaid'
    AND COALESCE(NULLIF(invoices.amount_due, 0), invoices.amount, 0) >= $1
  )
  OR (
    LOWER(TRIM(COALESCE(invoices.status, ''))) = 'partially paid'
    AND COALESCE(invoices.amount_due, 0) >= $1
  )
)`;

function jsonResponse(statusCode, payload) {
  return { statusCode, headers, body: JSON.stringify(payload) };
}

function getPath(event) {
  const basePath = '/.netlify/functions/follow-up';
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

function normalizeInvoiceName(value) {
  return String(value || '').trim().toLowerCase();
}

function memberPaypalName(member) {
  const first = member.first_name || '';
  const last = member.last_name || '';
  return normalizeInvoiceName(member.paypal_name || `${first} ${last}`.trim());
}

function memberHouseholdName(member) {
  return normalizeInvoiceName(member.full_name);
}

function memberMatchNames(member) {
  const names = new Set();
  const paypal = memberPaypalName(member);
  const household = memberHouseholdName(member);
  if (paypal) names.add(paypal);
  if (household) names.add(household);
  return [...names];
}

async function fetchActiveMemberMatchIndex(db) {
  const result = await db.query(
    `SELECT id, first_name, last_name, full_name, paypal_name, email
     FROM members
     WHERE LOWER(TRIM(COALESCE(status, ''))) = 'active'`
  );
  return result.rows;
}

/** Same ownership rules as admin CRM (paypal / household name, then member_id). */
function resolveInvoiceOwner(invoiceRow, activeMembers) {
  const invName = normalizeInvoiceName(invoiceRow.recipient_name);
  if (invName) {
    for (const member of activeMembers) {
      const paypal = memberPaypalName(member);
      const household = memberHouseholdName(member);
      if ((paypal && invName === paypal) || (household && invName === household)) {
        return member;
      }
    }
  }
  if (invoiceRow.member_id != null) {
    const id = Number(invoiceRow.member_id);
    return activeMembers.find((member) => Number(member.id) === id) || null;
  }
  return null;
}

function buildMemberSummary(row) {
  const first = row.first_name || '';
  const last = row.last_name || '';
  return {
    id: row.id,
    member_number: row.member_number,
    first,
    last,
    full_name: row.full_name || `${first} ${last}`.trim(),
    spouse_name: row.spouse_name || '',
    mobile: row.mobile || '',
    home: row.home_phone || '',
    email: row.email || '',
    status: row.status || '',
  };
}

function buildBoardOption(row) {
  const label = String(row.display_name || '').trim()
    || String(row.email || '').trim()
    || `Board #${row.id}`;
  return {
    id: row.id,
    display_name: label,
    email: row.email || '',
    is_active: row.is_active !== false,
  };
}

async function fetchActiveBoardOptions(db) {
  const result = await db.query(
    `SELECT id, display_name, email, is_active
     FROM board_members
     WHERE is_active = TRUE
       AND LOWER(COALESCE(role, '')) <> 'advisor'
       AND (
         is_super_admin = TRUE
         OR COALESCE(board_perms->>'follow_up', '') = 'true'
       )
     ORDER BY COALESCE(NULLIF(TRIM(display_name), ''), email) ASC`
  );
  return result.rows.map(buildBoardOption);
}

async function fetchAssignmentsMap(db) {
  const result = await db.query(
    `SELECT mba.member_id, mba.board_member_id, mba.assigned_at,
            bm.display_name AS board_display_name, bm.email AS board_email
     FROM member_board_assignments mba
     JOIN board_members bm ON bm.id = mba.board_member_id`
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(Number(row.member_id), {
      board_member_id: Number(row.board_member_id),
      board_display_name: String(row.board_display_name || '').trim() || row.board_email || '',
      assigned_at: row.assigned_at,
    });
  }
  return map;
}

async function fetchActiveMembers(db) {
  const result = await db.query(
    `SELECT id, member_number, first_name, last_name, full_name, spouse_name,
            mobile, home_phone, email, status, paypal_name
     FROM members
     WHERE LOWER(TRIM(COALESCE(status, ''))) = 'active'
     ORDER BY member_number ASC NULLS LAST, last_name ASC, first_name ASC`
  );
  return result.rows;
}

function mapOutstandingInvoiceRow(row) {
  const dateStr = row.date ? row.date.toISOString().slice(0, 19).replace('T', ' ') : null;
  const amountDue = Number(row.amount_due || 0) > 0
    ? Number(row.amount_due)
    : Number(row.amount || 0);
  return {
    id: row.id,
    invoice_num: row.invoice_number,
    status: row.status,
    amount_due: amountDue,
    date: dateStr,
    event_number: row.event_number != null ? Number(row.event_number) : null,
    deceased_name: row.deceased_name || '',
    days_since_sent: invoiceDaysSinceSent(dateStr, row.status),
    days_past_due: computeDaysPastDue(dateStr, row.status),
  };
}

function pushInvoiceForMember(byMember, memberId, invoice) {
  const id = Number(memberId);
  if (!byMember.has(id)) byMember.set(id, []);
  const list = byMember.get(id);
  if (!list.some((item) => item.id === invoice.id)) list.push(invoice);
}

async function fetchOutstandingInvoicesForMembers(db, memberRows) {
  if (!memberRows?.length) return new Map();

  const memberIds = memberRows.map((r) => Number(r.id));
  const memberIdSet = new Set(memberIds);
  const exactNames = [];
  for (const row of memberRows) {
    for (const name of memberMatchNames(row)) {
      if (name && !exactNames.includes(name)) exactNames.push(name);
    }
  }

  const [activeMembers, invoiceResult] = await Promise.all([
    fetchActiveMemberMatchIndex(db),
    (async () => {
      const values = [FOLLOW_UP_MIN_AMOUNT_DUE, memberIds];
      let nameClause = '';
      if (exactNames.length) {
        values.push(exactNames);
        nameClause = `OR (
          NULLIF(TRIM(invoices.recipient_name), '') IS NOT NULL
          AND LOWER(TRIM(invoices.recipient_name)) = ANY($3::text[])
        )`;
      }
      return db.query(
        `SELECT
           invoices.id,
           invoices.invoice_number,
           invoices.status,
           invoices.amount,
           invoices.amount_due,
           invoices.sent_date AS date,
           invoices.member_id,
           invoices.recipient_name,
           events.event_number,
           COALESCE(events.deceased_name, '') AS deceased_name
         FROM invoices
         LEFT JOIN events ON invoices.event_id = events.id
         WHERE invoices.invoice_number IS NOT NULL
           AND ${outstandingInvoiceSql('invoices.status')}
           AND ${OUTSTANDING_AMOUNT_SQL}
           AND (
             invoices.member_id = ANY($2::int[])
             ${nameClause}
           )
         ORDER BY invoices.sent_date DESC NULLS LAST, invoices.invoice_number DESC`,
        values
      );
    })(),
  ]);

  const byMember = new Map();
  for (const row of invoiceResult.rows) {
    const owner = resolveInvoiceOwner(row, activeMembers);
    if (!owner || !memberIdSet.has(Number(owner.id))) continue;
    pushInvoiceForMember(byMember, owner.id, mapOutstandingInvoiceRow(row));
  }
  return byMember;
}

function attachFollowUpRows(memberRows, assignmentsMap, outstandingMap) {
  return memberRows.map((row) => {
    const member = buildMemberSummary(row);
    const assignment = assignmentsMap.get(Number(row.id)) || null;
    const unpaid_invoices = outstandingMap.get(Number(row.id)) || [];
    return {
      member,
      assignment,
      unpaid_invoices,
      needs_follow_up: unpaid_invoices.length > 0,
    };
  });
}

async function fetchMembersAssignedToBoard(db, boardMemberId) {
  const result = await db.query(
    `SELECT m.id, m.member_number, m.first_name, m.last_name, m.full_name, m.spouse_name,
            m.mobile, m.home_phone, m.email, m.status, m.paypal_name
     FROM members m
     INNER JOIN member_board_assignments mba ON mba.member_id = m.id
     WHERE mba.board_member_id = $1
       AND LOWER(TRIM(COALESCE(m.status, ''))) = 'active'
     ORDER BY m.member_number ASC NULLS LAST, m.last_name ASC, m.first_name ASC`,
    [boardMemberId]
  );
  return result.rows;
}

async function getRosterPayload(db) {
  const [members, assignmentsMap, boardOptions] = await Promise.all([
    fetchActiveMembers(db),
    fetchAssignmentsMap(db),
    fetchActiveBoardOptions(db),
  ]);
  const outstandingMap = await fetchOutstandingInvoicesForMembers(db, members);
  const rows = attachFollowUpRows(members, assignmentsMap, outstandingMap);
  const assigned = rows.filter((r) => r.assignment).length;
  return {
    rows,
    board_options: boardOptions,
    stats: {
      active_members: rows.length,
      assigned,
      unassigned: rows.length - assigned,
    },
  };
}

async function getMyListPayload(db, boardMemberId) {
  const [myMembers, assignmentsMap] = await Promise.all([
    fetchMembersAssignedToBoard(db, boardMemberId),
    fetchAssignmentsMap(db),
  ]);
  const outstandingMap = await fetchOutstandingInvoicesForMembers(db, myMembers);
  const rows = attachFollowUpRows(myMembers, assignmentsMap, outstandingMap)
    .sort((a, b) => {
      if (a.needs_follow_up !== b.needs_follow_up) return a.needs_follow_up ? -1 : 1;
      const an = `${a.member.last || ''} ${a.member.first || ''}`.trim();
      const bn = `${b.member.last || ''} ${b.member.first || ''}`.trim();
      return an.localeCompare(bn);
    });
  return {
    rows,
    board_member_id: boardMemberId,
    stats: {
      portfolio_size: myMembers.length,
      needs_follow_up: rows.filter((r) => r.needs_follow_up).length,
      total_unpaid_invoices: rows.reduce((sum, r) => sum + r.unpaid_invoices.length, 0),
    },
  };
}

async function lookupBoardIdByEmail(db, email) {
  const normalized = String(email || '').trim();
  if (!normalized || normalized === 'dev') return null;
  const result = await db.query(
    `SELECT bm.id FROM board_members bm
     WHERE bm.is_active = TRUE
       AND (
         LOWER(bm.email) = LOWER($1)
         OR EXISTS (
           SELECT 1 FROM board_member_emails bme
           WHERE bme.board_member_id = bm.id AND LOWER(bme.email) = LOWER($1)
         )
       )
     LIMIT 1`,
    [normalized]
  );
  return result.rows[0]?.id ? Number(result.rows[0].id) : null;
}

async function lookupBoardIdBySuperAdminEmails(db) {
  const emails = getSuperAdminEmails();
  if (!emails.length) return null;
  const result = await db.query(
    `SELECT bm.id FROM board_members bm
     WHERE bm.is_active = TRUE
       AND (
         LOWER(bm.email) = ANY($1::text[])
         OR EXISTS (
           SELECT 1 FROM board_member_emails bme
           WHERE bme.board_member_id = bm.id AND LOWER(bme.email) = ANY($1::text[])
         )
       )
     ORDER BY bm.id ASC
     LIMIT 1`,
    [emails]
  );
  return result.rows[0]?.id ? Number(result.rows[0].id) : null;
}

async function resolveActorBoardId(db, adminPayload) {
  if (!adminPayload) return null;

  if (adminPayload.adminId) {
    const id = Number(adminPayload.adminId);
    const check = await db.query(
      `SELECT id FROM board_members WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [id]
    );
    if (check.rows[0]) return id;
  }

  const fromEmail = await lookupBoardIdByEmail(db, adminPayload.email);
  if (fromEmail) return fromEmail;

  if (adminPayload.bypass) {
    const fromSuper = await lookupBoardIdBySuperAdminEmails(db);
    if (fromSuper) return fromSuper;
  }

  return null;
}

async function assignMember(db, {
  memberId,
  boardMemberId,
  actorBoardId,
  isSuperAdmin,
  authBypass,
}) {
  const memberRes = await db.query(
    `SELECT id, status FROM members WHERE id = $1 LIMIT 1`,
    [memberId]
  );
  if (!memberRes.rows[0]) {
    return { error: 'Member not found', status: 404 };
  }
  if (String(memberRes.rows[0].status || '').toLowerCase() !== 'active') {
    return { error: 'Only active members can be assigned for follow-up.', status: 400 };
  }

  const boardRes = await db.query(
    `SELECT id, is_active, role, board_perms, is_super_admin
     FROM board_members WHERE id = $1 LIMIT 1`,
    [boardMemberId]
  );
  const boardRow = boardRes.rows[0];
  if (!boardRow || boardRow.is_active === false) {
    return { error: 'Board member not found or inactive.', status: 400 };
  }
  if (String(boardRow.role || '').toLowerCase() === 'advisor') {
    return { error: 'Advisors cannot receive follow-up assignments.', status: 400 };
  }
  const boardAccess = deriveBoardAccess(boardRow);
  if (!hasPerm(boardAccess, 'follow_up')) {
    return { error: 'This login does not have payment follow-up access.', status: 400 };
  }

  const existingRes = await db.query(
    `SELECT member_id, board_member_id FROM member_board_assignments WHERE member_id = $1 LIMIT 1`,
    [memberId]
  );
  const existing = existingRes.rows[0];

  if (existing && Number(existing.board_member_id) === Number(boardMemberId)) {
    return { ok: true, member_id: memberId, board_member_id: boardMemberId, unchanged: true };
  }

  if (existing && Number(existing.board_member_id) !== Number(boardMemberId)) {
    if (!isSuperAdmin) {
      return {
        error: 'Only a super admin can reassign a member to a different board contact.',
        status: 403,
      };
    }
  } else if (!isSuperAdmin && !authBypass && Number(boardMemberId) !== Number(actorBoardId)) {
    return { error: 'You can only assign members to yourself.', status: 403 };
  }

  const assignedBy = actorBoardId || (authBypass ? boardMemberId : null);

  await db.query(
    `INSERT INTO member_board_assignments (member_id, board_member_id, assigned_by_board_member_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (member_id) DO UPDATE SET
       board_member_id = EXCLUDED.board_member_id,
       assigned_by_board_member_id = EXCLUDED.assigned_by_board_member_id,
       assigned_at = NOW()`,
    [memberId, boardMemberId, assignedBy]
  );

  return { ok: true, member_id: memberId, board_member_id: boardMemberId };
}

async function clearAssignment(db, { memberId, isSuperAdmin }) {
  if (!isSuperAdmin) {
    return { error: 'Only a super admin can clear an assignment.', status: 403 };
  }
  await db.query(`DELETE FROM member_board_assignments WHERE member_id = $1`, [memberId]);
  return { ok: true, member_id: memberId, cleared: true };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const adminPayload = verifyAdminRequest(event);
  if (!adminPayload) {
    return jsonResponse(401, { error: 'Board sign-in required.' });
  }

  let db;
  try {
    db = getDb();
  } catch (error) {
    return jsonResponse(503, { error: error.message || 'Database unavailable.' });
  }

  const access = await loadBoardMemberAccess(db, adminPayload);
  const restricted = assertNotRestrictedMembersOnly(access);
  if (restricted) {
    return jsonResponse(403, { error: restricted });
  }
  const denied = assertPerm(access, 'follow_up', 'You do not have permission for payment follow-up.');
  if (denied) {
    return jsonResponse(403, { error: denied });
  }

  const path = getPath(event);
  const isSuperAdmin = !!access?.is_super_admin;
  const authBypass = !!adminPayload?.bypass;
  const actorBoardId = await resolveActorBoardId(db, adminPayload);

  try {
    if (event.httpMethod === 'GET' && path === '/board-options') {
      const boardOptions = await fetchActiveBoardOptions(db);
      return jsonResponse(200, { board_options: boardOptions });
    }

    if (event.httpMethod === 'GET' && path === '/roster') {
      const payload = await getRosterPayload(db);
      return jsonResponse(200, payload);
    }

    if (event.httpMethod === 'GET' && path === '/my-list') {
      if (!actorBoardId) {
        return jsonResponse(200, {
          rows: [],
          board_member_id: null,
          stats: { portfolio_size: 0, needs_follow_up: 0, total_unpaid_invoices: 0 },
          notice: 'Could not match your board login to a board account. Try Assignments again after a page refresh.',
        });
      }
      const payload = await getMyListPayload(db, actorBoardId);
      return jsonResponse(200, payload);
    }

    if (event.httpMethod === 'POST' && path.startsWith('/claim/')) {
      const memberId = Number(path.split('/')[2]);
      if (!memberId) {
        return jsonResponse(400, { error: 'Invalid member id.' });
      }
      if (!actorBoardId) {
        return jsonResponse(400, { error: 'Could not identify your board account. Refresh the page and try again.' });
      }
      const result = await assignMember(db, {
        memberId,
        boardMemberId: actorBoardId,
        actorBoardId,
        isSuperAdmin,
        authBypass,
      });
      if (result.error) {
        return jsonResponse(result.status || 400, { error: result.error });
      }
      if (!result.unchanged) {
        await logActivity(db, {
          action: 'follow_up_assign',
          entity_type: 'members',
          entity_id: memberId,
          board_member_id: actorBoardId,
          member_id: memberId,
          new_value: { board_member_id: actorBoardId, via: 'claim' },
        });
      }
      return jsonResponse(200, result);
    }

    if (event.httpMethod === 'PUT' && path.startsWith('/assignments/')) {
      const memberId = Number(path.split('/')[2]);
      if (!memberId) {
        return jsonResponse(400, { error: 'Invalid member id.' });
      }
      let body = {};
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch {
        return jsonResponse(400, { error: 'Invalid JSON body.' });
      }
      let boardMemberId = Number(body.board_member_id);
      if (!isSuperAdmin) {
        if (!actorBoardId) {
          return jsonResponse(400, { error: 'Could not identify your board account. Refresh the page and try again.' });
        }
        boardMemberId = actorBoardId;
      } else if (!boardMemberId) {
        return jsonResponse(400, { error: 'board_member_id is required.' });
      }

      const result = await assignMember(db, {
        memberId,
        boardMemberId,
        actorBoardId,
        isSuperAdmin,
        authBypass,
      });
      if (result.error) {
        return jsonResponse(result.status || 400, { error: result.error });
      }

      if (!result.unchanged && actorBoardId) {
        await logActivity(db, {
          action: 'follow_up_assign',
          entity_type: 'members',
          entity_id: memberId,
          board_member_id: actorBoardId,
          member_id: memberId,
          new_value: { board_member_id: boardMemberId },
        });
      }

      return jsonResponse(200, result);
    }

    if (event.httpMethod === 'DELETE' && path.startsWith('/assignments/')) {
      const memberId = Number(path.split('/')[2]);
      if (!memberId) {
        return jsonResponse(400, { error: 'Invalid member id.' });
      }
      const result = await clearAssignment(db, { memberId, isSuperAdmin });
      if (result.error) {
        return jsonResponse(result.status || 400, { error: result.error });
      }
      if (actorBoardId) {
        await logActivity(db, {
          action: 'follow_up_unassign',
          entity_type: 'members',
          entity_id: memberId,
          board_member_id: actorBoardId,
          member_id: memberId,
        });
      }
      return jsonResponse(200, result);
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('follow-up error:', error);
    return jsonResponse(500, { error: error.message || 'Follow-up request failed.' });
  }
};
