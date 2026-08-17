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

// A search result's TITLE that matches this pattern is announcing itself as an actual
// definition/glossary post ("OOO 뜻", "OOO란?", "OOO란 무엇인가", "OOO의 의미/정의") rather than just
// a post that happens to mention the term once in passing (e.g. searching "하네스" alone once
// surfaced a post titled about "AI 하네스 엔지니어링" that only used the word, never explained it).
const DEFINITIONAL_TITLE = /뜻|의미|정의|이란(?:\s|$|\?)|란\s*\?|란\s*무엇/;

function findDefinitional(items) {
  return items.find((it) => DEFINITIONAL_TITLE.test(stripHtml(it.title))) || null;
}

function toResult(top, type) {
  const description = stripHtml(top.contents) || stripHtml(top.title);
  if (!description) return null;
  return { description, source: { label: KAKAO_SOURCE_LABEL[type], url: top.url } };
}

// Strict pass: only accepts a result whose title is clearly definitional. Used for the "biased"
// queries below (query already has "뜻"/"이란" appended) — if even THAT doesn't turn up a
// definitional-titled post, the top-ranked result is probably still just an incidental mention, so
// this deliberately returns nothing rather than guessing.
async function tryKakaoStrict(query, types) {
  for (const type of types) {
    try {
      const items = await searchKakao(query, type);
      console.log(
        `[lookup-debug] strict query="${query}" type=${type} titles=${JSON.stringify(
          (items || []).map((it) => stripHtml(it.title))
        )}`
      );
      const top = items && findDefinitional(items);
      if (top) {
        const result = toResult(top, type);
        if (result) return result;
      }
    } catch (e) {
      console.error(`Kakao ${type} search failed:`, e.message);
    }
  }
  return null;
}

// Relaxed pass: falls back to the top-ranked result even without a clearly definitional title —
// used only as the very last resort, for jargon so fresh no one's written a glossary post yet.
async function tryKakaoRelaxed(query, types) {
  for (const type of types) {
    try {
      const items = await searchKakao(query, type);
      if (items && items.length) {
        const top = findDefinitional(items) || items[0];
        const result = toResult(top, type);
        if (result) return result;
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
//   2. Kakao blog/web search for "<term> 뜻" then "<term> 이란" — both are well-known Korean search
//      tricks that bias results toward glossary-style posts written to explain a term, rather than
//      any post that happens to use the word. Only accepted if a result's title actually confirms
//      it's a definition post (strict pass).
//   3. Kakao blog/web/cafe search for the bare term, as a genuine last resort — less precise, but
//      still better than nothing for very fresh jargon nobody's written a "뜻" post about yet.
// Returns null if nothing was found anywhere (caller should offer to save it as a memo instead).
async function lookupTermExplanation(term) {
  const wiki = await lookupFromWikipedia(term);
  console.log(`[lookup-debug] term="${term}" wikipedia hit=${!!wiki}`);
  if (wiki) return wiki;

  for (const suffix of [" 뜻", " 이란"]) {
    const hit = await tryKakaoStrict(`${term}${suffix}`, ["blog", "web"]);
    if (hit) return { term, ...hit };
  }

  const bare = await tryKakaoRelaxed(term, ["blog", "web", "cafe"]);
  if (bare) return { term, ...bare };

  return null;
}

module.exports = { lookupTermExplanation };
