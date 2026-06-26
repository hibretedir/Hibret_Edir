// netlify/functions/auth.js
// Member Authentication — Hibret Edir
// Handles PIN login for member portal
// Environment variables needed:
//   DATABASE_URL
//   JWT_SECRET
//   JWT_EXPIRES_IN

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('./db');
const { findSnapshotMember, saveSnapshotPin, clearSnapshotPin, loadSnapshotMembers } = require('./member-snapshot');
const { logActivity } = require('./audit');
const { adminAuthRequired, verifyAdminRequest } = require('./admin-auth');
const {
  loadBoardMemberAccess,
  assertCanManageBoard,
  assertCanWriteAll,
  assertCanApproveOperations,
  assertPerm,
  buildPermissionsPayload,
  syncSuperAdminFlags,
  normalizePermissionBody,
  BOARD_MEMBER_PERM_COLUMNS,
  BOARD_PERMISSION_DEFS,
  defaultInvitePerms,
} = require('./board-permissions');
const { notifyBoard } = require('./notify');

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
  const basePath = '/.netlify/functions/auth';
  if (event.path && event.path.startsWith(basePath)) {
    return event.path.slice(basePath.length) || '/';
  }
  return event.path || '/';
}

function parseBearerToken(authorizationHeader) {
  if (!authorizationHeader) return null;
  const parts = authorizationHeader.split(' ');
  if (parts[0] !== 'Bearer' || !parts[1]) return null;
  return parts[1];
}

function jwtSecret() {
  return process.env.JWT_SECRET || 'hibret-local-dev-secret';
}

const QA_TEST_EMAIL = 'hibretedirtest@gmail.com';

function rankMemberForPortalAuth(member) {
  let score = 0;
  if (member.member_number != null) score += 1000;
  const status = String(member.status || '').toLowerCase();
  if (status === 'active') score += 100;
  const email = String(member.email || '').trim().toLowerCase();
  if (email === QA_TEST_EMAIL) score -= 500;
  if (String(member.full_name || '').toLowerCase().includes('qa test')) score -= 500;
  // Stable tie-break: prefer the oldest real row when scores match.
  score -= Number(member.id || 0) / 1e6;
  return score;
}

function pickBestMemberMatch(rows) {
  if (!rows?.length) return null;
  if (rows.length === 1) return rows[0];
  return rows.slice().sort((a, b) => rankMemberForPortalAuth(b) - rankMemberForPortalAuth(a))[0];
}

async function findMemberInDb({ phone, email }) {
  const db = getDb();
  const result = await db.query(
    `SELECT id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone, address, status, pin_hash, joined_date
     FROM members
     WHERE ($1::text IS NOT NULL AND (
       RIGHT(regexp_replace(COALESCE(mobile, ''), '\\D', '', 'g'), 10) = RIGHT(regexp_replace($1, '\\D', '', 'g'), 10)
       OR RIGHT(regexp_replace(COALESCE(home_phone, ''), '\\D', '', 'g'), 10) = RIGHT(regexp_replace($1, '\\D', '', 'g'), 10)
     ))
     OR ($2::text IS NOT NULL AND LOWER(email) = LOWER($2))`,
    [phone || null, email || null]
  );
  return pickBestMemberMatch(result.rows);
}

async function findMember({ phone, email }) {
  if (process.env.DATABASE_URL) {
    try {
      const row = await findMemberInDb({ phone, email });
      if (row) return row;
    } catch (error) {
      console.warn('DB member lookup failed, trying snapshot:', error.message);
    }
  }
  return findSnapshotMember({ phone, email });
}

function findMemberById(id) {
  const num = Number(id);
  if (process.env.DATABASE_URL) {
    try {
      const db = getDb();
      return db.query(
        `SELECT id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone, address, status, joined_date
         FROM members WHERE id = $1 LIMIT 1`,
        [id]
      ).then((r) => r.rows[0] || null);
    } catch (error) {
      console.warn('DB member by id failed, trying snapshot:', error.message);
    }
  }
  const member = loadSnapshotMembers().find((m) => Number(m.id) === num || Number(m.member_number) === num);
  return Promise.resolve(member || null);
}

async function saveMemberPin(member, pin) {
  const pinHash = await bcrypt.hash(pin, 10);
  if (process.env.DATABASE_URL) {
    try {
      const db = getDb();
      await db.query('UPDATE members SET pin_hash = $1, updated_at = NOW() WHERE id = $2', [pinHash, member.id]);
      member.pin_hash = pinHash;
      return;
    } catch (error) {
      console.warn('DB pin save failed, using dev pins file:', error.message);
    }
  }
  await saveSnapshotPin(member, pinHash, true);
  member.pin_hash = pinHash;
}

async function clearMemberPin(member, adminPayload = null) {
  if (process.env.DATABASE_URL) {
    try {
      const db = getDb();
      await db.query('UPDATE members SET pin_hash = NULL, updated_at = NOW() WHERE id = $1', [member.id]);
      member.pin_hash = null;
      await logActivity(db, {
        actor_type: adminPayload ? 'board' : 'system',
        board_member_id: adminPayload?.adminId || null,
        member_id: member.id,
        actor_label: adminPayload?.email || adminPayload?.adminId ? `Board #${adminPayload.adminId}` : 'System',
        action: 'member.pin_reset',
        entity_type: 'members',
        record_id: member.id,
        summary: `Portal PIN cleared for ${member.full_name || member.first_name || 'member'} — member must create a new PIN`,
      });
      return;
    } catch (error) {
      console.warn('DB pin clear failed, using dev pins file:', error.message);
    }
  }
  await clearSnapshotPin(member);
  member.pin_hash = null;
}

async function findMemberByIdWithPin(id) {
  const num = Number(id);
  if (process.env.DATABASE_URL) {
    try {
      const db = getDb();
      const result = await db.query(
        `SELECT id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone, address, status, pin_hash, joined_date
         FROM members WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (result.rows[0]) return result.rows[0];
    } catch (error) {
      console.warn('DB member by id failed, trying snapshot:', error.message);
    }
  }
  const member = loadSnapshotMembers().find((m) => Number(m.id) === num || Number(m.member_number) === num);
  if (!member) return null;
  const full = await findMember({ phone: member.mobile, email: member.email });
  return full || member;
}

function normPhoneDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

async function submitPinResetRequest(body) {
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim();
  const notes = String(body.notes || '').trim().slice(0, 500) || null;
  if (!phone && !email) {
    return jsonResponse(400, { error: 'Phone or email is required.' });
  }
  const member = await findMember({ phone, email });
  if (!member) {
    return jsonResponse(404, { error: 'Phone number not found. Contact (424) 547-5594 for help.' });
  }
  if (!member.pin_hash) {
    return jsonResponse(400, { error: 'No PIN is set on this account. Sign in with your phone number to create one.' });
  }

  const memberName = member.full_name || `${member.first_name || ''} ${member.last_name || ''}`.trim();
  let requestId = null;

  if (process.env.DATABASE_URL) {
    try {
      const db = getDb();
      const pending = await db.query(
        `SELECT id FROM pin_reset_requests
         WHERE member_id = $1 AND status = 'Pending'
         ORDER BY created_at DESC LIMIT 1`,
        [member.id]
      );
      if (pending.rows.length) {
        return jsonResponse(200, {
          ok: true,
          message: 'A reset request is already pending. The board will contact you soon.',
          id: pending.rows[0].id,
          duplicate: true,
        });
      }
      const insert = await db.query(
        `INSERT INTO pin_reset_requests (member_id, phone, email, member_name, notes, status)
         VALUES ($1, $2, $3, $4, $5, 'Pending')
         RETURNING id, created_at`,
        [member.id, phone || member.mobile || null, email || member.email || null, memberName, notes]
      );
      requestId = insert.rows[0]?.id;
      await notifyBoard({
        db,
        subject: `PIN reset request — ${memberName}`,
        text: [
          'A member requested a portal PIN reset:',
          '',
          `Name: ${memberName}`,
          `Phone: ${phone || member.mobile || '—'}`,
          email ? `Email: ${email}` : null,
          member.member_number ? `Member #: ${member.member_number}` : null,
          notes ? `Note: ${notes}` : null,
          '',
          'Review in Board Admin → Messages → PIN Reset.',
        ].filter(Boolean).join('\n'),
      });
    } catch (err) {
      console.error('PIN reset request save failed:', err);
      if (err.message?.includes('pin_reset_requests')) {
        return jsonResponse(503, { error: 'PIN reset requests are not available yet. Please call (424) 547-5594.' });
      }
      return jsonResponse(500, { error: 'Could not submit reset request.' });
    }
  } else {
    return jsonResponse(503, { error: 'PIN reset requests require database. Please call (424) 547-5594.' });
  }

  return jsonResponse(201, {
    ok: true,
    message: 'Reset request sent to the board. You will be able to create a new PIN after they approve it.',
    id: requestId,
  });
}

async function listPinResetRequests() {
  const db = getDb();
  const result = await db.query(
    `SELECT r.*, m.member_number, m.mobile AS member_mobile, m.email AS member_email
     FROM pin_reset_requests r
     LEFT JOIN members m ON m.id = r.member_id
     ORDER BY r.created_at DESC NULLS LAST, r.id DESC
     LIMIT 200`
  );
  return jsonResponse(200, {
    requests: result.rows.map((row) => ({
      id: row.id,
      member_id: row.member_id,
      member_number: row.member_number,
      member_name: row.member_name,
      phone: row.phone || row.member_mobile,
      email: row.email || row.member_email,
      notes: row.notes,
      status: row.status,
      created_at: row.created_at,
      reviewed_at: row.reviewed_at,
    })),
  });
}

async function resolvePinResetRequest(id, status, adminPayload) {
  const db = getDb();
  const existing = await db.query(`SELECT * FROM pin_reset_requests WHERE id = $1 LIMIT 1`, [id]);
  if (!existing.rows.length) return jsonResponse(404, { error: 'Request not found.' });
  const row = existing.rows[0];
  if (row.status !== 'Pending') {
    return jsonResponse(409, { error: `Request is already ${row.status}.` });
  }

  if (status === 'Approved' && row.member_id) {
    const member = await findMemberByIdWithPin(row.member_id);
    if (member) {
      await clearMemberPin(member, adminPayload);
    } else {
      await db.query(`UPDATE members SET pin_hash = NULL, updated_at = NOW() WHERE id = $1`, [row.member_id]);
    }
  }

  await db.query(
    `UPDATE pin_reset_requests SET status = $1, reviewed_at = NOW(), reviewed_by = $2 WHERE id = $3`,
    [status, adminPayload?.adminId || null, id]
  );

  await logActivity(db, {
    actor_type: 'board',
    board_member_id: adminPayload?.adminId || null,
    member_id: row.member_id,
    actor_label: adminPayload?.email || `Board #${adminPayload?.adminId}`,
    action: status === 'Approved' ? 'member.pin_reset_approved' : 'member.pin_reset_rejected',
    entity_type: 'pin_reset_requests',
    record_id: id,
    summary: status === 'Approved'
      ? `Approved PIN reset for ${row.member_name || 'member'}`
      : `Declined PIN reset for ${row.member_name || 'member'}`,
  });

  return listPinResetRequests();
}

function parsePinResetPath(path) {
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'pin-reset-requests') return null;
  return { id: parts[1] ? Number(parts[1]) : null, action: parts[2] || null };
}

function isQaTestMember(member) {
  const email = String(member.email || '').trim().toLowerCase();
  if (email === QA_TEST_EMAIL) return true;
  return String(member.full_name || '').toLowerCase().includes('qa test');
}

function portalFirstName(member) {
  const first = String(member.first_name || '').trim();
  if (!isQaTestMember(member) && first) return first;
  const primary = String(member.full_name || '').split('/')[0].trim();
  const fromFull = primary.split(/\s+/).filter(Boolean)[0] || '';
  return fromFull || first || 'Member';
}

function portalLastName(member) {
  const last = String(member.last_name || '').trim();
  if (!isQaTestMember(member) && last) return last;
  const primary = String(member.full_name || '').split('/')[0].trim();
  const parts = primary.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(' ') : last;
}

function buildMemberPayload(member) {
  return {
    id: member.id,
    memberNumber: member.member_number,
    first: portalFirstName(member),
    last: portalLastName(member),
    full_name: member.full_name || `${member.first_name || ''} ${member.last_name || ''}`.trim(),
    paypal_name: member.paypal_name,
    email: member.email,
    mobile: member.mobile,
    home: member.home_phone,
    address: member.address,
    status: member.status,
    joinedDate: member.joined_date
  };
}

function buildAdminPayload(admin) {
  return {
    id: admin.id,
    adminId: admin.id,
    email: admin.email,
    role: admin.role,
    is_active: admin.is_active,
    ...buildPermissionsPayload(admin),
  };
}

const BOARD_MEMBER_SELECT = `
  id, email, password_hash, role, is_active, created_at, write_approved,
  is_super_admin, board_perms, perm_full_access, perm_notes, perm_approve_payout, perm_approve_operations
`;

async function findAdmin({ email }) {
  if (!email) return null;
  const db = getDb();
  await syncSuperAdminFlags(db);
  const result = await db.query(
    `SELECT ${BOARD_MEMBER_SELECT}
     FROM board_members bm
     WHERE LOWER(bm.email) = LOWER($1)
        OR EXISTS (
          SELECT 1 FROM board_member_emails bme
          WHERE bme.board_member_id = bm.id AND LOWER(bme.email) = LOWER($1)
        )
     LIMIT 1`,
    [email]
  );
  return result.rows[0] || null;
}

async function ensureBoardMemberEmail(db, boardMemberId, email, { isPrimary = false } = {}) {
  const norm = normalizeAdminEmail(email);
  if (!norm || !boardMemberId) return;
  await db.query(
    `INSERT INTO board_member_emails (board_member_id, email, is_primary)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
     SET board_member_id = EXCLUDED.board_member_id,
         is_primary = EXCLUDED.is_primary`,
    [boardMemberId, norm, isPrimary]
  );
}

async function loadBoardMemberLoginEmails(db, boardIds) {
  if (!boardIds.length) return new Map();
  const result = await db.query(
    `SELECT board_member_id, email, is_primary
     FROM board_member_emails
     WHERE board_member_id = ANY($1::int[])
     ORDER BY is_primary DESC, email`,
    [boardIds]
  );
  const byId = new Map();
  for (const row of result.rows) {
    if (!byId.has(row.board_member_id)) byId.set(row.board_member_id, []);
    byId.get(row.board_member_id).push(row.email);
  }
  return byId;
}

function normalizeAdminEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateAdminPassword(password) {
  if (!password || String(password).length < 8) {
    return 'Password must be at least 8 characters.';
  }
  return null;
}

function parseBoardMembersPath(path) {
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
  if (parts[0] !== 'admin' || parts[1] !== 'board-members') return null;
  return {
    id: parts[2] ? Number(parts[2]) : null,
    action: parts[3] || null,
  };
}

function buildBoardMemberRow(row) {
  const memberNumber = row.member_number != null ? Number(row.member_number) : null;
  const displayName = String(row.display_name || '').trim() || null;
  const loginEmails = Array.isArray(row.login_emails) && row.login_emails.length
    ? row.login_emails
    : (row.email ? [row.email] : []);
  return {
    id: row.id,
    member_id: row.member_id != null ? Number(row.member_id) : null,
    member_number: memberNumber,
    display_name: displayName,
    email: row.email || loginEmails[0] || null,
    login_emails: loginEmails,
    role: row.role,
    is_active: row.is_active,
    created_at: row.created_at,
    has_password: !!row.password_hash || row.has_password === true,
    ...buildPermissionsPayload(row),
  };
}

async function issueAdminToken(admin) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const expiresIn = process.env.JWT_EXPIRES_IN || '1d';
  return jwt.sign(
    {
      adminId: admin.id,
      email: admin.email,
      role: 'admin',
      isSuperAdmin: !!admin.is_super_admin,
    },
    secret,
    { expiresIn }
  );
}

async function logAdminSignIn(admin, action = 'board.login', summary) {
  if (!process.env.DATABASE_URL) return;
  try {
    const db = getDb();
    await logActivity(db, {
      actor_type: 'board',
      board_member_id: admin.id,
      actor_label: admin.email,
      action,
      entity_type: 'board_members',
      record_id: admin.id,
      summary: summary || `Board sign-in: ${admin.email}`,
    });
  } catch (auditErr) {
    console.warn('Admin auth audit failed:', auditErr.message);
  }
}

async function checkAdminEmail(body) {
  const email = normalizeAdminEmail(body.email);
  if (!email) return jsonResponse(400, { error: 'Email is required.' });
  if (!adminAuthRequired()) {
    return jsonResponse(200, { invited: true, needsSetup: false, email });
  }
  const admin = await findAdmin({ email });
  if (!admin) {
    return jsonResponse(404, {
      error: 'This email is not on the board access list. Contact an administrator.',
    });
  }
  if (!admin.is_active) {
    return jsonResponse(403, { error: 'This board account has been deactivated.' });
  }
  return jsonResponse(200, {
    invited: true,
    needsSetup: !admin.password_hash,
    email: admin.email,
  });
}

async function setupAdminPassword(body) {
  const email = normalizeAdminEmail(body.email);
  const password = body.password;
  const confirm = body.confirmPassword || body.confirm_password;
  if (!email) return jsonResponse(400, { error: 'Email is required.' });
  const pwdErr = validateAdminPassword(password);
  if (pwdErr) return jsonResponse(400, { error: pwdErr });
  if (password !== confirm) return jsonResponse(400, { error: 'Passwords do not match.' });

  const admin = await findAdmin({ email });
  if (!admin || !admin.is_active) {
    return jsonResponse(404, { error: 'This email is not on the board access list.' });
  }
  if (admin.password_hash) {
    return jsonResponse(400, { error: 'Password already set. Sign in with your password.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const db = getDb();
  await db.query('UPDATE board_members SET password_hash = $1 WHERE id = $2', [passwordHash, admin.id]);
  admin.password_hash = passwordHash;

  const token = await issueAdminToken(admin);
  await logAdminSignIn(admin, 'board.password_setup', `Board password created: ${admin.email}`);
  return jsonResponse(200, { token, admin: buildAdminPayload(admin) });
}

async function listBoardMembers() {
  const db = getDb();
  await syncSuperAdminFlags(db);
  const result = await db.query(
    `SELECT bm.id, bm.member_id, bm.display_name, bm.email, bm.role, bm.is_active, bm.created_at,
            bm.is_super_admin, bm.board_perms,
            bm.perm_full_access, bm.perm_notes,
            bm.perm_approve_payout, bm.perm_approve_operations,
            (bm.password_hash IS NOT NULL) AS has_password,
            m.member_number,
            m.full_name AS member_full_name
     FROM board_members bm
     LEFT JOIN members m ON m.id = bm.member_id
     ORDER BY m.member_number NULLS LAST, bm.created_at DESC NULLS LAST, bm.id DESC`
  );
  const loginEmailsById = await loadBoardMemberLoginEmails(db, result.rows.map((row) => row.id));
  return jsonResponse(200, {
    boardMembers: result.rows.map((row) => buildBoardMemberRow({
      ...row,
      login_emails: loginEmailsById.get(row.id) || (row.email ? [row.email] : []),
    })),
    permissionDefs: BOARD_PERMISSION_DEFS,
  });
}

async function resolveCrmMemberForEmail(db, email) {
  if (!email) return null;
  const result = await db.query(
    `SELECT id, member_number, full_name FROM members WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  return result.rows[0] || null;
}

async function linkBoardMemberToCrm(db, boardId, email) {
  const member = await resolveCrmMemberForEmail(db, email);
  if (!member) return null;
  await db.query(`UPDATE board_members SET member_id = $1 WHERE id = $2`, [member.id, boardId]);
  return member;
}

async function inviteBoardMember(body, actor) {
  const email = normalizeAdminEmail(body.email);
  if (!email || !email.includes('@')) {
    return jsonResponse(400, { error: 'A valid email is required.' });
  }
  const db = getDb();
  const existing = await findAdmin({ email });
  let boardMember;
  const invitePerms = JSON.stringify(defaultInvitePerms());

  if (existing) {
    if (existing.is_active && existing.password_hash) {
      return jsonResponse(409, { error: 'This email already has board access.' });
    }
    const update = await db.query(
      `UPDATE board_members
       SET is_active = true,
           password_hash = NULL,
           role = COALESCE($2, role),
           board_perms = CASE
             WHEN board_perms IS NULL OR board_perms = '{}'::jsonb THEN $3::jsonb
             ELSE board_perms
           END,
           perm_notes = FALSE,
           perm_full_access = FALSE,
           perm_approve_payout = FALSE,
           perm_approve_operations = FALSE
       WHERE id = $1
       RETURNING id, display_name, email, role, is_active, created_at, board_perms,
                 is_super_admin, perm_full_access, perm_notes,
                 perm_approve_payout, perm_approve_operations`,
      [existing.id, body.role || null, invitePerms]
    );
    boardMember = buildBoardMemberRow({ ...update.rows[0], has_password: false });
  } else {
    const insert = await db.query(
      `INSERT INTO board_members (
         email, password_hash, role, is_active, board_perms,
         perm_notes, perm_full_access, perm_approve_payout, perm_approve_operations
       )
       VALUES ($1, NULL, $2, true, $3::jsonb, false, false, false, false)
       RETURNING id, display_name, email, role, is_active, created_at, board_perms,
                 is_super_admin, perm_full_access, perm_notes,
                 perm_approve_payout, perm_approve_operations`,
      [email, body.role || 'board', invitePerms]
    );
    boardMember = buildBoardMemberRow({ ...insert.rows[0], has_password: false });
  }

  await linkBoardMemberToCrm(db, boardMember.id, email);
  await ensureBoardMemberEmail(db, boardMember.id, email, { isPrimary: true });
  const linked = await db.query(
    `SELECT bm.id, bm.member_id, bm.display_name, bm.email, bm.role, bm.is_active, bm.created_at,
            bm.is_super_admin, bm.board_perms,
            bm.perm_full_access, bm.perm_notes,
            bm.perm_approve_payout, bm.perm_approve_operations,
            (bm.password_hash IS NOT NULL) AS has_password,
            m.member_number,
            m.full_name AS member_full_name
     FROM board_members bm
     LEFT JOIN members m ON m.id = bm.member_id
     WHERE bm.id = $1`,
    [boardMember.id]
  );
  if (linked.rows[0]) {
    boardMember = buildBoardMemberRow({
      ...linked.rows[0],
      login_emails: (await loadBoardMemberLoginEmails(db, [boardMember.id])).get(boardMember.id)
        || (linked.rows[0].email ? [linked.rows[0].email] : []),
    });
  }

  await logActivity(db, {
    actor_type: 'board',
    board_member_id: actor?.adminId || null,
    actor_label: actor?.email || 'Board Admin',
    action: 'board.invite',
    entity_type: 'board_members',
    record_id: boardMember.id,
    summary: `Board access invited: ${email}`,
  });

  return jsonResponse(201, {
    ok: true,
    boardMember,
    message: 'Invited. They can sign in and create their password.',
  });
}

async function updateBoardMemberAccess(id, action, actor, access, body = {}) {
  if (!id || Number.isNaN(id)) {
    return jsonResponse(400, { error: 'Invalid board member id.' });
  }
  const db = getDb();
  const result = await db.query(
    `SELECT id, display_name, email, role, is_active, created_at, password_hash,
            is_super_admin, perm_full_access, perm_notes,
            perm_approve_payout, perm_approve_operations
     FROM board_members WHERE id = $1 LIMIT 1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) return jsonResponse(404, { error: 'Board member not found.' });

  const needsManage = ['deactivate', 'reactivate', 'reset-password', 'permissions'];
  if (needsManage.includes(action)) {
    const denied = assertCanManageBoard(access);
    if (denied) return jsonResponse(403, { error: denied });
  }

  if (action === 'permissions') {
    if (!row.is_active) {
      return jsonResponse(400, { error: 'Reactivate this board member before changing permissions.' });
    }
    if (row.is_super_admin) {
      return jsonResponse(400, { error: 'Super admin permissions are managed via BOARD_SUPER_ADMIN_EMAILS.' });
    }
    const perms = normalizePermissionBody(body);
    const displayNameRaw = body.display_name ?? body.displayName ?? body.name ?? null;
    const displayName = displayNameRaw == null ? null : String(displayNameRaw).trim();
    const safeDisplayName = displayName && displayName.length <= 120 ? displayName : null;
    // board_members.display_name only — never updates CRM (members table).
    await db.query(
      `UPDATE board_members
       SET board_perms = $1::jsonb,
           perm_full_access = FALSE,
           perm_notes = FALSE,
           perm_approve_payout = FALSE,
           perm_approve_operations = FALSE,
           write_approved = FALSE,
           display_name = COALESCE($3, display_name)
       WHERE id = $2`,
      [JSON.stringify(perms), id, safeDisplayName]
    );
    await logActivity(db, {
      actor_type: 'board',
      board_member_id: actor?.adminId || null,
      actor_label: actor?.email || 'Board Admin',
      action: 'board.permissions_updated',
      entity_type: 'board_members',
      record_id: id,
      summary: `Board permissions updated for ${row.email}`,
      new_value: Object.assign({}, perms, safeDisplayName ? { display_name: safeDisplayName } : {}),
    });
    return jsonResponse(200, { ok: true, message: 'Permissions saved.' });
  }

  if (action === 'deactivate') {
    if (actor?.adminId && Number(actor.adminId) === id) {
      return jsonResponse(400, { error: 'You cannot deactivate your own account.' });
    }
    await db.query('UPDATE board_members SET is_active = false WHERE id = $1', [id]);
    await logActivity(db, {
      actor_type: 'board',
      board_member_id: actor?.adminId || null,
      actor_label: actor?.email || 'Board Admin',
      action: 'board.deactivate',
      entity_type: 'board_members',
      record_id: id,
      summary: `Board access deactivated: ${row.email}`,
    });
    return jsonResponse(200, { ok: true, message: 'Board access deactivated.' });
  }

  if (action === 'reactivate') {
    await db.query(
      'UPDATE board_members SET is_active = true, password_hash = NULL WHERE id = $1',
      [id]
    );
    await logActivity(db, {
      actor_type: 'board',
      board_member_id: actor?.adminId || null,
      actor_label: actor?.email || 'Board Admin',
      action: 'board.reactivate',
      entity_type: 'board_members',
      record_id: id,
      summary: `Board access reactivated: ${row.email}`,
    });
    return jsonResponse(200, {
      ok: true,
      message: 'Reactivated. They must create a new password on next sign-in.',
    });
  }

  if (action === 'reset-password') {
    if (actor?.adminId && Number(actor.adminId) === id) {
      return jsonResponse(400, { error: 'Use Change Password after sign-in, or ask another admin to reset yours.' });
    }
    await db.query('UPDATE board_members SET password_hash = NULL WHERE id = $1', [id]);
    await logActivity(db, {
      actor_type: 'board',
      board_member_id: actor?.adminId || null,
      actor_label: actor?.email || 'Board Admin',
      action: 'board.reset_password',
      entity_type: 'board_members',
      record_id: id,
      summary: `Board password reset (must set up again): ${row.email}`,
    });
    return jsonResponse(200, {
      ok: true,
      message: 'Password cleared. They will create a new one on next sign-in.',
    });
  }

  return jsonResponse(404, { error: 'Not found' });
}

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const path = getPath(event);
  let body = {};

  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (parseError) {
      return jsonResponse(400, { error: 'Invalid JSON payload' });
    }
  }

  try {
    if (event.httpMethod === 'GET' && path === '/config') {
      return jsonResponse(200, {
        adminAuthRequired: adminAuthRequired(),
        memberAuthRequired: true,
      });
    }

    if (event.httpMethod === 'POST' && path === '/check-phone') {
      const { phone, email } = body;
      if (!phone && !email) {
        return jsonResponse(400, { error: 'Phone or email is required' });
      }
      const member = await findMember({ phone, email });
      return jsonResponse(200, {
        exists: !!member,
        hasPin: !!member?.pin_hash,
        member: member ? buildMemberPayload(member) : null
      });
    }

    if (event.httpMethod === 'POST' && path === '/create-pin') {
      const { phone, email, pin } = body;
      if (!pin || !/^[0-9]{4,8}$/.test(pin)) {
        return jsonResponse(400, { error: 'PIN must be 4-8 digits' });
      }
      if (!phone && !email) {
        return jsonResponse(400, { error: 'Phone or email is required' });
      }

      const member = await findMember({ phone, email });
      if (!member) {
        return jsonResponse(404, { error: 'Member not found' });
      }

      const hadPin = !!member.pin_hash;
      await saveMemberPin(member, pin);
      if (process.env.DATABASE_URL) {
        try {
          const db = getDb();
          await logActivity(db, {
            actor_type: 'member',
            member_id: member.id,
            actor_label: member.full_name || `Member #${member.member_number || member.id}`,
            action: hadPin ? 'member.pin_changed' : 'member.pin_created',
            entity_type: 'members',
            record_id: member.id,
            summary: hadPin ? 'Member changed portal PIN' : 'Member created portal PIN',
          });
        } catch (auditErr) {
          console.warn('PIN audit log failed:', auditErr.message);
        }
      }
      return jsonResponse(200, { success: true, message: 'PIN created successfully' });
    }

    if (event.httpMethod === 'POST' && path === '/verify-pin') {
      const { phone, email, pin } = body;
      if (!pin) {
        return jsonResponse(400, { error: 'PIN is required' });
      }
      if (!phone && !email) {
        return jsonResponse(400, { error: 'Phone or email is required' });
      }

      const member = await findMember({ phone, email });
      if (!member || !member.pin_hash) {
        return jsonResponse(401, { valid: false, error: 'Member not found or PIN not set' });
      }

      const valid = await bcrypt.compare(pin, member.pin_hash);
      if (!valid) {
        return jsonResponse(401, { valid: false, error: 'Invalid PIN' });
      }

      const secret = jwtSecret();
      const expiresIn = process.env.JWT_EXPIRES_IN || '1d';
      const token = jwt.sign({ memberId: member.id, role: 'member' }, secret, { expiresIn });

      return jsonResponse(200, {
        valid: true,
        token,
        member: buildMemberPayload(member)
      });
    }

    if (event.httpMethod === 'POST' && path === '/request-pin-reset') {
      return await submitPinResetRequest(body);
    }

    const pinResetPath = parsePinResetPath(path);
    if (pinResetPath && event.httpMethod === 'GET' && !pinResetPath.id) {
      const admin = verifyAdminRequest(event);
      if (!admin) return jsonResponse(401, { error: 'Admin authorization required.' });
      try {
        return await listPinResetRequests();
      } catch (err) {
        console.error('pin reset list error:', err);
        if (err.message?.includes('pin_reset_requests')) {
          return jsonResponse(200, { requests: [] });
        }
        return jsonResponse(500, { error: 'Could not load PIN reset requests.' });
      }
    }

    if (pinResetPath?.id && event.httpMethod === 'POST' && (pinResetPath.action === 'approve' || pinResetPath.action === 'reject')) {
      const admin = verifyAdminRequest(event);
      if (!admin) return jsonResponse(401, { error: 'Admin authorization required.' });
      try {
        const db = getDb();
        const access = await loadBoardMemberAccess(db, admin);
        const denied = assertPerm(access, 'pin_reset_approve', 'You do not have permission to approve PIN reset requests.');
        if (denied) return jsonResponse(403, { error: denied });
        const status = pinResetPath.action === 'approve' ? 'Approved' : 'Rejected';
        return await resolvePinResetRequest(pinResetPath.id, status, admin);
      } catch (err) {
        console.error('pin reset review error:', err);
        return jsonResponse(500, { error: 'Could not update PIN reset request.' });
      }
    }

    if (event.httpMethod === 'POST' && path === '/admin/reset-pin') {
      const admin = verifyAdminRequest(event);
      if (!admin) return jsonResponse(401, { error: 'Admin authorization required.' });
      const db = getDb();
      const access = await loadBoardMemberAccess(db, admin);
      const denied = assertPerm(access, 'reset_pin', 'You do not have permission to reset member PINs.');
      if (denied) return jsonResponse(403, { error: denied });
      const memberId = body.memberId || body.member_id;
      if (!memberId) return jsonResponse(400, { error: 'memberId is required.' });
      try {
        const member = await findMemberByIdWithPin(memberId);
        if (!member) return jsonResponse(404, { error: 'Member not found.' });
        await clearMemberPin(member, admin);
        return jsonResponse(200, { ok: true, message: 'PIN cleared. Member can create a new PIN on next sign-in.' });
      } catch (err) {
        console.error('admin reset pin error:', err);
        return jsonResponse(500, { error: 'Could not reset PIN.' });
      }
    }

    if (event.httpMethod === 'POST' && path === '/admin/check-email') {
      return await checkAdminEmail(body);
    }

    if (event.httpMethod === 'POST' && path === '/admin/setup-password') {
      return await setupAdminPassword(body);
    }

    const boardMembersPath = parseBoardMembersPath(path);
    if (boardMembersPath && event.httpMethod === 'GET' && !boardMembersPath.id) {
      const admin = verifyAdminRequest(event);
      if (!admin) return jsonResponse(401, { error: 'Admin authorization required.' });
      try {
        const db = getDb();
        const access = await loadBoardMemberAccess(db, admin);
        const denied = assertCanManageBoard(access);
        if (denied) return jsonResponse(403, { error: denied });
        return await listBoardMembers();
      } catch (err) {
        console.error('board members list error:', err);
        return jsonResponse(500, { error: 'Could not load board access list.' });
      }
    }

    if (boardMembersPath && event.httpMethod === 'POST' && !boardMembersPath.id) {
      const admin = verifyAdminRequest(event);
      if (!admin) return jsonResponse(401, { error: 'Admin authorization required.' });
      try {
        const db = getDb();
        const access = await loadBoardMemberAccess(db, admin);
        const denied = assertCanManageBoard(access);
        if (denied) return jsonResponse(403, { error: denied });
        let actorEmail = admin.email;
        if (admin.adminId && process.env.DATABASE_URL) {
          const r = await db.query('SELECT email FROM board_members WHERE id = $1', [admin.adminId]);
          actorEmail = r.rows[0]?.email || actorEmail;
        }
        return await inviteBoardMember(body, { ...admin, email: actorEmail });
      } catch (err) {
        console.error('board invite error:', err);
        return jsonResponse(500, { error: 'Could not invite board member.' });
      }
    }

    if (boardMembersPath?.id && event.httpMethod === 'POST' && boardMembersPath.action) {
      const admin = verifyAdminRequest(event);
      if (!admin) return jsonResponse(401, { error: 'Admin authorization required.' });
      try {
        const db = getDb();
        const access = await loadBoardMemberAccess(db, admin);
        let actorEmail = admin.email;
        if (admin.adminId && process.env.DATABASE_URL) {
          const r = await db.query('SELECT email FROM board_members WHERE id = $1', [admin.adminId]);
          actorEmail = r.rows[0]?.email || actorEmail;
        }
        return await updateBoardMemberAccess(
          boardMembersPath.id,
          boardMembersPath.action,
          { ...admin, email: actorEmail },
          access,
          body
        );
      } catch (err) {
        console.error('board member update error:', err);
        return jsonResponse(500, { error: 'Could not update board access.' });
      }
    }

    if (event.httpMethod === 'POST' && path === '/admin/login') {
      const email = normalizeAdminEmail(body.email);
      const { password } = body;
      if (!email || !password) {
        return jsonResponse(400, { error: 'Email and password are required' });
      }

      const admin = await findAdmin({ email });
      if (!admin || !admin.is_active) {
        return jsonResponse(401, { error: 'Invalid credentials' });
      }

      if (!admin.password_hash) {
        return jsonResponse(403, {
          error: 'Create your password first.',
          needsSetup: true,
        });
      }

      const valid = await bcrypt.compare(password, admin.password_hash);
      if (!valid) {
        return jsonResponse(401, { error: 'Invalid credentials' });
      }

      const token = await issueAdminToken(admin);
      await logAdminSignIn(admin);
      return jsonResponse(200, {
        token,
        admin: buildAdminPayload(admin)
      });
    }

    if (event.httpMethod === 'GET' && path === '/admin/me') {
      const token = parseBearerToken(event.headers?.authorization || event.headers?.Authorization);
      if (!token) {
        return jsonResponse(401, { error: 'Authorization token required' });
      }
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        throw new Error('JWT_SECRET is not configured');
      }
      let payload;
      try {
        payload = jwt.verify(token, secret);
      } catch (tokenError) {
        return jsonResponse(401, { error: 'Invalid or expired token' });
      }
      if (payload.role !== 'admin') {
        return jsonResponse(403, { error: 'Forbidden' });
      }

      let adminId = payload.adminId;
      if (!adminId && payload.email) {
        const byEmail = await findAdmin({ email: payload.email });
        adminId = byEmail?.id || null;
      }
      if (!adminId) {
        return jsonResponse(403, { error: 'Forbidden' });
      }

      const db = getDb();
      await syncSuperAdminFlags(db);
      const result = await db.query(
        `SELECT id, email, role, is_active,
                is_super_admin, perm_full_access, perm_notes,
                perm_approve_payout, perm_approve_operations
         FROM board_members
         WHERE id = $1
         LIMIT 1`,
        [adminId]
      );
      const admin = result.rows[0];
      if (!admin) {
        return jsonResponse(404, { error: 'Admin not found' });
      }
      return jsonResponse(200, { admin: buildAdminPayload(admin) });
    }

    if (event.httpMethod === 'GET' && path === '/me') {
      const token = parseBearerToken(event.headers?.authorization || event.headers?.Authorization);
      if (!token) {
        return jsonResponse(401, { error: 'Authorization token required' });
      }
      const secret = jwtSecret();
      let payload;
      try {
        payload = jwt.verify(token, secret);
      } catch (tokenError) {
        return jsonResponse(401, { error: 'Invalid or expired token' });
      }
      const member = await findMemberById(payload.memberId);
      if (!member) {
        return jsonResponse(404, { error: 'Member not found' });
      }
      return jsonResponse(200, { member: buildMemberPayload(member) });
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Auth error:', error);
    return jsonResponse(500, { error: error.message });
  }
};
