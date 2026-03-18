const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// БД в /data на Railway (персистентный volume) или локально
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'candidates.db');
const db = new Database(DB_PATH);

// Создаём таблицу если нет
db.exec(`
  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    name TEXT,
    tg TEXT,
    age TEXT,
    english TEXT,
    exp TEXT,
    platforms TEXT,
    shift TEXT,
    schedule TEXT,
    top_pages TEXT,
    avg_check TEXT,
    job TEXT,
    status TEXT,
    ratings TEXT,
    total INTEGER DEFAULT 0
  )
`);

app.use(cors());
app.use(express.json());

// GET /candidates — все кандидаты
app.get('/candidates', (req, res) => {
  const rows = db.prepare('SELECT * FROM candidates ORDER BY id DESC').all();
  rows.forEach(r => { try { r.ratings = JSON.parse(r.ratings); } catch { r.ratings = {}; } });
  res.json(rows);
});

// POST /candidates — сохранить
app.post('/candidates', (req, res) => {
  const { fields = {}, ratings = {}, total = 0 } = req.body;
  const stmt = db.prepare(`
    INSERT INTO candidates (name, tg, age, english, exp, platforms, shift, schedule, top_pages, avg_check, job, status, ratings, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    fields.name || '', fields.tg || '', fields.age || '', fields.english || '',
    fields.exp || '', fields.platforms || '', fields.shift || '', fields.schedule || '',
    fields.top || '', fields.avgcheck || '', fields.job || '', fields.status || '',
    JSON.stringify(ratings), total
  );
  const saved = db.prepare('SELECT * FROM candidates WHERE id = ?').get(result.lastInsertRowid);
  try { saved.ratings = JSON.parse(saved.ratings); } catch { saved.ratings = {}; }
  res.status(201).json(saved);
});

// DELETE /candidates/:id — удалить
app.delete('/candidates/:id', (req, res) => {
  db.prepare('DELETE FROM candidates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'AllStars HR Backend' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
