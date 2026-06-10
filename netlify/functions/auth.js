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

async function findMemberInDb({ phone, email }) {
  const db = getDb();
  const result = await db.query(
    `SELECT id, member_number, first_name, last_name, full_name, paypal_name, email, mobile, home_phone, address, status, pin_hash, joined_date
     FROM members
     WHERE ($1::text IS NOT NULL AND (
       regexp_replace(mobile, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
       OR regexp_replace(home_phone, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
     ))
     OR ($2::text IS NOT NULL AND LOWER(email) = LOWER($2))
     LIMIT 1`,
    [phone || null, email || null]
  );
  return result.rows[0] || null;
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

function buildMemberPayload(member) {
  return {
    id: member.id,
    memberNumber: member.member_number,
    first: member.first_name,
    last: member.last_name,
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
    email: admin.email,
    role: admin.role,
    is_active: admin.is_active
  };
}

async function findAdmin({ email }) {
  if (!email) return null;
  const db = getDb();
  const result = await db.query(
    `SELECT id, email, password_hash, role, is_active
     FROM board_members
     WHERE LOWER(email) = LOWER($1)
     LIMIT 1`,
    [email]
  );
  return result.rows[0] || null;
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

    if (event.httpMethod === 'POST' && path === '/admin/login') {
      const { email, password } = body;
      if (!email || !password) {
        return jsonResponse(400, { error: 'Email and password are required' });
      }

      const admin = await findAdmin({ email });
      if (!admin || !admin.is_active) {
        return jsonResponse(401, { error: 'Invalid credentials' });
      }

      const valid = await bcrypt.compare(password, admin.password_hash);
      if (!valid) {
        return jsonResponse(401, { error: 'Invalid credentials' });
      }

      const secret = process.env.JWT_SECRET;
      if (!secret) {
        throw new Error('JWT_SECRET is not configured');
      }
      const expiresIn = process.env.JWT_EXPIRES_IN || '1d';
      const token = jwt.sign({ adminId: admin.id, role: 'admin' }, secret, { expiresIn });
      if (process.env.DATABASE_URL) {
        try {
          const db = getDb();
          await logActivity(db, {
            actor_type: 'board',
            board_member_id: admin.id,
            actor_label: admin.email,
            action: 'board.login',
            entity_type: 'board_members',
            record_id: admin.id,
            summary: `Board sign-in: ${admin.email}`,
          });
        } catch (auditErr) {
          console.warn('Admin login audit failed:', auditErr.message);
        }
      }
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
      if (payload.role !== 'admin' || !payload.adminId) {
        return jsonResponse(403, { error: 'Forbidden' });
      }

      const db = getDb();
      const result = await db.query(
        `SELECT id, email, role, is_active
         FROM board_members
         WHERE id = $1
         LIMIT 1`,
        [payload.adminId]
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
