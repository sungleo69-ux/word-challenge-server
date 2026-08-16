// Zero-framework backend for word-challenge (no Express — plain node:http), backed by Postgres
// (see db.js) so data survives restarts on Render's free tier.
const http = require("http");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { generateWordFromMemo } = require("./generate");

const PORT = process.env.PORT || 4000;

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    ...headers,
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        e.statusCode = 400;
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const STATIC_FILE = path.join(__dirname, "final.html");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname, searchParams } = url;

  if (req.method === "OPTIONS") return send(res, 204, "");

  try {
    if (pathname === "/" && req.method === "GET") {
      if (fs.existsSync(STATIC_FILE)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(fs.readFileSync(STATIC_FILE));
      }
      return send(res, 200, "word-challenge API server. See /api/* routes.");
    }

    if (pathname === "/healthz" && req.method === "GET") {
      return send(res, 200, { ok: true });
    }

    if (pathname === "/api/words/am" && req.method === "GET") {
      return send(res, 200, await db.getWordsBySession("am"));
    }

    if (pathname === "/api/words/pm" && req.method === "GET") {
      return send(res, 200, await db.getWordsBySession("pm"));
    }

    if (pathname === "/api/words/all" && req.method === "GET") {
      return send(res, 200, await db.getAllWords());
    }

    if (pathname === "/api/words/search" && req.method === "GET") {
      const q = searchParams.get("q") || "";
      return send(res, 200, q.trim() ? await db.searchWords(q.trim()) : []);
    }

    if (pathname === "/api/categories" && req.method === "GET") {
      return send(res, 200, await db.getCategories());
    }

    if (pathname === "/api/memos" && req.method === "GET") {
      return send(res, 200, await db.getMemos());
    }

    if (pathname === "/api/memos" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.text || !body.text.trim()) return send(res, 400, { error: "text is required" });
      const memo = await db.createMemo(body.text.trim());
      return send(res, 201, memo);
    }

    const generateMatch = pathname.match(/^\/api\/memos\/(\d+)\/generate$/);
    if (generateMatch && req.method === "POST") {
      const memoId = Number(generateMatch[1]);
      const memos = await db.getMemos();
      const memo = memos.find((m) => m.id === memoId);
      if (!memo) return send(res, 404, { error: "memo not found" });
      try {
        const wordObj = await generateWordFromMemo(memo.text);
        const saved = await db.attachGeneratedWord(memoId, wordObj);
        return send(res, 200, saved);
      } catch (e) {
        await db.markMemoFailed(memoId);
        if (e.code === "NO_API_KEY") {
          return send(res, 501, {
            error: "generation unavailable — set ANTHROPIC_API_KEY on the server to enable it",
          });
        }
        return send(res, 500, { error: e.message });
      }
    }

    if (pathname === "/api/attempts" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.wordId) return send(res, 400, { error: "wordId is required" });
      await db.recordAttempt(body.wordId, !!body.correct);
      return send(res, 201, { ok: true });
    }

    if (pathname === "/api/stats" && req.method === "GET") {
      return send(res, 200, await db.getStats());
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    const status = e.statusCode || 500;
    if (status >= 500) console.error(e);
    return send(res, status, { error: status === 400 ? "invalid JSON body" : e.message });
  }
});

async function main() {
  console.log("Connecting to Postgres and ensuring schema...");
  await db.initSchema();
  const seedResult = await db.seedIfEmpty();
  console.log(
    seedResult.seeded
      ? `Seeded database with ${seedResult.count} words.`
      : `Database already has ${seedResult.count} words — skipping seed.`
  );

  server.listen(PORT, () => {
    console.log(`word-challenge API listening on port ${PORT}`);
    console.log(
      `ANTHROPIC_API_KEY ${process.env.ANTHROPIC_API_KEY ? "set — generation enabled" : "not set — /api/memos/:id/generate will return 501"}`
    );
  });
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
