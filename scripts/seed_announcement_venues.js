/**
 * Seed default church & funeral venues for announcement intake dropdowns.
 * Usage: npm run db:seed-ann-venues
 */
require('dotenv').config();
const { getDb } = require('../netlify/functions/db');
const { DEFAULT_SERVICE_VENUES } = require('../netlify/functions/event-announcement');

async function main() {
  const db = getDb();
  for (const entry of DEFAULT_SERVICE_VENUES) {
    const venue = entry.venue.slice(0, 200);
    const address = entry.address || '';
    await db.query(`
      INSERT INTO announcement_service_venues (service_type, venue, address, use_count, last_used_at)
      VALUES ($1, $2, $3, 1, NOW())
      ON CONFLICT (service_type, venue, address)
      DO UPDATE SET last_used_at = NOW()
    `, [entry.service_type, venue, address]);
    console.log(`[${entry.service_type}] ${venue}`);
    console.log(`  ${address}`);
  }
  console.log(`Seeded ${DEFAULT_SERVICE_VENUES.length} announcement service venues.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
