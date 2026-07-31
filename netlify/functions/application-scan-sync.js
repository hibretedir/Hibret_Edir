/**
 * Once-per-day (Pacific) or forced sync of Drive scan folders → CRM.
 * Scheduled on Netlify daily; no-ops without APPLICATION_SCANS_ROOT / Drive Desktop.
 *
 * Manual: GET/POST /.netlify/functions/application-scan-sync?secret=CRON_SECRET
 * Force:  ...&force=1
 */

const { Client } = require('pg');
const path = require('path');
const fs = require('fs');

function loadSyncModule() {
  const candidates = [
    path.join(__dirname, '../../scripts/lib/application-scan-sync.js'),
    path.join(process.cwd(), 'scripts/lib/application-scan-sync.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('application-scan-sync module not found');
}

function authorized(event) {
  const secret = process.env.CRON_SECRET || process.env.PAYPAL_CRON_SECRET || '';
  if (!secret) return false;
  const q = event.queryStringParameters || {};
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  if (q.secret === secret) return true;
  if (header === `Bearer ${secret}`) return true;
  return false;
}

exports.handler = async (event) => {
  if (!authorized(event)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let syncApplicationScans;
  let DEFAULT_ROOT;
  let hasSyncedToday;
  let markSyncedToday;
  let pacificDateKey;
  try {
    ({
      syncApplicationScans,
      DEFAULT_ROOT,
      hasSyncedToday,
      markSyncedToday,
      pacificDateKey,
    } = loadSyncModule());
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  const q = event.queryStringParameters || {};
  const force = q.force === '1' || q.force === 'true';
  const today = typeof pacificDateKey === 'function' ? pacificDateKey() : null;

  if (!force && typeof hasSyncedToday === 'function' && hasSyncedToday()) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        skipped: true,
        reason: 'already_synced_today',
        day: today,
      }),
    };
  }

  const root = process.env.APPLICATION_SCANS_ROOT || DEFAULT_ROOT;
  if (!fs.existsSync(root)) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        skipped: true,
        reason: 'APPLICATION_SCANS_ROOT not available on this host (expected on local Drive Desktop)',
        root,
        day: today,
      }),
    };
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 20000,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const result = await syncApplicationScans(client, {
      root,
      onlyEmpty: false,
      dryRun: false,
      log: console.log,
    });
    if (result.ok !== false && typeof markSyncedToday === 'function') {
      markSyncedToday();
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ ...result, day: today }),
    };
  } catch (err) {
    console.error('application-scan-sync failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  } finally {
    try { await client.end(); } catch (_) { /* ignore */ }
  }
};
