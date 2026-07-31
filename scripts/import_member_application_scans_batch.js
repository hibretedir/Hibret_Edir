/**
 * Batch import wrapper — prefer the auto watcher (`npm run dev` starts it).
 *   node scripts/import_member_application_scans_batch.js
 *   node scripts/import_member_application_scans_batch.js --apply --only-empty
 */

require('dotenv').config();
const { Client } = require('pg');
const { syncApplicationScans, DEFAULT_ROOT } = require('./lib/application-scan-sync');

function parseArgs(argv) {
  const out = { apply: false, onlyEmpty: true, root: DEFAULT_ROOT };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--only-empty') out.onlyEmpty = true;
    else if (a === '--replace') out.onlyEmpty = false;
    else if (a === '--root') out.root = argv[++i];
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 20000,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const result = await syncApplicationScans(client, {
      root: args.root,
      onlyEmpty: args.onlyEmpty,
      dryRun: !args.apply,
      log: console.log,
    });
    console.log('\n---');
    console.log(result);
    if (!args.apply) console.log('Dry-run only — re-run with --apply to write.');
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
