require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
        ? { rejectUnauthorized: false }
        : false
  });

  const q = `
    select id, name, tg, telegram, status, lead_source, created_at, updated_at, status_changed_at, hired_at
    from candidates
    where lower(coalesce(lead_source, '')) like '%giyonchik%'
       or lower(coalesce(lead_source, '')) like '%реферал%'
       or lower(coalesce(status, '')) like '%работает%'
    order by updated_at desc
    limit 200
  `;

  const r = await pool.query(q);
  console.log(JSON.stringify(r.rows, null, 2));
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
