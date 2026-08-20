// Web and the two "open something" tools.
//
// Free-text queries are deliberately NOT asserted: there is no single correct
// wording for a search, and pinning one would score paraphrase as failure. What
// is asserted is the tool, the URL when the user supplied one, and — the point
// of half this file — that nothing ELSE ran. Every over-eager second tool in
// the device pass (F5) was a web tool: `web_fetch` after `open_url`,
// `web_search` after a failed `get_location`, `web_search` for something the
// model already knew.
import { chain, oneCall, scenarios } from './define';

export const WEB_SCENARIOS = scenarios([
  // Something only the web can answer, so a tool is right here. The reply must
  // be the FACT, not a description of the search — OBSERVED (F6): "I searched
  // for stretches and found several resources, including articles."
  {
    id: 'web-search-fact',
    title: 'A web search is answered with the fact, not with the search',
    tags: ['web'],
    now: '2026-08-12T09:15',
    world: {
      webResults: {
        'nandi hills': '- Nandi Hills timings — the gate is open 6:00 AM to 10:00 PM daily.',
      },
    },
    turns: [
      {
        user: 'How late is the Nandi Hills gate open?',
        expect: {
          calls: [{ name: 'web_search', args: {} }],
          answer: {
            mustContain: ['10'],
            mustNotContain: ['I searched', 'found several', 'here are some results'],
          },
        },
      },
    ],
    script: oneCall(
      'web_search',
      { query: 'Nandi Hills gate closing time' },
      'The gate is open from 6 am to 10 pm daily.',
    ),
  },

  // The pair to `fail-web-search` in failure.ts, and the reason both exist: a
  // search that RAN and found nothing must not sound like a search that could
  // not run. Same user request, same tool, different world, different answer.
  {
    id: 'web-search-no-results',
    title: 'No results is an answer, and is distinguishable from a failed search',
    tags: ['web', 'empty'],
    now: '2026-08-12T09:15',
    world: { webResults: {} },
    turns: [
      {
        user: 'Search for the opening hours of the Kaikondrahalli lake library',
        expect: {
          calls: [{ name: 'web_search', args: {} }],
          answer: {
            mustContain: ['find'],
            mustNotContain: ['could not search', 'failed', 'went wrong'],
          },
        },
      },
    ],
    script: oneCall(
      'web_search',
      { query: 'Kaikondrahalli lake library opening hours' },
      "I couldn't find anything about that — the search came back empty.",
    ),
  },

  // Test sheet row 14. A URL in the request is fetched as given: no rewriting,
  // no searching for it first.
  {
    id: 'web-fetch-given-url',
    title: 'A URL the user supplied is fetched verbatim',
    tags: ['web'],
    now: '2026-08-12T09:15',
    world: {
      webPages: {
        'https://example.org/notes': 'Release notes: the 2.4 build fixes the alarm duplication bug.',
      },
    },
    turns: [
      {
        user: 'Read me what it says at https://example.org/notes',
        expect: {
          calls: [{ name: 'web_fetch', args: { url: 'https://example.org/notes' } }],
          answer: { mustContain: ['2.4'] },
        },
      },
    ],
    script: oneCall(
      'web_fetch',
      { url: 'https://example.org/notes' },
      'It says the 2.4 build fixes the alarm duplication bug.',
    ),
  },

  // Test sheet row 5, plus F5. `httpUrl` refuses anything without a scheme, so
  // "anthropic.com" has to become "https://anthropic.com" — and then the turn
  // has to STOP. Opening a page and then fetching it is two tools for one job,
  // and it was observed.
  {
    id: 'web-open-url',
    title: 'Opening a page adds the scheme and does not then fetch it',
    tags: ['web', 'mutating'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'Open anthropic.com in the browser',
        expect: {
          calls: [{ name: 'open_url', args: { url: 'https://anthropic.com' } }],
          // No `allowExtraCalls`: a trailing web_fetch fails this scenario.
          answer: { mustContain: ['anthropic.com'] },
        },
      },
    ],
    script: oneCall('open_url', { url: 'https://anthropic.com' }, "I've opened anthropic.com in your browser."),
  },

  // Test sheet row 6. A place name goes to maps, not to a web search — the
  // user asked to be shown it, not told about it.
  {
    id: 'web-maps-place',
    title: 'Show me X on the map opens maps, not a search',
    tags: ['web', 'mutating'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'Show me Cubbon Park on the map',
        expect: {
          calls: [{ name: 'open_maps', args: { query: 'Cubbon Park' } }],
          answer: { mustContain: ['Cubbon Park'] },
        },
      },
    ],
    script: oneCall('open_maps', { query: 'Cubbon Park' }, "I've opened Cubbon Park in maps."),
  },

  // "Nearest" needs no location call first: maps resolves it from the device's
  // own position. A get_location beforehand is the F5 pattern again, and it is
  // the one that then fails on a phone with no fix and derails the whole turn.
  {
    id: 'web-maps-nearest',
    title: 'Nearest X is a maps query, not a location lookup first',
    tags: ['web', 'mutating'],
    now: '2026-08-12T19:20',
    world: { location: { latitude: 12.9784, longitude: 77.5946 } },
    turns: [
      {
        user: 'Take me to the nearest petrol pump',
        expect: {
          calls: [{ name: 'open_maps', args: {} }],
          answer: { mustContain: ['maps'] },
        },
      },
    ],
    script: oneCall('open_maps', { query: 'petrol pump near me' }, "I've opened maps with petrol pumps near you."),
  },

  // The legitimate two-tool web chain, so the stop-after-one lesson does not
  // overfit into never chaining: search, then read the page the search found.
  // The URL passed to `web_fetch` must come from the RESULT, not from the
  // worked examples — a literal example.com in an example result is exactly
  // what the planner copied in F4.
  {
    id: 'web-search-then-fetch',
    title: 'Search then read the result page — a chain that is allowed',
    tags: ['web', 'multistep'],
    now: '2026-08-12T09:15',
    world: {
      webResults: {
        'metro': '- Namma Metro yellow line — https://example.org/metro — timings and fares',
      },
      webPages: {
        'https://example.org/metro': 'The yellow line runs from 5:00 AM to 11:00 PM on weekdays.',
      },
    },
    turns: [
      {
        user: 'Find the metro timings page and read me the yellow line hours',
        expect: {
          calls: [
            { name: 'web_search', args: {} },
            { name: 'web_fetch', args: { url: 'https://example.org/metro' } },
          ],
          answer: { mustContain: ['11'] },
        },
      },
    ],
    script: chain(
      [
        { tool: 'web_search', args: { query: 'Namma Metro yellow line timings' } },
        { tool: 'web_fetch', args: { url: 'https://example.org/metro' } },
      ],
      'The yellow line runs from 5 am to 11 pm on weekdays.',
    ),
  },
]);
