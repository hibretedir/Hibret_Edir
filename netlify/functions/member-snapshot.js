// Local dev fallback when DATABASE_URL is unavailable (Google Drive / no Postgres yet).
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const SNAPSHOT_PATH = path.join(__dirname, '../../public/portal/members-snapshot.json');
const DEV_PINS_PATH = path.join(__dirname, '.dev-pins.json');

let membersCache = null;

function normPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function loadSnapshotMembers() {
  if (membersCache) return membersCache;
  try {
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    membersCache = JSON.parse(raw).members || [];
  } catch {
    membersCache = [];
  }
  return membersCache;
}

function loadDevPins() {
  try {
    return JSON.parse(fs.readFileSync(DEV_PINS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveDevPins(pins) {
  fs.writeFileSync(DEV_PINS_PATH, JSON.stringify(pins, null, 2), 'utf8');
}

function pinKey(member) {
  return String(member.member_number || member.id || normPhone(member.mobile));
}

function findSnapshotMember({ phone, email }) {
  const digits = normPhone(phone);
  const emailLower = email ? String(email).trim().toLowerCase() : '';
  const pins = loadDevPins();

  for (const m of loadSnapshotMembers()) {
    const mobile = normPhone(m.mobile);
    const home = normPhone(m.home_phone);
    const phoneMatch = digits && (mobile === digits || home === digits);
    const emailMatch = emailLower && m.email && m.email.toLowerCase() === emailLower;
    if (!phoneMatch && !emailMatch) continue;
    const key = pinKey(m);
    return {
      ...m,
      pin_hash: pins[key] || null,
      joined_date: null,
    };
  }
  return null;
}

async function saveSnapshotPin(member, pinOrHash, isHash = false) {
  const pins = loadDevPins();
  pins[pinKey(member)] = isHash ? pinOrHash : await bcrypt.hash(pinOrHash, 10);
  saveDevPins(pins);
}

async function clearSnapshotPin(member) {
  const pins = loadDevPins();
  delete pins[pinKey(member)];
  saveDevPins(pins);
}

module.exports = {
  findSnapshotMember,
  saveSnapshotPin,
  clearSnapshotPin,
  loadSnapshotMembers,
};
