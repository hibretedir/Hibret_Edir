// Netlify scheduled trigger — runs hourly, syncs at 9:00 AM and 6:00 PM Pacific.
// Dispatches paypal-sync-background so the full pull can exceed the 60s HTTP limit.

const { getLosAngelesHour, verifyCronSecret } = require('./paypal-sync');

const SYNC_HOURS_PACIFIC = [9, 18];

exports.handler = async (event) => {
  const force = verifyCronSecret(event);
  const laHour = getLosAngelesHour();

  if (!force && !SYNC_HOURS_PACIFIC.includes(laHour)) {
    console.log(`PayPal scheduled sync skipped (LA hour ${laHour}, want ${SYNC_HOURS_PACIFIC.join(', ')})`);
    return {
      statusCode: 200,
      body: JSON.stringify({ skipped: true, la_hour: laHour }),
    };
  }

  const cronSecret = process.env.CRON_SECRET || process.env.PAYPAL_CRON_SECRET;
  if (!cronSecret) {
    console.error('CRON_SECRET not configured — cannot run scheduled PayPal sync');
    return {
      statusCode: 503,
      body: JSON.stringify({ error: 'CRON_SECRET not configured on Netlify' }),
    };
  }

  const siteUrl = (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/$/, '');
  if (!siteUrl) {
    console.error('URL / DEPLOY_PRIME_URL missing — cannot dispatch background sync');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Site URL not configured' }),
    };
  }

  try {
    console.log(`Dispatching background PayPal sync (LA hour ${laHour}, forced=${force})…`);
    const res = await fetch(`${siteUrl}/.netlify/functions/paypal-sync-background`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NF-Background': 'true',
        'X-Cron-Secret': cronSecret,
      },
      body: JSON.stringify({ source: force ? 'manual' : 'scheduled', la_hour: laHour }),
    });
    const bodyText = await res.text();
    console.log('Background dispatch status:', res.status, bodyText.slice(0, 300));

    return {
      statusCode: res.ok ? 200 : 502,
      body: JSON.stringify({
        dispatched: res.ok,
        status: res.status,
        la_hour: laHour,
        forced: force,
      }),
    };
  } catch (err) {
    console.error('Failed to dispatch background PayPal sync:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'Dispatch failed' }),
    };
  }
};
