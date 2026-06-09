let pool;

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
    });
  }
  return pool;
}

module.exports = { getDb };
