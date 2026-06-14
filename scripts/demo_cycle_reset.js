/**
 * Reset the system-validation demo cycle (same logic as Admin → Reset demo cycle).
 *
 * Usage:
 *   node scripts/demo_cycle_reset.js              # dry run
 *   node scripts/demo_cycle_reset.js --apply      # execute reset
 *
 * Requires DEMO_QA_EMAIL in .env (and DEMO_QA_ENABLED=true for API; CLI always allowed).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(ENV_PATH);

const APPLY = process.argv.includes('--apply');
const { getDb } = require('../netlify/functions/db');
const { resetDemoQaCycle, getDemoQaEmail, maskEmail } = require('../netlify/functions/demo-qa-reset');

async function main() {
  const email = getDemoQaEmail();
  if (!email) {
    console.error('Set DEMO_QA_EMAIL in .env (the dedicated validation identity).');
    process.exit(1);
  }

  console.log(APPLY ? 'Applying demo QA reset…\n' : 'Dry run (add --apply to execute):\n');
  console.log(`  Demo email: ${maskEmail(email)}\n`);

  const db = getDb();
  const result = await resetDemoQaCycle(db, {
    email,
    dryRun: !APPLY,
    allowCli: true,
    actor: { actor_type: 'system', actor_label: 'Demo reset script' },
  });

  console.log(JSON.stringify(result.plan, null, 2));
  console.log(`\n${result.message}`);

  await db.end().catch(() => {});
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
