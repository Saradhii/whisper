// Parsing for the web tools, kept free of expo/react-native imports ON PURPOSE.
//
// These functions used to live inside tools.ts. Nothing about them needs a
// device — they turn a string into another string — but tools.ts imports nine
// expo modules, and vitest.config.ts excludes anything that does. So the
// parsers inherited an exclusion they never earned, and a regex whose capture
// group could not fire shipped in every build for months without a single test
// able to observe it. The split is the fix: logic that can be tested in node
// lives where node can reach it.
//
// Rule for anything added here: it may import zod and other pure modules, and
// nothing that touches the platform. Fetching stays in tools.ts.

/** One parsed search hit. Fields are separated so a test can assert each is
 *  populated — a result list of the right LENGTH with empty snippets is
 *  exactly the bug this module exists to make visible. */
export type SearchResult = { title: string; url: string; snippet: string };

/**
 * Strip tags and entities from HTML and collapse whitespace.
 *
 * `<[^<>]*>` rather than the more obvious `<[^>]+>`: the latter is quadratic on
 * hostile input. Given a run of unclosed `<`, `[^>]+` consumes to end-of-string
 * from EVERY starting `<` before failing, so an attacker-supplied page of `<`
 * characters costs O(n²) — measured at 100 ms for 16 KB, which extrapolates to
 * roughly 100 seconds at web_fetch's 512 KB body cap, all of it on the JS
 * thread. Excluding `<` from the class bounds each attempt at the next `<`,
 * which makes the whole scan linear. Nothing is lost: a tag cannot contain `<`.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bound one field of a tool result. Row counts alone don't bound anything when
 *  the rows themselves are unbounded. */
export function cap(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}…`;
}

/** DuckDuckGo wraps every outbound link in a redirect; recover the real target. */
function unwrap(href: string): string {
  const uddg = /uddg=([^&]+)/.exec(href);
  if (!uddg?.[1]) return href;
  try {
    return decodeURIComponent(uddg[1]);
  } catch {
    return href; // malformed percent-escape — the redirect URL is still better than nothing
  }
}

// One result spans from its title anchor up to the next one. Bounding the span
// FIRST and searching inside it second is what makes the snippet reachable.
//
// The previous single-regex version ended with `[\s\S]*?(?:…snippet…)?` — a
// lazy quantifier followed by an OPTIONAL group. Lazy means "match as few
// characters as possible"; optional means "zero occurrences already satisfies
// me". The engine satisfies both at once by matching nothing, so the snippet
// group could never capture, on any input. The page was never the problem: it
// carries ten well-formed snippet blocks. Note this is invisible to
// eslint-plugin-regexp even with every rule enabled — the regex is
// syntactically fine, and only its RESULT is wrong. A test is the only thing
// that catches it, which is why parseSearchResults returns fields rather than a
// pre-joined string.
const RESULT_RE =
  /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|$)/g;
const SNIPPET_RE = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

/** Parse a DuckDuckGo HTML results page. At most `limit` hits, titles required. */
export function parseSearchResults(html: string, limit = 5): SearchResult[] {
  const out: SearchResult[] = [];
  RESULT_RE.lastIndex = 0; // module-level /g regex — reset or the next call resumes mid-page
  let m: RegExpExecArray | null;
  while ((m = RESULT_RE.exec(html)) && out.length < limit) {
    const title = htmlToText(m[2] ?? '');
    if (!title) continue;
    out.push({
      title,
      url: unwrap(m[1] ?? ''),
      snippet: htmlToText(SNIPPET_RE.exec(m[3] ?? '')?.[1] ?? ''),
    });
  }
  return out;
}

/** Render parsed hits for the model. Every field is capped: five "capped"
 *  results are not bounded if a single title or snippet inside them is not. */
export function formatSearchResults(results: SearchResult[]): string {
  if (!results.length) return 'No results found.';
  return results
    .map(
      (r) =>
        `- ${cap(r.title, 120)}\n  ${cap(r.url, 160)}${r.snippet ? `\n  ${cap(r.snippet, 240)}` : ''}`,
    )
    .join('\n');
}
