let pool;

const CONNECT_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = 30000;

function getDb() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured');
    }

    const { Pool } = require('pg');
    const useSsl = /render\.com|neon\.tech|amazonaws\.com/i.test(connectionString);
    pool = new Pool({
      connectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      statement_timeout: QUERY_TIMEOUT_MS,
    });
  }
  return pool;
}

module.exports = { getDb };
