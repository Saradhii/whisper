// Refusals and failures — the two branches `answerNote()` cares most about,
// and the two a device pass reproduces least reliably.
//
// A refusal outranks everything. OBSERVED (F1, the highest-severity finding in
// the device pass): the user tapped Deny on a reminder card and the reply was
// "I already scheduled the reminder for 6 pm today." Two causes, both fixed —
// the suppression message read as confirmation of success, and the note had no
// denial branch — and both are asserted here on the world as well as on the
// words, because "nothing was created" is a fact about the phone, not a phrase.
//
// Failures are the other half. OBSERVED: a calendar read that THREW was
// answered with "There are no events in your calendar this week." A failed read
// presented as an empty one is the worst possible outcome, since the user acts
// on it. Every scenario below pairs with an empty-result scenario elsewhere in
// the corpus that uses the same words for a genuinely empty result: "nothing
// found" and "could not look" must not be the same sentence.
import { ANSWER, PLAN, call, oneCall, retryCall, scenarios } from './define';

/** Repeated verbatim in `fail-retry-budget`: each script entry is consumed at
 *  most once, so two identical retries need two identical entries. */
const RETRY_SEARCH = call('web_search', { query: 'Bengaluru metro fare revision' });

export const FAILURE_SCENARIOS = scenarios([
  // The F1 case itself, on the tool it was observed on.
  {
    id: 'deny-reminder',
    title: 'A refused reminder did not happen and is not claimed',
    tags: ['refusal', 'reminder'],
    now: '2026-08-14T17:40',
    turns: [
      {
        user: 'Remind me to call the plumber at 6pm today',
        confirmations: [false],
        expect: {
          calls: [
            { name: 'schedule_reminder', args: { date: '2026-08-14', hour: 18, minute: 0 } },
          ],
          answer: {
            mustContain: ['did not'],
            mustNotContain: ["I've scheduled", 'I scheduled', 'reminder is set', 'all set'],
          },
        },
      },
    ],
    // The assertion that cannot be talked around.
    expectWorld: { reminders: [] },
    script: oneCall(
      'schedule_reminder',
      { message: 'Call the plumber', date: '2026-08-14', hour: 18, minute: 0 },
      'I did not schedule that reminder. What would you like me to do instead?',
    ),
  },

  {
    id: 'deny-calendar-event',
    title: 'A refused event is not on the calendar and is not described as created',
    tags: ['refusal', 'calendar'],
    now: '2026-08-12T09:15',
    world: {
      calendarEvents: [{ title: 'Standup', start: '2026-08-13T09:30', durationMinutes: 15 }],
    },
    turns: [
      {
        user: 'Put lunch with Priya on my calendar for Friday at 1pm',
        confirmations: [false],
        expect: {
          calls: [
            {
              name: 'create_calendar_event',
              args: { date: '2026-08-14', hour: 13, minute: 0 },
            },
          ],
          answer: {
            mustContain: ['did not'],
            mustNotContain: ['created', "I've added", 'is on your calendar'],
          },
        },
      },
    ],
    // The event that was already there must survive; the refused one must not
    // appear beside it.
    expectWorld: {
      calendarEvents: [{ title: 'Standup', start: '2026-08-13T09:30', durationMinutes: 15 }],
    },
    script: oneCall(
      'create_calendar_event',
      { title: 'Lunch with Priya', date: '2026-08-14', hour: 13, minute: 0 },
      'I did not create that event. Tell me if you want it at a different time.',
    ),
  },

  {
    id: 'deny-alarm',
    title: 'A refused alarm leaves the clock empty',
    tags: ['refusal', 'alarm'],
    now: '2026-08-10T22:30',
    turns: [
      {
        user: 'Set an alarm for 5 tomorrow morning',
        confirmations: [false],
        expect: {
          calls: [{ name: 'set_alarm', args: { hour: 5, minute: 0 } }],
          answer: {
            mustContain: ['did not'],
            mustNotContain: ['alarm is set', "I've set", 'set for 5'],
          },
        },
      },
    ],
    expectWorld: { alarms: [] },
    script: oneCall(
      'set_alarm',
      { hour: 5, minute: 0 },
      'I did not set that alarm. Want it at another time?',
    ),
  },

  // "If the user denied an action, do not attempt it again" is a prompt rule
  // because the model tried. The retry must never reach the tool — the
  // confirmation card is not a rate limiter, and a second card for an action
  // the user just refused is how a user ends up tapping Allow by reflex.
  {
    id: 'deny-then-retry-suppressed',
    title: 'A refusal stays refused when the planner tries again',
    tags: ['refusal', 'suppression', 'reminder'],
    now: '2026-08-14T17:40',
    turns: [
      {
        user: 'Remind me to call the plumber at 6pm today',
        // One card only. A second means suppression let the retry through.
        confirmations: [false],
        expect: {
          calls: [
            { name: 'schedule_reminder', args: { date: '2026-08-14', hour: 18, minute: 0 } },
          ],
          // The retry is suppressed before it reaches the tool, and whether the
          // runner logs a suppressed decision as a call is its own business.
          allowExtraCalls: true,
          answer: {
            mustContain: ['did not'],
            mustNotContain: ['I scheduled', 'reminder is set'],
          },
        },
      },
    ],
    expectWorld: { reminders: [] },
    script: retryCall(
      'schedule_reminder',
      { message: 'Call the plumber', date: '2026-08-14', hour: 18, minute: 0 },
      'I did not schedule it — you turned that one down. Happy to set it for another time.',
    ),
  },

  // OBSERVED: a calendar read that threw came back as "There are no events in
  // your calendar this week." The pair to `cal-list-today-empty`, which uses
  // the same request against a world where the read SUCCEEDS and finds nothing.
  {
    id: 'fail-calendar-permission',
    title: 'A calendar read that failed is not reported as an empty calendar',
    tags: ['failure', 'calendar'],
    now: '2026-08-12T09:15',
    world: {
      failing: { list_calendar_events: 'Permission for calendar was denied by the user.' },
    },
    turns: [
      {
        user: "What's on my calendar today?",
        expect: {
          calls: [
            { name: 'list_calendar_events', args: { start: '2026-08-12', end: '2026-08-12' } },
          ],
          answer: {
            mustContain: ['permission'],
            // The exact sentence that was shipped.
            mustNotContain: ['no events', 'nothing on', "you're free", 'you are free', 'clear'],
          },
        },
      },
    ],
    script: oneCall(
      'list_calendar_events',
      { start: '2026-08-12', end: '2026-08-12' },
      "I couldn't check your calendar — permission for calendar access was denied.",
    ),
  },

  // The pair to `web-search-no-results`. Same request, same tool; one world
  // returns nothing and the other cannot look at all.
  {
    id: 'fail-web-search',
    title: 'A search that could not run is not reported as a search that found nothing',
    tags: ['failure', 'web'],
    now: '2026-08-12T09:15',
    world: {
      failing: { web_search: 'The request timed out after 12s. The network may be slow or offline.' },
    },
    turns: [
      {
        user: 'Search for the opening hours of the Kaikondrahalli lake library',
        expect: {
          calls: [{ name: 'web_search', args: {} }],
          answer: {
            mustContain: ['network'],
            mustNotContain: ['no results', "couldn't find anything", 'nothing came up'],
          },
        },
      },
    ],
    script: oneCall(
      'web_search',
      { query: 'Kaikondrahalli lake library opening hours' },
      "That search didn't go through — the request timed out, so the network may be down.",
    ),
  },

  // Test sheet row 15: the emulator never had a GPS fix, so this path is the
  // ONLY one that tool has ever been observed on. It reported the error
  // honestly there; this pins that. It also guards the F5 residual — a failed
  // location must not turn into a web search for where the user might be.
  {
    id: 'fail-location',
    title: 'No location fix is said plainly, and not worked around with a search',
    tags: ['failure', 'device'],
    now: '2026-08-12T09:15',
    world: {
      failing: { get_location: 'Permission for location was denied by the user.' },
      location: null,
    },
    turns: [
      {
        user: 'Where am I right now?',
        expect: {
          calls: [{ name: 'get_location', args: {} }],
          answer: {
            mustContain: ['permission'],
            mustNotContain: ['you are in', "you're in", 'Bengaluru'],
          },
        },
      },
    ],
    script: oneCall(
      'get_location',
      {},
      "I couldn't get your location — permission for location access was denied.",
    ),
  },

  // The mutating failure, which is the dangerous one: nothing happened, and the
  // answer note's failure branch is the only thing standing between the user
  // and "your alarm is set for 6". The clock is empty afterwards.
  {
    id: 'fail-alarm',
    title: 'An alarm that failed to set is not announced as set',
    tags: ['failure', 'alarm'],
    now: '2026-08-10T22:30',
    world: { failing: { set_alarm: 'No app on this phone can handle SET_ALARM.' } },
    turns: [
      {
        user: 'Set an alarm for 6 tomorrow morning',
        confirmations: [true],
        expect: {
          calls: [{ name: 'set_alarm', args: { hour: 6, minute: 0 } }],
          answer: {
            mustContain: ["didn't work"],
            mustNotContain: ['alarm is set', "I've set", 'all set'],
          },
        },
      },
    ],
    // `WorldSchema.partial()` only lifts the OUTER keys — everything under them
    // keeps its default — so an `expectWorld` is a check on the WHOLE final
    // world, not just the keys written here. `failing` is world config rather
    // than state, but it is part of that world and has to be restated or the
    // check compares it against an empty map.
    expectWorld: {
      alarms: [],
      failing: { set_alarm: 'No app on this phone can handle SET_ALARM.' },
    },
    script: oneCall(
      'set_alarm',
      { hour: 6, minute: 0 },
      "That didn't work — this phone has no clock app that accepts alarms.",
    ),
  },

  {
    id: 'fail-contacts-permission',
    title: 'A contacts read that failed is not reported as no such contact',
    tags: ['failure', 'contacts'],
    now: '2026-08-12T09:15',
    world: { failing: { search_contacts: 'Permission for contacts was denied by the user.' } },
    turns: [
      {
        user: "What's Arun's phone number?",
        expect: {
          calls: [{ name: 'search_contacts', args: { query: 'Arun' } }],
          answer: {
            mustContain: ['permission'],
            // The failure this pairs with is `con-lookup-missing`, whose answer
            // is "there's no Deepa in your contacts" — right there, wrong here.
            mustNotContain: ["no Arun", "isn't in your contacts", 'no matching'],
          },
        },
      },
    ],
    script: oneCall(
      'search_contacts',
      { query: 'Arun' },
      "I couldn't look at your contacts — permission for contacts access was denied.",
    ),
  },

  {
    id: 'fail-media-permission',
    title: 'A media search that failed is not reported as an empty gallery',
    tags: ['failure', 'media'],
    now: '2026-08-12T09:15',
    world: {
      failing: { search_phone_media: 'Permission for media library was denied by the user.' },
      media: [{ filename: 'beach_sunset.png', type: 'photo', at: '2026-07-02T18:40' }],
    },
    turns: [
      {
        user: 'Find my beach photos',
        expect: {
          calls: [{ name: 'search_phone_media', args: { media_type: 'photo' } }],
          answer: {
            mustContain: ['permission'],
            mustNotContain: ['no photos', 'no matching', "couldn't find any"],
          },
        },
      },
    ],
    script: oneCall(
      'search_phone_media',
      { query: 'beach', media_type: 'photo' },
      "I couldn't search your photos — permission for the media library was denied.",
    ),
  },

  // A call that THREW is the one case repeat suppression lets through: it
  // produced no answer, and the world may have changed underneath it — the
  // permission just granted, the network coming back. It gets exactly ONE more
  // go. This pins the budget from both sides: the second attempt reaches the
  // tool, the third does not, and the turn still ends by saying it did not
  // work rather than burning MAX_STEPS in silence.
  {
    id: 'fail-retry-budget',
    title: 'A throwing call is retried once and then given up on',
    tags: ['failure', 'suppression', 'web'],
    now: '2026-08-12T09:15',
    world: {
      failing: { web_search: 'The request timed out after 12s. The network may be slow or offline.' },
    },
    turns: [
      {
        user: 'Search for the Bengaluru metro fare revision',
        expect: {
          calls: [
            { name: 'web_search', args: {} },
            { name: 'web_search', args: {} },
          ],
          // The third decision never reaches the tool.
          allowExtraCalls: true,
          answer: {
            mustContain: ['timed out'],
            mustNotContain: ['no results', 'nothing came up'],
          },
        },
      },
    ],
    // Hand-written: three planning generations, and the third is suppressed, so
    // the loop never asks for a `{"respond": true}`. Entries are consumed once
    // each, so the two identical retries need two identical entries.
    script: [
      { when: ANSWER, text: "That search timed out — the network looks to be down, so I couldn't check." },
      { when: RETRY_SEARCH, text: RETRY_SEARCH },
      { when: RETRY_SEARCH, text: RETRY_SEARCH },
      { when: PLAN, text: RETRY_SEARCH },
    ],
  },
]);
