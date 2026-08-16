// Postgres layer for word-challenge, using Render's managed Postgres (free tier) so data survives
// restarts/redeploys — a plain local SQLite file wouldn't, since Render's free web services have
// an ephemeral filesystem. Requires DATABASE_URL (Render sets this automatically when the DB is
// attached to the service).
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS words (
      id SERIAL PRIMARY KEY,
      term TEXT NOT NULL,
      full_text TEXT,
      category TEXT NOT NULL,
      question TEXT NOT NULL,
      choices_json TEXT NOT NULL,
      answer INTEGER NOT NULL,
      explain TEXT NOT NULL,
      why_wrong_json TEXT NOT NULL,
      knew_rate INTEGER DEFAULT 30,
      source_label TEXT,
      source_detail TEXT,
      source_url TEXT,
      is_memo BOOLEAN DEFAULT FALSE,
      session TEXT DEFAULT 'am',
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS memos (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      word_id INTEGER REFERENCES words(id),
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id SERIAL PRIMARY KEY,
      word_id INTEGER NOT NULL REFERENCES words(id),
      correct BOOLEAN NOT NULL,
      answered_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

function rowToWord(row) {
  return {
    id: row.id,
    term: row.term,
    full: row.full_text,
    category: row.category,
    question: row.question,
    choices: JSON.parse(row.choices_json),
    answer: row.answer,
    explain: row.explain,
    whyWrong: JSON.parse(row.why_wrong_json),
    knewRate: row.knew_rate,
    source: { label: row.source_label, detail: row.source_detail, url: row.source_url },
    isMemo: !!row.is_memo,
    session: row.session,
  };
}

async function insertWord(w, session, isMemo = false) {
  const { rows } = await pool.query(
    `INSERT INTO words (term, full_text, category, question, choices_json, answer, explain, why_wrong_json, knew_rate, source_label, source_detail, source_url, is_memo, session)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      w.term,
      w.full || "",
      w.category,
      w.question,
      JSON.stringify(w.choices),
      w.answer,
      w.explain,
      JSON.stringify(w.whyWrong),
      w.knewRate || 30,
      w.source?.label || null,
      w.source?.detail || null,
      w.source?.url || null,
      isMemo,
      session,
    ]
  );
  return rows[0].id;
}

async function seedIfEmpty() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM words");
  if (rows[0].count > 0) return { seeded: false, count: rows[0].count };

  const seedPath = path.join(__dirname, "seed-data.json");
  const { WORDS, ISSUE_WORDS, MEETING_WORDS } = JSON.parse(fs.readFileSync(seedPath, "utf8"));

  for (const w of WORDS) await insertWord(w, "am");
  for (const w of ISSUE_WORDS) await insertWord(w, "pm");
  for (const w of MEETING_WORDS) {
    const wordId = await insertWord(w, "pm", true);
    await pool.query("INSERT INTO memos (text, status, word_id) VALUES ($1, 'converted', $2)", [w.term, wordId]);
  }

  return { seeded: true, count: WORDS.length + ISSUE_WORDS.length + MEETING_WORDS.length };
}

async function getWordsBySession(session) {
  const { rows } = await pool.query("SELECT * FROM words WHERE session = $1 ORDER BY id ASC", [session]);
  return rows.map(rowToWord);
}

async function getAllWords() {
  const { rows } = await pool.query("SELECT * FROM words ORDER BY id ASC");
  return rows.map(rowToWord);
}

async function getCategories() {
  const { rows } = await pool.query("SELECT DISTINCT category, MIN(id) AS first_id FROM words GROUP BY category ORDER BY first_id ASC");
  return rows.map((r) => r.category);
}

async function searchWords(q) {
  const like = `%${q}%`;
  const { rows } = await pool.query(
    "SELECT * FROM words WHERE term ILIKE $1 OR full_text ILIKE $1 LIMIT 5",
    [like]
  );
  return rows.map(rowToWord);
}

async function createMemo(text) {
  const { rows } = await pool.query(
    "INSERT INTO memos (text) VALUES ($1) RETURNING *",
    [text]
  );
  return rows[0];
}

async function getMemos() {
  const { rows } = await pool.query("SELECT * FROM memos ORDER BY id DESC");
  return rows;
}

async function attachGeneratedWord(memoId, wordObj) {
  const wordId = await insertWord(wordObj, "pm", true);
  await pool.query("UPDATE memos SET status = 'converted', word_id = $1 WHERE id = $2", [wordId, memoId]);
  const { rows } = await pool.query("SELECT * FROM words WHERE id = $1", [wordId]);
  return rowToWord(rows[0]);
}

async function markMemoFailed(memoId) {
  await pool.query("UPDATE memos SET status = 'failed' WHERE id = $1", [memoId]);
}

async function recordAttempt(wordId, correct) {
  await pool.query("INSERT INTO attempts (word_id, correct) VALUES ($1, $2)", [wordId, correct]);
}

async function getStats() {
  const { rows: totalRows } = await pool.query("SELECT COUNT(*)::int AS c FROM attempts");
  const { rows: correctRows } = await pool.query("SELECT COUNT(*)::int AS c FROM attempts WHERE correct = true");
  const { rows: dayRows } = await pool.query("SELECT COUNT(DISTINCT date(answered_at))::int AS c FROM attempts");
  const total = totalRows[0].c;
  const correct = correctRows[0].c;
  return {
    totalAttempts: total,
    correctCount: correct,
    correctRate: total > 0 ? Math.round((correct / total) * 100) : 0,
    daysActive: dayRows[0].c,
  };
}

module.exports = {
  pool,
  initSchema,
  seedIfEmpty,
  getWordsBySession,
  getAllWords,
  getCategories,
  searchWords,
  createMemo,
  getMemos,
  attachGeneratedWord,
  markMemoFailed,
  recordAttempt,
  getStats,
};
