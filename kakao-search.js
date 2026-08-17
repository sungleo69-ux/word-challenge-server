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

// Looks up a term the user searched that isn't in our own database. Tries Kakao's blog index first
// (best for fresh business/trend jargon — Korean bloggers explain new terms fast), then web
// documents, then cafe posts, then finally Wikipedia as a last resort. Returns null if nothing was
// found anywhere (caller should offer to save it as a memo instead).
async function lookupTermExplanation(term) {
  for (const type of ["blog", "web", "cafe"]) {
    try {
      const items = await searchKakao(term, type);
      if (items && items.length) {
        const top = items[0];
        const description = stripHtml(top.contents) || stripHtml(top.title);
        if (description) {
          return {
            term,
            description,
            source: { label: KAKAO_SOURCE_LABEL[type], url: top.url },
          };
        }
      }
    } catch (e) {
      console.error(`Kakao ${type} search failed:`, e.message);
    }
  }
  return await lookupFromWikipedia(term);
}

module.exports = { lookupTermExplanation };
