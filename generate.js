// Real content generation: given a memo word (something the user jotted down after a meeting),
// research it with Claude's web_search tool and author a full quiz card, using the SAME schema
// the frontend expects. This is the piece that, in this sandbox, only Claude (me) could do live
// via the Agent/Workflow tools — those aren't reachable from plain server code, so here it's
// reimplemented as a normal Anthropic API call. Requires ANTHROPIC_API_KEY.
//
// If no key is set, callers should treat generation as unavailable and say so — the rest of the
// API (serving seeded words, memo CRUD, stats) works fine without it.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

const STYLE_GUIDE = `톤 참고 (기존 문제 예시):
- explain 예시: "완벽하게 만들기 전에, 핵심 기능만 담아 빠르게 세상에 내놓는 제품을 뜻해요. 요리로 치면 풀코스 대신 '일단 한 그릇 먼저 내보는 것'이에요."
- whyWrong 예시: "이건 '이달의 우수사원' 같은 인사 용어에 가까워요. MVP는 사람이 아니라 제품 얘기예요."
친근하고 쉬운 구어체, 반말 아닌 '~해요'체, 비유를 섞어서 설명. 선택지 4개 중 정답 1개, 나머지 3개는 그럴듯하지만 명확히 틀린 오답.
whyWrong 배열은 4칸이고 정답 인덱스 자리만 null, 나머지 3칸에 왜 틀렸는지 짧게 설명.

반드시 아래 JSON 스키마 형태로만, 다른 말 없이 JSON 하나만 출력해:
{
  "term": string,
  "full": string,
  "category": "내가 메모한 단어",
  "question": string,
  "choices": [string, string, string, string],
  "answer": number (0-3),
  "explain": string,
  "whyWrong": [string|null, string|null, string|null, string|null],
  "knewRate": number (5-70),
  "source": { "label": string, "detail": string, "url": string }
}`;

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object found in model output");
  return JSON.parse(raw.slice(start, end + 1));
}

async function generateWordFromMemo(term) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error("ANTHROPIC_API_KEY not set — generation unavailable");
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
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      messages: [
        {
          role: "user",
          content: `"${term}"라는 용어를 회의에서 들었는데 무슨 뜻인지 몰라서 메모해뒀어. 웹검색으로 실제 의미와 맥락을 조사한 다음, 한국어 출퇴근 단어 학습 앱 "오늘의 단어 챌린지"용 4지선다 퀴즈 카드를 만들어줘.\n\n${STYLE_GUIDE}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const word = extractJson(textBlock);

  // minimal shape guard
  if (!word.term || !Array.isArray(word.choices) || word.choices.length !== 4) {
    throw new Error("model output did not match the expected quiz schema");
  }
  word.category = word.category || "내가 메모한 단어";
  return word;
}

module.exports = { generateWordFromMemo };
