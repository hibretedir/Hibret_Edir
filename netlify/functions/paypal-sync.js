// netlify/functions/paypal-sync.js
// PayPal Invoice Sync — Hibret Edir
// Fetches all invoices from PayPal and returns payment status
// Environment variables needed:
//   PAYPAL_CLIENT_ID
//   PAYPAL_SECRET

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // Step 1: Get PayPal access token
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_SECRET;

    if (!clientId || !secret) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'PayPal credentials not configured' })
      };
    }

    const authResponse = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    const authData = await authResponse.json();
    const accessToken = authData.access_token;

    // Step 2: Fetch invoices
    const invoicesResponse = await fetch(
      'https://api-m.paypal.com/v2/invoicing/invoices?page_size=100&total_count_required=true',
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const invoicesData = await invoicesResponse.json();

    // Step 3: Return formatted invoices
    const invoices = (invoicesData.items || []).map(inv => ({
      id: inv.id,
      status: inv.status,
      recipient: inv.primary_recipients?.[0]?.billing_info?.name?.full_name || '',
      email: inv.primary_recipients?.[0]?.billing_info?.email_address || '',
      amount: inv.amount?.value || '0',
      currency: inv.amount?.currency_code || 'USD',
      due_date: inv.payment_term?.due_date || '',
      invoice_date: inv.detail?.invoice_date || '',
      memo: inv.detail?.memo || '',
      items: (inv.items || []).map(item => ({
        name: item.name,
        description: item.description,
        quantity: item.quantity,
        unit_amount: item.unit_amount?.value
      }))
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        count: invoices.length,
        invoices
      })
    };

  } catch (error) {
    console.error('PayPal sync error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
