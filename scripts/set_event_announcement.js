/**
 * Set funeral announcement details on events.notes (JSON) for the public site.
 * Usage:
 *   node scripts/set_event_announcement.js 30
 *   node scripts/set_event_announcement.js 30 --file scripts/announcements/event-30.json
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getDb } = require('../netlify/functions/db');

const KNOWN = {
  30: {
    collect_dues: true,
    church_service: {
      enabled: true,
      venue: "St. Mary's Ethiopian Orthodox Tewahedo Church",
      address: '5505 West Slauson Ave, Los Angeles, CA 90056',
      datetime: 'Thursday, April 23 at 10:00 AM',
    },
    funeral_service: {
      enabled: true,
      venue: 'Holy Cross Cemetery',
      address: '5835 W Slauson Ave, Culver City, CA 90230',
      datetime: '',
    },
    guest_reception: { enabled: false, venue: '', address: '', datetime: '' },
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const eventNumber = Number(args.find((a) => /^\d+$/.test(a)));
  if (!eventNumber) {
    console.error('Usage: node scripts/set_event_announcement.js <event_number> [--file path.json]');
    process.exit(1);
  }
  const fileIdx = args.indexOf('--file');
  let meta = KNOWN[eventNumber] || null;
  if (fileIdx >= 0 && args[fileIdx + 1]) {
    const filePath = path.resolve(args[fileIdx + 1]);
    meta = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  if (!meta) {
    console.error(`No announcement data for event #${eventNumber}. Pass --file path.json`);
    process.exit(1);
  }
  return { eventNumber, meta };
}

async function main() {
  const { eventNumber, meta } = parseArgs();
  const db = getDb();
  const { metaToNotesJson, normalizeAnnouncementMeta } = require('../netlify/functions/event-announcement');
  const notes = metaToNotesJson(normalizeAnnouncementMeta(meta));
  const result = await db.query(
    `UPDATE events
     SET notes = $2, updated_at = NOW()
     WHERE event_number = $1
     RETURNING event_number, deceased_name, notes`,
    [eventNumber, notes]
  );
  if (!result.rows.length) {
    console.error(`Event #${eventNumber} not found.`);
    process.exit(1);
  }
  const row = result.rows[0];
  console.log(`Updated announcement for Event #${row.event_number} — ${row.deceased_name}`);
  console.log(row.notes);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
