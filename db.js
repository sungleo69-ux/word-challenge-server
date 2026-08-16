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

    ALTER TABLE words ADD COLUMN IF NOT EXISTS retired BOOLEAN DEFAULT FALSE;
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
  const { rows } = await pool.query(
    "SELECT * FROM words WHERE session = $1 AND retired = FALSE ORDER BY id ASC",
    [session]
  );
  return rows.map(rowToWord);
}

async function getAllWords() {
  const { rows } = await pool.query("SELECT * FROM words WHERE retired = FALSE ORDER BY id ASC");
  return rows.map(rowToWord);
}

async function getCategories() {
  const { rows } = await pool.query("SELECT DISTINCT category, MIN(id) AS first_id FROM words GROUP BY category ORDER BY first_id ASC");
  return rows.map((r) => r.category);
}

async function searchWords(q) {
  const like = `%${q}%`;
  const { rows } = await pool.query(
    "SELECT * FROM words WHERE (term ILIKE $1 OR full_text ILIKE $1) AND retired = FALSE LIMIT 5",
    [like]
  );
  return rows.map(rowToWord);
}

// Retires (soft-deletes) words by exact term match within a session, so old attempts/history
// referencing them stay intact (no FK violation) but they stop showing up in quizzes.
async function retireWordsByTerm(terms, session) {
  if (!terms || !terms.length) return 0;
  const { rowCount } = await pool.query(
    "UPDATE words SET retired = TRUE WHERE session = $1 AND term = ANY($2::text[]) AND retired = FALSE",
    [session, terms]
  );
  return rowCount;
}

// Adds one fresh, real word (already authored from a real web search + source) to a session.
// Skips insertion if a non-retired word with the same term already exists in that session,
// so re-running the same ingestion payload (e.g. on every cold-start restart) is harmless.
async function addWord(w, session, isMemo = false) {
  const { rows: existing } = await pool.query(
    "SELECT id FROM words WHERE session = $1 AND term = $2 AND retired = FALSE",
    [session, w.term]
  );
  if (existing.length) return { id: existing[0].id, skipped: true };
  const id = await insertWord(w, session, isMemo);
  return { id, skipped: false };
}

// Marks a memo as converted and links it to the word that was generated from it — mirrors what
// attachGeneratedWord() does for the paid-API path, but usable from the free WORD_REFRESH_JSON
// ingest path too. Only touches memos that are still 'pending', so re-running the same ingestion
// payload on a later restart won't re-link (or double-count) an already-converted memo.
async function linkMemoToWord(memoId, wordId) {
  const { rowCount } = await pool.query(
    "UPDATE memos SET status = 'converted', word_id = $1 WHERE id = $2 AND status = 'pending'",
    [wordId, memoId]
  );
  return rowCount > 0;
}

// Ingests fresh, web-search-sourced words delivered via the WORD_REFRESH_JSON env var, so new
// content can be pushed to the live database without a code deploy: an operator (or a scheduled
// Claude session with Render access) sets the env var, Render restarts the service, and this runs
// on boot. Format: JSON array of { session, retireTerms?: string[], words: [...] } batches.
// A word may include a `memoId` field — if present, that memo is marked 'converted' and linked
// to the new word (instead of staying 'pending' forever), same as the paid-API generate path.
// Idempotent — safe to leave the same value set across many restarts.
async function ingestFreshWords() {
  const raw = process.env.WORD_REFRESH_JSON;
  if (!raw) return { ran: false };
  let batches;
  try {
    batches = JSON.parse(raw);
  } catch (e) {
    console.error("WORD_REFRESH_JSON is not valid JSON, skipping ingest:", e.message);
    return { ran: false, error: "invalid JSON" };
  }
  if (!Array.isArray(batches)) batches = [batches];

  let retired = 0;
  let inserted = 0;
  let skipped = 0;
  let memosLinked = 0;
  for (const batch of batches) {
    if (!batch || !batch.session) continue;
    if (batch.retireTerms && batch.retireTerms.length) {
      retired += await retireWordsByTerm(batch.retireTerms, batch.session);
    }
    for (const w of batch.words || []) {
      const result = await addWord(w, batch.session, !!batch.isMemo || !!w.memoId);
      if (result.skipped) skipped++;
      else inserted++;
      if (w.memoId && !result.skipped) {
        const linked = await linkMemoToWord(w.memoId, result.id);
        if (linked) memosLinked++;
      }
    }
  }
  return { ran: true, retired, inserted, skipped, memosLinked };
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
  addWord,
  retireWordsByTerm,
  ingestFreshWords,
};
