/**
 * Once-per-Pacific-day sync of Drive scan folders → CRM.
 * Safe to run often — exits immediately if already synced today.
 *
 *   node scripts/sync_application_scans_daily.js
 *   node scripts/sync_application_scans_daily.js --force
 */
require('dotenv').config();
const { Client } = require('pg');
const {
  DEFAULT_ROOT,
  syncApplicationScans,
  hasSyncedToday,
  markSyncedToday,
  pacificDateKey,
  readDailySyncStamp,
} = require('./lib/application-scan-sync');

const force = process.argv.includes('--force');

(async () => {
  const today = pacificDateKey();
  if (!force && hasSyncedToday()) {
    console.log(`[scan-sync:daily] Already synced for ${today} — skip`);
    process.exit(0);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 20000,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    console.log(
      `[scan-sync:daily] Starting (${today})${force ? ' --force' : ''}`
      + (readDailySyncStamp() ? `; last stamp ${readDailySyncStamp()}` : '')
    );
    const result = await syncApplicationScans(client, {
      root: process.env.APPLICATION_SCANS_ROOT || DEFAULT_ROOT,
      onlyEmpty: false,
      dryRun: false,
      log: console.log,
    });
    if (result.ok !== false) markSyncedToday();
    console.log('[scan-sync:daily] Done', {
      imported: result.imported,
      skipped: result.skipped,
      found: result.found,
      missingMember: result.missingMember,
      tooBig: result.tooBig,
      errors: result.errors,
    });
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error('[scan-sync:daily]', err.message || err);
  process.exit(1);
});
