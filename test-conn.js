const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/allstars_dev',
  ssl: false,
  statement_timeout: 5000,
  connectionTimeoutMillis: 5000
});

(async () => {
  try {
    console.log('Connecting...');
    const client = await pool.connect();
    console.log('Connected!');
    
    const res = await client.query('SELECT NOW()');
    console.log('Query result:', res.rows[0]);
    
    client.release();
    await pool.end();
    console.log('Done');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
