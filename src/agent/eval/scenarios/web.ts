// Web and the two "open something" tools.
//
// Free-text queries are deliberately NOT asserted: there is no single correct
// wording for a search, and pinning one would score paraphrase as failure. What
// is asserted is the tool, the URL when the user supplied one, and — the point
// of half this file — that nothing ELSE ran. Every over-eager second tool in
// the device pass (F5) was a web tool: `web_fetch` after `open_url`,
// `web_search` after a failed `get_location`, `web_search` for something the
// model already knew.
import { TOP_RESULT_MARK } from '@/src/agent/parse';
import { ANSWER, call, chain, oneCall, PLAN, RESPOND, scenarios } from './define';

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
        'nandi hills': '- Nandi Hills official site — https://example.org/nandi-hills',
      },
      // The snippet above no longer carries the hours; the auto-fetched page
      // does. If the auto-fetch ever stops matching tools.ts, this answer
      // becomes unwritable and the scenario goes red.
      webPages: {
        'https://example.org/nandi-hills': 'Nandi Hills gate hours: open 6:00 AM to 10:00 PM daily.',
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
            // One honest phrase is required; the corpus integrity test proves
            // the script can satisfy it. (The live planner phrased the same
            // honesty as "did not yield any results" — wording differences on
            // the real model are the live suite's concern, not this gate's.)
            mustContain: ['find'],
            mustNotContain: ['could not search', 'failed', 'went wrong', 'I searched the web'],
          },
        },
      },
    ],
    script: oneCall(
      'web_search',
      { query: 'Kaikondrahalli lake library opening hours' },
      "I couldn't find anything about that — the search yielded no results.",
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
        'metro':
          '- Namma Metro yellow line — https://example.org/metro\n' +
          '- Metro weekday timetable — https://example.org/metro-timings',
      },
      // The auto-fetched top page deliberately does NOT contain the hours —
      // the model has to fetch the second URL itself. This is the one web
      // turn where a second call is still the right move even though
      // web_search now reads the top page for you.
      webPages: {
        'https://example.org/metro':
          'The yellow line connects RV Road with Bommasandra. Fares depend on distance.',
        'https://example.org/metro-timings':
          'The yellow line runs from 5:00 AM to 11:00 PM on weekdays.',
      },
    },
    turns: [
      {
        user: 'Find the metro timings page and read me the yellow line hours',
        expect: {
          calls: [
            { name: 'web_search', args: {} },
            { name: 'web_fetch', args: { url: 'https://example.org/metro-timings' } },
          ],
          answer: { mustContain: ['11'] },
        },
      },
    ],
    script: chain(
      [
        { tool: 'web_search', args: { query: 'Namma Metro yellow line timings' } },
        { tool: 'web_fetch', args: { url: 'https://example.org/metro-timings' } },
      ],
      'The yellow line runs from 5 am to 11 pm on weekdays.',
    ),
  },

  // OBSERVED on a real phone (v1.2.0) and reproduced on the live-model
  // harness the same day: asked for tonight's match result, the planner held
  // a block of links and answered "The search results show that there is a
  // live cricket score at https://example.org/scores" — no fetch, no result.
  // The structural fix is the auto-fetch inside web_search (see tools.ts and
  // parse.ts renderSearchTurn); this scenario pins it end to end. The
  // planner's respond decision keys on the PAGE TEXT being in the transcript:
  // if the auto-fetch stops matching tools.ts, the page never lands, this
  // script can't reach its RESPOND entry, and the scenario goes red — as it
  // must, because '187/9' appears nowhere else in the world.
  {
    id: 'web-search-delivers',
    title: 'A web search answers with what the fetched page said',
    tags: ['web', 'multistep'],
    now: '2026-08-12T19:45',
    world: {
      webResults: {
        match:
          '- Live cricket score centre — https://example.org/scores\n' +
          '- Cricinfo match coverage — https://example.org/cricket',
      },
      webPages: {
        'https://example.org/scores': 'Tonight: RCB 210/4 beat MI 187/9 by 23 runs.',
        'https://example.org/cricket': 'Ball-by-ball commentary from the middle.',
      },
    },
    turns: [
      {
        user: "Search the web for tonight's match result",
        expect: {
          // ONE call: web_search reads the top page itself. A trailing
          // web_fetch here would mean the model is still doing the fetching
          // the harness was built to do for it.
          calls: [{ name: 'web_search', args: {} }],
          answer: {
            mustContain: ['23'],
            mustNotContain: ['I searched', 'https://', 'found several'],
          },
        },
      },
    ],
    script: [
      { when: ANSWER, text: 'RCB beat MI by 23 runs tonight.' },
      // The page is in the transcript (the fixture's auto-fetch put it there)
      // -> answer. If the auto-fetch regresses, this entry never fires: the
      // planner re-searches, exhausts, and the turn ends without an answer.
      { when: 'Tonight: RCB 210/4', text: RESPOND },
      // First planning step -> the search.
      { when: PLAN, text: call('web_search', { query: "tonight's match result" }) },
    ],
  },
]);
