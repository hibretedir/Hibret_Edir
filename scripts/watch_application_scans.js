/**
 * Watch Drive member-scan folders and auto-import PDFs into CRM (Admin preview).
 * Started automatically by `npm run dev`. Standalone:
 *   node scripts/watch_application_scans.js
 */

require('dotenv').config();
const { Client } = require('pg');
const {
  DEFAULT_ROOT,
  syncApplicationScans,
} = require('./lib/application-scan-sync');

const INTERVAL_MS = Number(process.env.APPLICATION_SCANS_POLL_MS || 60000);
const ROOT = process.env.APPLICATION_SCANS_ROOT || DEFAULT_ROOT;

let running = false;

async function tick() {
  if (running) return;
  running = true;
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 20000,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    // onlyEmpty:false so adding a 2nd PDF to an existing folder updates CRM
    const result = await syncApplicationScans(client, {
      root: ROOT,
      onlyEmpty: false,
      dryRun: false,
      log: (msg) => {
        if (String(msg).startsWith('[imported]')) console.log(`[scan-sync] ${msg}`);
      },
    });
    if (result.imported > 0) {
      console.log(
        `[scan-sync] Imported ${result.imported} scan(s): #${result.importedMembers.join(', #')}`
      );
    }
  } catch (err) {
    console.warn('[scan-sync]', err.message || err);
  } finally {
    try { await client.end(); } catch (_) { /* ignore */ }
    running = false;
  }
}

console.log(`[scan-sync] Watching ${ROOT} every ${Math.round(INTERVAL_MS / 1000)}s`);
tick();
setInterval(tick, INTERVAL_MS);
