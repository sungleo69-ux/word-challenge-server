// Turns the raw search candidates from kakao-search.js into one clean, readable 뜻풀이 (definition)
// — a two-step "synthesize, then verify" pipeline using the Anthropic API, per 정현님's explicit
// request: one call drafts a summary from ONLY the fetched snippets, a second, independent call
// checks that draft doesn't say anything the snippets don't actually support (catches hallucination)
// and rewrites it if it does.
//
// This is NOT the same cost story as the /api/words/*/live endpoints in generate.js — those do a
// fresh web_search tool call (billed per search) plus generation. This only summarizes text we
// already fetched for free via Kakao/Wikipedia, so it's just two short token-based completions —
// materially cheaper per use. It only runs when a user manually searches an unregistered word (not
// on every refresh), so real-world volume should be low.
//
// Requires ANTHROPIC_API_KEY. If unset, callers should treat synthesis as unavailable and fall back
// to showing the raw candidate list only (same "degrade gracefully" pattern as generate.js).

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

async function callClaude(prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error("ANTHROPIC_API_KEY not set — lookup synthesis unavailable");
    err.code = "NO_API_KEY";
    throw err;
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object found in model output");
  return JSON.parse(raw.slice(start, end + 1));
}

function formatSnippets(candidates) {
  return candidates
    .map((c, i) => `[${i + 1}] (출처: ${c.source?.label || "?"})\n${c.description}`)
    .join("\n\n");
}

// Step 1: draft a summary using ONLY the fetched snippets as ground truth.
async function draftSummary(term, candidates) {
  const prompt = `"${term}"라는 단어를 검색했더니 아래와 같은 실제 검색 결과 스니펫들을 찾았어. 이 스니펫들"만" 근거로 삼아서, "오늘의 단어 챌린지"라는 한국어 비즈니스/테크 용어 학습 앱에 어울리는 친근한 구어체(~해요체)로 뜻풀이를 1~3문장으로 요약해줘.

규칙:
- 스니펫에 없는 내용은 절대 지어내지 마.
- 스니펫들이 서로 다른 뜻(예: 반려동물용, 전선용, AI 업계 용어 등)을 담고 있으면, 그 사실을 명시하고 여러 뜻을 간단히 구분해서 설명해.

검색 결과:
${formatSnippets(candidates)}

반드시 아래 JSON 형식으로만 답해, 다른 말 하지 마:
{"summary": string}`;
  const text = await callClaude(prompt, 500);
  return extractJson(text).summary;
}

// Step 2: an independent pass checks the draft doesn't say anything the snippets don't support, and
// rewrites it (grounded only in the snippets) if it does.
async function verifySummary(term, candidates, summary) {
  const prompt = `다음은 "${term}"에 대한 뜻풀이 초안과, 그 근거로 쓰인 검색 결과 스니펫들이야. 이 초안이 스니펫에 없는 내용을 지어내고 있지는 않은지(hallucination), 스니펫 내용과 명백히 다른 얘기를 하고 있지는 않은지 검증해줘.

검색 결과:
${formatSnippets(candidates)}

뜻풀이 초안:
"${summary}"

반드시 아래 JSON 형식으로만 답해, 다른 말 하지 마:
{"faithful": boolean, "correctedSummary": string (faithful이 false면 스니펫 근거로만 다시 쓴 문장, true면 원래 초안 그대로 반환)}`;
  const text = await callClaude(prompt, 400);
  return extractJson(text);
}

// Returns { summary, verified } or null if synthesis isn't available/fails — caller should fall
// back to showing the raw candidate list alone in that case, exactly like before this existed.
async function synthesizeAndVerify(term, candidates) {
  if (!candidates || !candidates.length) return null;
  const draft = await draftSummary(term, candidates);
  const verdict = await verifySummary(term, candidates, draft);
  return {
    summary: verdict.faithful ? draft : verdict.correctedSummary,
    verified: !!verdict.faithful,
  };
}

module.exports = { synthesizeAndVerify };
