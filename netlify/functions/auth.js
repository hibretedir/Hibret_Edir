// netlify/functions/auth.js
// Member Authentication — Hibret Edir
// Handles PIN login for member portal
// Environment variables needed:
//   DATABASE_URL
//   JWT_SECRET

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const path = event.path.replace('/.netlify/functions/auth', '');
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // POST /auth/check-phone — verify phone exists in members db
    if (event.httpMethod === 'POST' && path === '/check-phone') {
      const { phone } = body;
      // TODO: Query Render PostgreSQL for member by phone
      // const member = await db.query('SELECT * FROM members WHERE mobile=$1 OR home=$2', [phone, phone]);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ exists: true, firstTime: false, message: 'Coming soon — backend not yet connected' })
      };
    }

    // POST /auth/verify-pin — check PIN against hashed value in db
    if (event.httpMethod === 'POST' && path === '/verify-pin') {
      const { phone, pin } = body;
      // TODO: Hash PIN and compare with stored hash
      // const bcrypt = require('bcryptjs');
      // const member = await db.query('SELECT * FROM members WHERE phone=$1', [phone]);
      // const valid = await bcrypt.compare(pin, member.pin_hash);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ valid: true, message: 'Coming soon — backend not yet connected' })
      };
    }

    // POST /auth/create-pin — save new PIN for first-time user
    if (event.httpMethod === 'POST' && path === '/create-pin') {
      const { phone, pin } = body;
      // TODO: Hash PIN and save to database
      // const bcrypt = require('bcryptjs');
      // const hash = await bcrypt.hash(pin, 10);
      // await db.query('UPDATE members SET pin_hash=$1 WHERE phone=$2', [hash, phone]);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'Coming soon — backend not yet connected' })
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' })
    };

  } catch (error) {
    console.error('Auth error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
