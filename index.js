const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'candidates.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    name TEXT, tg TEXT, age TEXT, english TEXT, exp TEXT,
    platforms TEXT, shift TEXT, schedule TEXT,
    top_pages TEXT, avg_check TEXT, job TEXT, status TEXT,
    notes TEXT DEFAULT '',
    status_history TEXT DEFAULT '[]',
    ratings TEXT, total INTEGER DEFAULT 0
  )
`);
try { db.exec("ALTER TABLE candidates ADD COLUMN notes TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE candidates ADD COLUMN status_history TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE candidates ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))"); } catch {}

app.use(cors());
app.use(express.json());

function parseRow(r) {
  try { r.ratings = JSON.parse(r.ratings); } catch { r.ratings = {}; }
  try { r.status_history = JSON.parse(r.status_history); } catch { r.status_history = []; }
  return r;
}

app.get('/candidates', (req, res) => {
  res.json(db.prepare('SELECT * FROM candidates ORDER BY id DESC').all().map(parseRow));
});

app.post('/candidates', (req, res) => {
  const { fields = {}, ratings = {}, total = 0 } = req.body;
  const history = fields.status ? JSON.stringify([{ status: fields.status, date: new Date().toISOString() }]) : '[]';
  const result = db.prepare(`
    INSERT INTO candidates (name,tg,age,english,exp,platforms,shift,schedule,top_pages,avg_check,job,status,notes,status_history,ratings,total)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    fields.name||'', fields.tg||'', fields.age||'', fields.english||'',
    fields.exp||'', fields.platforms||'', fields.shift||'', fields.schedule||'',
    fields.top||'', fields.avgcheck||'', fields.job||'', fields.status||'',
    fields.notes||'', history, JSON.stringify(ratings), total
  );
  res.status(201).json(parseRow(db.prepare('SELECT * FROM candidates WHERE id=?').get(result.lastInsertRowid)));
});

app.patch('/candidates/:id', (req, res) => {
  const { fields = {}, ratings, total, notes } = req.body;
  const ex = db.prepare('SELECT * FROM candidates WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'Not found' });
  let history = [];
  try { history = JSON.parse(ex.status_history || '[]'); } catch {}
  if (fields.status && fields.status !== ex.status) {
    history.push({ status: fields.status, date: new Date().toISOString() });
  }
  db.prepare(`
    UPDATE candidates SET
      name=?,tg=?,age=?,english=?,exp=?,platforms=?,shift=?,schedule=?,
      top_pages=?,avg_check=?,job=?,status=?,notes=?,ratings=?,total=?,
      status_history=?,updated_at=datetime('now')
    WHERE id=?
  `).run(
    fields.name??ex.name, fields.tg??ex.tg, fields.age??ex.age,
    fields.english??ex.english, fields.exp??ex.exp,
    fields.platforms??ex.platforms, fields.shift??ex.shift,
    fields.schedule??ex.schedule, fields.top??ex.top_pages,
    fields.avgcheck??ex.avg_check, fields.job??ex.job,
    fields.status??ex.status,
    notes!==undefined?notes:ex.notes,
    ratings!==undefined?JSON.stringify(ratings):ex.ratings,
    total!==undefined?total:ex.total,
    JSON.stringify(history), req.params.id
  );
  res.json(parseRow(db.prepare('SELECT * FROM candidates WHERE id=?').get(req.params.id)));
});

app.delete('/candidates/:id', (req, res) => {
  db.prepare('DELETE FROM candidates WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
