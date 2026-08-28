import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cap, formatSearchResults, htmlToText, parseSearchResults } from './parse';

// A real DuckDuckGo response, saved 2026-08-29 for the query "Tonight's match
// result". Committed rather than fetched so the suite stays offline and
// deterministic. It cannot detect DDG CHANGING their markup — see the note on
// rot at the bottom of this file.
const PAGE = readFileSync(join(__dirname, '__fixtures__/duckduckgo-search.html'), 'utf8');

describe('parseSearchResults', () => {
  const results = parseSearchResults(PAGE);

  it('finds the results', () => {
    expect(results).toHaveLength(5);
  });

  // THE REGRESSION TEST. The shipped regex returned five perfectly well-formed
  // results with an empty snippet on every one, so the assertion above passed
  // for months while the tool was handing the model bare links. Asserting that
  // each FIELD is populated is the only version of this test that fails.
  it('populates every field of every result', () => {
    for (const r of results) {
      expect(r.title, `title of ${JSON.stringify(r)}`).not.toBe('');
      expect(r.url, `url of ${r.title}`).not.toBe('');
      expect(r.snippet, `snippet of ${r.title}`).not.toBe('');
    }
  });

  it('unwraps the redirect to the real destination', () => {
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.url).not.toContain('duckduckgo.com/l/');
    }
    expect(results[0]?.url).toBe('https://www.livescore.com/en/');
  });

  it('decodes entities and strips markup from titles and snippets', () => {
    expect(results[0]?.title).toBe("LiveScore | Today's Live Football Scores, Fixtures & Results");
    for (const r of results) {
      expect(r.title + r.snippet).not.toMatch(/<[a-z/]|&(amp|lt|gt|quot|#x27);/i);
    }
  });

  it('honours the limit and survives junk without throwing', () => {
    expect(parseSearchResults(PAGE, 2)).toHaveLength(2);
    expect(parseSearchResults('')).toEqual([]);
    expect(parseSearchResults('<html><body>no results here</body></html>')).toEqual([]);
  });

  // RESULT_RE is a module-level /g regex, so lastIndex persists between calls.
  it('gives the same answer when called twice', () => {
    expect(parseSearchResults(PAGE)).toEqual(results);
  });
});

describe('formatSearchResults', () => {
  it('caps every field, not just the number of rows', () => {
    const line = formatSearchResults([
      { title: 'T'.repeat(500), url: 'https://e.com/' + 'u'.repeat(500), snippet: 'S'.repeat(500) },
    ]);
    for (const l of line.split('\n')) expect(l.length).toBeLessThanOrEqual(245);
  });

  it('says so when there is nothing', () => {
    expect(formatSearchResults([])).toBe('No results found.');
  });
});

describe('htmlToText', () => {
  it('strips tags, scripts and styles and collapses whitespace', () => {
    expect(htmlToText('<p>a</p>\n\n <b>b</b>')).toBe('a b');
    expect(htmlToText('<script>var x = 1 < 2;</script>keep')).toBe('keep');
    expect(htmlToText('<style>.a{}</style> keep')).toBe('keep');
    expect(htmlToText('&amp;&lt;&gt;&quot;&#x27;&nbsp;x')).toBe('&<>"\' x');
  });

  // The tag stripper runs on arbitrary fetched pages, so its cost has to be
  // linear in page size. `<[^>]+>` was quadratic: a run of unclosed `<` made
  // every start position scan to end-of-string. 512 KB (web_fetch's body cap)
  // of `<` took ~100 s before this fix. The assertion is deliberately loose —
  // it is catching a complexity CLASS, not benchmarking a machine.
  it('is linear on a page of unclosed tag openers', () => {
    const attack = '<'.repeat(200_000);
    const started = Date.now();
    htmlToText(attack);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('cap', () => {
  it('leaves short text alone and marks what it cuts', () => {
    expect(cap('abc', 10)).toBe('abc');
    expect(cap('abcdefghij', 5)).toBe('abcde…');
    expect(cap('abc def', 4)).toBe('abc…'); // trailing space trimmed before the marker
  });
});

// NOT COVERED HERE, on purpose: that DuckDuckGo still serves this markup. A
// fixture pins behaviour against OUR regressions and is blind to their
// redesign — the day they rename `result__snippet`, every test above keeps
// passing and the tool silently returns bare links again. Only a live request
// catches that, which cannot live in `npm run check`. See parse.live.test.ts.
