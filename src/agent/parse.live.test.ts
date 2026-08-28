import { describe, expect, it } from 'vitest';

import { parseSearchResults } from './parse';

/**
 * Scraper-rot canary. `npm run test:live` — not part of `npm run check`.
 *
 * parse.test.ts pins the parser against a saved page, which catches OUR
 * regressions and is blind to THEIRS. The day DuckDuckGo renames
 * `result__snippet`, every fixture test keeps passing and `web_search` quietly
 * returns bare links again — which is the exact failure this whole module was
 * written in response to, and it went unnoticed for months. Only a real request
 * can see that.
 *
 * A failure here means one of two things, and the assertions are split so the
 * output says which: the network is down (not your problem), or the markup
 * moved and the regexes in parse.ts need updating (very much your problem).
 */
describe('web_search against the live endpoint', () => {
  it('still parses a real DuckDuckGo response into populated results', async () => {
    let html: string;
    try {
      const res = await fetch('https://html.duckduckgo.com/html/?q=what+is+a+solar+eclipse', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Android 15; Mobile)' },
        signal: AbortSignal.timeout(20_000),
      });
      expect(res.ok, `DuckDuckGo returned HTTP ${res.status} — network or rate limit, not a parser bug`).toBe(true);
      html = await res.text();
    } catch (e) {
      // Reaching the endpoint is a precondition, not the thing under test.
      throw new Error(`Could not reach DuckDuckGo (${String(e)}). This is a connectivity failure, not a parser failure.`);
    }

    const results = parseSearchResults(html);

    expect(results.length, 'no results parsed at all — the result anchor markup has changed').toBeGreaterThan(0);
    for (const r of results) {
      expect(r.title, 'title markup has changed').not.toBe('');
      expect(r.url, 'result href markup has changed').toMatch(/^https?:\/\//);
    }
    // The assertion that matters. It is stated separately from title/url so a
    // failure names the snippet specifically rather than "a result was empty".
    const withSnippet = results.filter((r) => r.snippet !== '').length;
    expect(
      withSnippet,
      `${withSnippet}/${results.length} results had a snippet — if this is 0, the snippet selector in parse.ts has stopped matching and the model is being handed bare links`,
    ).toBeGreaterThan(0);
  });
});
