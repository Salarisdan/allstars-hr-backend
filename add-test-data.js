const { Pool } = require('pg');
const pg = new Pool();

(async () => {
  try {
    // Get user's agency_id
    const userRes = await pg.query('SELECT agency_id FROM users WHERE email = $1', ['salarisdan@gmail.com']);
    if (!userRes.rows.length) {
      console.log('User not found');
      await pg.end();
      return;
    }

    const agencyId = userRes.rows[0].agency_id;
    console.log('Agency ID:', agencyId);

    // Insert test candidates
    const candidates = [
      {
        name: 'Алёна Петрова',
        tg: '@alena_petrova',
        status: 'Работает',
        platform: 'OnlyFans',
        experience: 6,
        agency_id: agencyId
      },
      {
        name: 'Мария Смирнова',
        tg: '@maria_smirnova',
        status: 'Работает',
        platform: 'Fansly',
        experience: 3,
        agency_id: agencyId
      },
      {
        name: 'Виктория Кузнецова',
        tg: '@victoria_kuzn',
        status: 'Ждет тест',
        platform: 'OnlyFans',
        experience: 0,
        agency_id: agencyId
      },
      {
        name: 'Анастасия Соколова',
        tg: '@anastasia_sok',
        status: 'Ожидание старта',
        platform: 'Fansly',
        experience: 2,
        agency_id: agencyId
      },
      {
        name: 'Елена Волкова',
        tg: '@elena_volkova',
        status: 'Верификация',
        platform: 'OnlyFans',
        experience: 1,
        agency_id: agencyId
      }
    ];

    for (const c of candidates) {
      const res = await pg.query(
        `INSERT INTO candidates (name, tg, telegram, status, platform, experience, experience_months, agency_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
         RETURNING id, name, status`,
        [c.name, c.tg, c.tg, c.status, c.platform, c.experience, c.experience, c.agency_id]
      );
      console.log(`✓ Added: ${res.rows[0].name} (${res.rows[0].status})`);
    }

    console.log('\nTest data inserted successfully');
    await pg.end();
  } catch (err) {
    console.error('Error:', err.message);
  }
})();
