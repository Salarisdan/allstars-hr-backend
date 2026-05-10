#!/usr/bin/env node

// Quick insecure script to add test data - only for dev/demo

const fs = require('fs');
const path = require('path');

// Try to load .env or use environment
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/allstars_dev',
  ssl: false
});

async function insertTestData() {
  try {
    // Get agency_id for the user
    const userRes = await pool.query(
      'SELECT agency_id FROM users WHERE email = $1 LIMIT 1',
      ['salarisdan@gmail.com']
    );

    if (!userRes.rows.length) {
      console.error('❌ User not found');
      await pool.end();
      return;
    }

    const agencyId = userRes.rows[0].agency_id;
    console.log('✓ Found agency ID:', agencyId);

    // Check existing count
    const existing = await pool.query(
      'SELECT COUNT(*) as cnt FROM candidates WHERE agency_id = $1',
      [agencyId]
    );
    console.log('✓ Existing candidates:', existing.rows[0].cnt);

    // Insert test candidates
    const testData = [
      { name: 'Алёна Петрова', tg: '@alena_petrova', status: 'Работает', platform: 'OnlyFans', exp: 6 },
      { name: 'Мария Смирнова', tg: '@maria_smirnova', status: 'Работает', platform: 'Fansly', exp: 3 },
      { name: 'Виктория Кузнецова', tg: '@victoria_kuzn', status: 'Ждет тест', platform: 'OnlyFans', exp: 0 },
      { name: 'Анастасия Соколова', tg: '@anastasia_sok', status: 'Ожидание старта', platform: 'Fansly', exp: 2 },
      { name: 'Елена Волкова', tg: '@elena_volkova', status: 'Верификация', platform: 'OnlyFans', exp: 1 }
    ];

    let addedCount = 0;
    for (const item of testData) {
      try {
        const res = await pool.query(
          `INSERT INTO candidates 
           (name, tg, telegram, status, platform, experience_months, agency_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
           RETURNING id, name, status`,
          [item.name, item.tg, item.tg, item.status, item.platform, item.exp, agencyId]
        );
        console.log(`✓ Added: ${res.rows[0].name} (${res.rows[0].status})`);
        addedCount++;
      } catch (itemErr) {
        console.warn(`⚠ Skipped ${item.name}:`, itemErr.message);
      }
    }
    console.log(`\n✓ Successfully added ${addedCount} candidates`);

    console.log('\n✅ Test data inserted successfully!');
    
    // Show summary
    const summary = await pool.query(
      'SELECT status, COUNT(*) as cnt FROM candidates WHERE agency_id = $1 GROUP BY status',
      [agencyId]
    );
    console.log('\nCandidates by status:');
    summary.rows.forEach(row => {
      console.log(`  ${row.status}: ${row.cnt}`);
    });

    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

insertTestData();
