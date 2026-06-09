const jwt = require('jsonwebtoken');

function adminAuthRequired() {
  return process.env.ADMIN_AUTH_ENABLED === 'true';
}

function parseBearerToken(authorizationHeader) {
  if (!authorizationHeader) return null;
  const parts = authorizationHeader.split(' ');
  if (parts[0] !== 'Bearer' || !parts[1]) return null;
  return parts[1];
}

function verifyAdminRequest(event) {
  if (!adminAuthRequired()) {
    return { role: 'admin', bypass: true, adminId: null };
  }
  const token = parseBearerToken(event.headers?.authorization || event.headers?.Authorization);
  if (!token) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const payload = jwt.verify(token, secret);
    return payload.role === 'admin' ? payload : null;
  } catch {
    return null;
  }
}

function verifyMemberRequest(event) {
  const token = parseBearerToken(event.headers?.authorization || event.headers?.Authorization);
  if (!token) return null;
  const secret = process.env.JWT_SECRET || 'hibret-local-dev-secret';
  try {
    const payload = jwt.verify(token, secret);
    return payload.role === 'member' && payload.memberId ? payload : null;
  } catch {
    return null;
  }
}

function buildActorFromAdmin(adminPayload, adminRow) {
  return {
    actor_type: 'board',
    board_member_id: adminPayload?.adminId || null,
    member_id: null,
    actor_label: adminRow?.email || 'Board Admin',
  };
}

function buildActorFromMember(memberPayload, memberRow) {
  const name = memberRow?.full_name
    || `${memberRow?.first_name || ''} ${memberRow?.last_name || ''}`.trim();
  return {
    actor_type: 'member',
    board_member_id: null,
    member_id: memberPayload?.memberId || memberRow?.id || null,
    actor_label: name || `Member #${memberPayload?.memberId}`,
  };
}

function buildSystemActor(label) {
  return {
    actor_type: 'system',
    board_member_id: null,
    member_id: null,
    actor_label: label || 'System',
  };
}

module.exports = {
  adminAuthRequired,
  parseBearerToken,
  verifyAdminRequest,
  verifyMemberRequest,
  buildActorFromAdmin,
  buildActorFromMember,
  buildSystemActor,
};
