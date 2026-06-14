/** Print (and optionally send) the invitation email with the current PUBLIC_SITE_URL. */
require('dotenv').config();
const { getPublicSiteUrl } = require('../netlify/functions/notify');
const { getDb } = require('../netlify/functions/db');
const { notifyWaitingListInvited } = require('../netlify/functions/notify');

(async () => {
  const applyUrl = `${getPublicSiteUrl()}/apply`;
  console.log('PUBLIC_SITE_URL →', getPublicSiteUrl());
  console.log('Apply link:', applyUrl);

  if (!process.argv.includes('--send')) {
    console.log('\nAdd --send to deliver to the QA waiting-list row on file.');
    return;
  }

  const db = getDb();
  const email = (process.env.DEMO_QA_EMAIL || process.env.TEST_NOTIFY_EMAIL || '').trim().toLowerCase();
  const res = await db.query(
    `SELECT * FROM waiting_list WHERE LOWER(email) = LOWER($1) ORDER BY id DESC LIMIT 1`,
    [email]
  );
  const row = res.rows[0];
  if (!row) {
    console.error('No waiting list row for', email);
    process.exit(1);
  }
  await notifyWaitingListInvited(db, row);
  console.log('✓ Invitation email sent to', row.email);
  await db.end();
})();
