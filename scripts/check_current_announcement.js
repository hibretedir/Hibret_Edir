require('dotenv').config();
const { getDb } = require('../netlify/functions/db');
const { getCurrentAnnouncementFromDb } = require('../netlify/functions/event-announcement');

async function main() {
  const db = getDb();
  const ev = await db.query(`
    SELECT event_number, deceased_name, status, updated_at
    FROM events
    WHERE deceased_name IS NOT NULL AND TRIM(deceased_name) <> ''
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 8
  `);
  const mem = await db.query(`
    SELECT id, deceased_name, status, updated_at
    FROM memorial_announcements
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 8
  `).catch(() => ({ rows: [] }));

  console.log('\nRecent events:');
  for (const r of ev.rows) {
    console.log(`  #${r.event_number} ${r.deceased_name} [${r.status}] updated ${r.updated_at}`);
  }
  console.log('\nRecent memorial_announcements:');
  for (const r of mem.rows) {
    console.log(`  id=${r.id} ${r.deceased_name} [${r.status}] updated ${r.updated_at}`);
  }

  const brook = await db.query(`
    SELECT event_number, deceased_name, status, updated_at
    FROM events
    WHERE event_number = 30
       OR deceased_name ILIKE '%brook%'
       OR deceased_name ILIKE '%zewdie%'
    ORDER BY event_number
  `);
  console.log('\nBrook / event 30:');
  for (const r of brook.rows) {
    console.log(`  #${r.event_number} ${r.deceased_name} [${r.status}] updated ${r.updated_at}`);
  }

  const cur = await getCurrentAnnouncementFromDb();
  console.log('\nCurrent public announcement:');
  console.log(`  ${cur?.deceased_name_display || cur?.deceased_name || '(none)'}`);
  console.log(`  event_number: ${cur?.event_number ?? 'memorial'}`);
  console.log(`  collect_dues: ${cur?.collect_dues}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
