// Zero-framework backend for word-challenge (no Express — plain node:http), backed by Postgres
// (see db.js) so data survives restarts on Render's free tier.
const http = require("http");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { generateWordFromMemo, generateFreshSession } = require("./generate");
const { lookupTermCandidates } = require("./kakao-search");
const { synthesizeAndVerify } = require("./lookup-synthesis");

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

    // "새로고침 = 진짜 새 문제" 모드: 저장된 걸 돌려주는 게 아니라, 그 자리에서 실제 웹검색 +
    // 생성을 새로 돌려서 신선한 문제를 만들어요. ANTHROPIC_API_KEY가 없으면 501을 주고,
    // 프론트엔드는 이 경우 평소처럼 저장된 단어 목록으로 조용히 돌아가요.
    const liveMatch = pathname.match(/^\/api\/words\/(am|pm)\/live$/);
    if (liveMatch && req.method === "GET") {
      const session = liveMatch[1];
      const count = Math.min(Math.max(Number(searchParams.get("count")) || (session === "am" ? 6 : 3), 1), 8);
      try {
        const fresh = await generateFreshSession(session, count);
        const saved = [];
        for (const w of fresh) {
          const result = await db.addWord(w, session);
          saved.push({ ...w, id: result.id, session, isMemo: false });
        }
        return send(res, 200, saved);
      } catch (e) {
        if (e.code === "NO_API_KEY") {
          return send(res, 501, {
            error: "live generation unavailable — set ANTHROPIC_API_KEY on the server to enable it",
          });
        }
        console.error("live generation failed:", e);
        return send(res, 500, { error: e.message });
      }
    }

    if (pathname === "/api/words/search" && req.method === "GET") {
      const q = searchParams.get("q") || "";
      return send(res, 200, q.trim() ? await db.searchWords(q.trim()) : []);
    }

    // 검색창에 쳤는데 우리 퀴즈 목록엔 없는 단어용: 무료 카카오 검색 + 위키백과로 실제 뜻 + 출처
    // 링크 후보를 최대 3개까지 찾아옴. 후보가 여러 개인 이유는, 한 개만 골라서 보여주면 애매한
    // 단어(예: "하네스")에서 엉뚱한 뜻을 자동으로 확정해버릴 위험이 있어서예요.
    //
    // ANTHROPIC_API_KEY가 설정돼 있으면(유료), 그 후보들을 근거로 짧은 뜻풀이 한 문장을 합성해서
    // 같이 내려줌 — 작성 담당 1번 호출 + 검증 담당 1번 호출, 총 2번의 짧은 호출(이미 공짜로 가져온
    // 텍스트를 요약하는 것뿐이라 generate.js의 /live 엔드포인트처럼 매번 새 웹검색을 하는 것보다
    // 훨씬 저렴함). 키가 없거나 합성이 실패하면 summary 없이 후보 목록만 내려주고, 프론트엔드는
    // 이 경우 알아서 목록만 보여줌(우아하게 저하 — 다른 곳과 동일한 패턴).
    //
    // 후보가 하나도 없으면 found:false — 프론트엔드는 이 경우 "메모해두기" 버튼을 보여줌.
    if (pathname === "/api/words/lookup" && req.method === "GET") {
      const term = (searchParams.get("term") || "").trim();
      if (!term) return send(res, 400, { error: "term is required" });
      try {
        const candidates = await lookupTermCandidates(term, 3);
        if (!candidates.length) return send(res, 200, { found: false });

        let summary = null;
        try {
          summary = await synthesizeAndVerify(term, candidates);
        } catch (e) {
          if (e.code !== "NO_API_KEY") console.error("lookup synthesis failed (showing raw candidates only):", e.message);
        }

        return send(res, 200, { found: true, term, candidates, summary });
      } catch (e) {
        console.error("term lookup failed:", e);
        return send(res, 200, { found: false, error: e.message });
      }
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

  const ingest = await db.ingestFreshWords();
  if (ingest.ran) {
    console.log(
      `WORD_REFRESH_JSON ingest: retired ${ingest.retired}, inserted ${ingest.inserted}, skipped (already present) ${ingest.skipped}, memos linked ${ingest.memosLinked || 0}.`
    );
  }

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
