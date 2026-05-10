const { Pool } = require('pg');
const pg = new Pool();

(async () => {
  try {
    // Get user's agency
    const userRes = await pg.query('SELECT id, agency_id FROM users WHERE email = $1', ['salarisdan@gmail.com']);
    if (!userRes.rows.length) {
      console.log('User not found');
      await pg.end();
      return;
    }

    const { agency_id } = userRes.rows[0];
    console.log('Agency ID:', agency_id);

    // Get candidates count for this agency
    const candRes = await pg.query('SELECT COUNT(*) as cnt FROM candidates WHERE agency_id = $1', [agency_id]);
    console.log('Total candidates for agency:', candRes.rows[0].cnt);

    // Get candidates with their statuses
    const statsRes = await pg.query(
      'SELECT status, COUNT(*) as cnt FROM candidates WHERE agency_id = $1 GROUP BY status ORDER BY cnt DESC LIMIT 10',
      [agency_id]
    );
    console.log('\nCandidates by status:');
    statsRes.rows.forEach(row => console.log(`  ${row.status || '(null)'}: ${row.cnt}`));

    // Get team members (if any)
    const teamRes = await pg.query('SELECT COUNT(*) as cnt FROM team_members WHERE agency_id = $1', [agency_id]);
    console.log('\nTeam members:', teamRes.rows[0].cnt);

    await pg.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
})();
