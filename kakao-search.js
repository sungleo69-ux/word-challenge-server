// Free, no-LLM lookup for terms the app doesn't have a quiz card for yet. Uses the Kakao(Daum)
// Search API (free tier, no credit card, no business registration — just a Kakao account) to find
// a real, current Korean explanation + source URL for a term. Falls back to the Korean Wikipedia
// REST API (always free, no key) if Kakao has nothing or isn't configured. This intentionally does
// NOT call the Anthropic API — no per-search cost, unlike the /api/words/*/live endpoints in
// index.js.
//
// (This replaces an earlier attempt at the Naver Search API — as of Aug 2026 Naver moved that API
// to a separate "NAVER API HUB" / Cloud Platform product with a more involved signup, so Kakao's
// simpler single-REST-API-key flow is used instead. See kakao-search.js's sibling naver-search.js,
// which is unused dead code now — harmless to leave in the repo, nothing requires it.)
//
// Requires KAKAO_REST_API_KEY env var to use Kakao. If unset, this silently skips straight to the
// Wikipedia fallback (same "degrade gracefully" pattern as ANTHROPIC_API_KEY).

function stripHtml(s) {
  if (!s) return "";
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

async function searchKakao(term, type) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return null;

  const url = `https://dapi.kakao.com/v2/search/${type}?query=${encodeURIComponent(term)}&size=3`;
  const res = await fetch(url, {
    headers: { Authorization: `KakaoAK ${key}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.documents || [];
}

const KAKAO_SOURCE_LABEL = {
  blog: "카카오(다음) 블로그",
  web: "카카오(다음) 웹문서",
  cafe: "카카오(다음) 카페",
};

async function lookupFromWikipedia(term) {
  try {
    const res = await fetch(`https://ko.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.extract) return null;
    return {
      term,
      description: data.extract,
      source: {
        label: "위키백과",
        url: data.content_urls?.desktop?.page || `https://ko.wikipedia.org/wiki/${encodeURIComponent(term)}`,
      },
    };
  } catch (e) {
    console.error("Wikipedia lookup failed:", e.message);
    return null;
  }
}

// Among a batch of search results, prefer one whose TITLE plainly announces itself as a
// definition/glossary post (contains "뜻", "의미", or "정의") over just taking whatever ranked #1 —
// a plain keyword search can surface a post that only mentions the term in passing (e.g. searching
// "하네스" alone once returned a post about "AI 하네스 엔지니어링" that used the word once, not an
// actual explanation of what a harness is). Falls back to the top result if no title matches.
function pickBestMatch(items) {
  const definitional = items.find((it) => /뜻|의미|정의/.test(stripHtml(it.title)));
  return definitional || items[0];
}

async function tryKakao(query, types) {
  for (const type of types) {
    try {
      const items = await searchKakao(query, type);
      if (items && items.length) {
        const top = pickBestMatch(items);
        const description = stripHtml(top.contents) || stripHtml(top.title);
        if (description) {
          return { description, source: { label: KAKAO_SOURCE_LABEL[type], url: top.url } };
        }
      }
    } catch (e) {
      console.error(`Kakao ${type} search failed:`, e.message);
    }
  }
  return null;
}

// Looks up a term the user searched that isn't in our own database. Order matters here, all in
// service of accuracy over just "found something":
//   1. Wikipedia — settled, encyclopedia-style terms, most reliably on-definition.
//   2. Kakao blog/web search for "<term> 뜻" — appending "뜻" ("meaning") is a well-known trick for
//      Korean search: it strongly biases results toward glossary-style posts written specifically
//      to explain a term, instead of any post that happens to use the word.
//   3. Kakao blog/web/cafe search for the bare term, as a last resort — less precise, but still
//      better than nothing for very fresh jargon that hasn't been written up as a "뜻" post yet.
// Returns null if nothing was found anywhere (caller should offer to save it as a memo instead).
async function lookupTermExplanation(term) {
  const wiki = await lookupFromWikipedia(term);
  if (wiki) return wiki;

  const biased = await tryKakao(`${term} 뜻`, ["blog", "web"]);
  if (biased) return { term, ...biased };

  const bare = await tryKakao(term, ["blog", "web", "cafe"]);
  if (bare) return { term, ...bare };

  return null;
}

module.exports = { lookupTermExplanation };
