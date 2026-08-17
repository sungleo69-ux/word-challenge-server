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

// Runs one search and picks (at most) one candidate from it. strict=true only accepts a
// definitional-titled result (used for the "뜻"/"이란"-biased queries — if even those don't turn up
// a definitional title, the top result is probably still just an incidental mention, so this
// deliberately returns nothing rather than guessing). strict=false falls back to the top-ranked
// result regardless of title — only used as the very last resort.
async function searchOneCandidate(query, types, strict) {
  for (const type of types) {
    try {
      const items = await searchKakao(query, type);
      console.log(
        `[lookup-debug] query="${query}" type=${type} strict=${strict} titles=${JSON.stringify(
          (items || []).map((it) => stripHtml(it.title))
        )}`
      );
      if (!items || !items.length) continue;
      const top = strict ? findDefinitional(items) : findDefinitional(items) || items[0];
      if (!top) continue;
      const result = toResult(top, type);
      if (result) return result;
    } catch (e) {
      console.error(`Kakao ${type} search failed:`, e.message);
    }
  }
  return null;
}

// This app is specifically about business/tech jargon (마케팅, 조직문화, IT, AI 등) — a huge share of
// common Korean words have a completely different everyday meaning vs. their tech/business meaning
// (e.g. "하네스" is normally a physical harness — pet/climbing/wiring — but in AI/tech circles means
// "the operating structure wrapped around a model"). A plain "<term> 뜻" search has no way to know
// which sense this app's audience actually wants, and can land on the wrong one entirely. Biasing
// the query toward the app's own domain fixes that: searching "<term> 뜻 IT" for "하네스" correctly
// surfaces posts titled "하네스 엔지니어링이란? — 뜻부터 실전 예시까지 완벽 정리" instead of a
// generic cable-harness Wikipedia stub or an unrelated blog post that just uses the word once.
const DOMAIN_BIASES = ["IT", "비즈니스"];

// No single automatic guess can be trusted 100% for an ambiguous word — the fix isn't to keep
// tweaking the ranking, it's to stop pretending there's one right answer and show the user a short
// list of real candidates (each with its own source) so THEY pick the one that matches what they
// actually meant. This collects up to `limit` distinct candidates (deduped by source URL) by
// running the same priority chain as before, but instead of stopping at the first hit, it keeps
// going until it's gathered enough:
//   1. Kakao blog/web for "<term> 뜻 IT" / "<term> 이란 IT", then same with "비즈니스" — biased toward
//      BOTH a definitional post (title must confirm it's a "뜻/이란" post) AND this app's own subject
//      matter, so ambiguous everyday words surface their tech/business sense first.
//   2. Same "<term> 뜻" / "<term> 이란" without the domain bias, still requiring a definitional title.
//   3. Wikipedia — settled, encyclopedia-style terms (checked after the biased passes, since it has
//      no concept of "this app's domain" and can return a real but wrong-sense article).
//   4. Kakao blog/web/cafe for the bare term, relaxed (title doesn't have to be definitional) — a
//      genuine last resort for jargon so fresh nobody's written a glossary post about it yet.
// Returns an array (possibly empty) — caller should offer "save as memo" when it's empty.
async function lookupTermCandidates(term, limit = 3) {
  const candidates = [];
  const seenUrls = new Set();

  function add(candidate) {
    if (!candidate || !candidate.source?.url || candidates.length >= limit) return;
    if (seenUrls.has(candidate.source.url)) return;
    seenUrls.add(candidate.source.url);
    candidates.push({ term, ...candidate });
  }

  for (const bias of DOMAIN_BIASES) {
    if (candidates.length >= limit) break;
    for (const suffix of [" 뜻", " 이란"]) {
      if (candidates.length >= limit) break;
      add(await searchOneCandidate(`${term}${suffix} ${bias}`, ["blog", "web"], true));
    }
  }

  if (candidates.length < limit) {
    for (const suffix of [" 뜻", " 이란"]) {
      if (candidates.length >= limit) break;
      add(await searchOneCandidate(`${term}${suffix}`, ["blog", "web"], true));
    }
  }

  if (candidates.length < limit) {
    const wiki = await lookupFromWikipedia(term);
    console.log(`[lookup-debug] term="${term}" wikipedia hit=${!!wiki}`);
    if (wiki) add({ description: wiki.description, source: wiki.source });
  }

  if (candidates.length < limit) {
    add(await searchOneCandidate(term, ["blog", "web", "cafe"], false));
  }

  return candidates;
}

module.exports = { lookupTermCandidates };
