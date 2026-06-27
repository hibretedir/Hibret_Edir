/**
 * Board admin production smoke checks (DB + static code sanity).
 * Usage: node scripts/board_admin_smoke.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getDb } = require('../netlify/functions/db');
const { buildPermissionsPayload } = require('../netlify/functions/board-permissions');

const ROOT = path.join(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(ROOT, 'public/admin/index.html'), 'utf8');

const checks = [];

function pass(name, detail = '') {
  checks.push({ name, ok: true, detail });
}

function fail(name, detail = '') {
  checks.push({ name, ok: false, detail });
}

async function main() {
  if (!adminHtml.includes('async function claimFollowUpMember')) {
    fail('follow-up save function', 'claimFollowUpMember missing from admin UI');
  } else {
    pass('follow-up save function');
  }

  if (!adminHtml.includes("valid.push('follow-up')")) {
    fail('follow-up hash route', '#follow-up deep link not wired');
  } else {
    pass('follow-up hash route');
  }

  if (adminHtml.includes('await claimFollowUpMember(memberId, selectEl);\n  if (btnEl)')) {
    fail('follow-up save merge', 'duplicate/broken saveFollowUpSelfAssignment body');
  } else {
    pass('follow-up save merge');
  }

  const db = getDb();

  const table = await db.query(`SELECT to_regclass('public.member_board_assignments') AS t`);
  if (!table.rows[0]?.t) {
    fail('schema member_board_assignments', 'table missing — run npm run db:migrate');
  } else {
    pass('schema member_board_assignments');
  }

  const board = await db.query(`
    SELECT id, display_name, email, role, board_perms, is_active
    FROM board_members
    WHERE is_active = TRUE
    ORDER BY id
  `);

  for (const row of board.rows) {
    const perms = buildPermissionsPayload(row).perms;
    const role = String(row.role || '').toLowerCase();
    if (role === 'advisor') {
      if (perms.follow_up) fail(`board #${row.id} advisor follow_up`, 'advisor should not have follow_up');
      else pass(`board #${row.id} advisor follow_up blocked`);
      continue;
    }
    if (!perms.follow_up) {
      fail(`board #${row.id} follow_up`, `${row.display_name || row.email} missing follow_up permission`);
    } else {
      pass(`board #${row.id} follow_up`, row.display_name || row.email);
    }
  }

  const assignCount = await db.query('SELECT COUNT(*)::int AS c FROM member_board_assignments');
  pass('assignments table readable', `${assignCount.rows[0].c} rows`);

  const failed = checks.filter((c) => !c.ok);
  console.log('\nBoard admin smoke checks\n');
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
