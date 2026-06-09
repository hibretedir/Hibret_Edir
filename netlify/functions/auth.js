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
const { findSnapshotMember, saveSnapshotPin, loadSnapshotMembers } = require('./member-snapshot');
const { logActivity } = require('./audit');
const { adminAuthRequired } = require('./admin-auth');

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
