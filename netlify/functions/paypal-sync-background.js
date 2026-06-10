// Background PayPal sync — full batched pull (up to 15 min on Netlify).
// Invoked by paypal-sync-scheduled or manually with X-Cron-Secret header.

const { runPayPalSyncFullBatched, verifyCronSecret } = require('./paypal-sync');

const headers = {
  'Content-Type': 'application/json',
};

function json(statusCode, payload) {
  return { statusCode, headers, body: JSON.stringify(payload) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (!verifyCronSecret(event)) {
    return json(401, { error: 'Unauthorized' });
  }

  try {
    console.log('Background PayPal sync starting…');
    const result = await runPayPalSyncFullBatched();
    console.log(
      'Background PayPal sync complete:',
      result.paypal_total,
      'invoices in',
      result.batches,
      'batches'
    );
    return json(200, { ...result, mode: 'background' });
  } catch (err) {
    console.error('Background PayPal sync error:', err);
    if (err.message?.includes('DATABASE_URL')) {
      return json(503, { error: 'Database is not configured.' });
    }
    return json(500, { error: err.message || 'PayPal sync failed.' });
  }
};
