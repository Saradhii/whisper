// Chains, and the suppression that stops a chain being an accident.
//
// Two opposite failures live in this file. One is a planner that stops too
// early, or never chains at all — "text Arun" needs the number first, and the
// stop-after-one lesson everywhere else in the prompt must not overfit into
// never calling a second tool. The other is a planner that cannot stop:
// OBSERVED on device, five identical `list_calendar_events` calls in one turn,
// and a `set_alarm` re-emitted after it had already succeeded, which left the
// phone with two 7:00 alarms because that tool genuinely fires every time.
//
// The suppression scenarios script a NAIVE planner deliberately: the decision
// the model actually made on a phone, made again. What is asserted is that the
// harness absorbs it — the world has one alarm, not two.
import { ANSWER, PLAN, call, chain, repeatCall, scenarios } from './define';

const ARUN = { name: 'Arun Menon', phone: '+91 98450 12345', email: 'arun@example.com' };
const PRIYA = { name: 'Priya Raghavan', phone: '+91 98860 55512', email: 'priya@example.com' };

/** The three drifting calendar ranges of `cap-calendar-ranges`, named because
 *  each one keys the next entry in that scenario's script. */
const RANGE_A = call('list_calendar_events', { start: '2026-08-12', end: '2026-08-18' });
const RANGE_B = call('list_calendar_events', { start: '2026-08-12', end: '2026-08-19' });
const RANGE_C = call('list_calendar_events', { start: '2026-08-13', end: '2026-08-19' });

export const MULTISTEP_SCENARIOS = scenarios([
  // Test sheet row 11, and the worked example the prompt carries for exactly
  // this case. The second call is right because it does something DIFFERENT
  // and necessary — and the number in it has to come from the lookup, not from
  // the model.
  {
    id: 'multi-contact-then-sms',
    title: 'Look the contact up, then text the number it returned',
    tags: ['multistep', 'contacts', 'mutating'],
    now: '2026-08-12T09:15',
    world: { contacts: [ARUN, PRIYA] },
    turns: [
      {
        user: "Text Arun that I'm running ten minutes late",
        expect: {
          calls: [
            { name: 'search_contacts', args: { query: 'Arun' } },
            { name: 'compose_sms', args: { phone: '+91 98450 12345' } },
          ],
          answer: { mustNotContain: ['I sent', 'message sent'] },
        },
      },
    ],
    script: chain(
      [
        { tool: 'search_contacts', args: { query: 'Arun' } },
        {
          tool: 'compose_sms',
          args: { phone: '+91 98450 12345', message: 'Running ten minutes late.' },
        },
      ],
      "I've opened a message to Arun saying you're running ten minutes late — press send when you're ready.",
    ),
  },

  // The same chain into a different second tool, because the failure mode is
  // per-pair: a planner that has learned contacts→sms can still answer "call
  // Arun" with the number read out loud and no dialer.
  {
    id: 'multi-contact-then-dial',
    title: 'Call a contact by name: look up, then dial',
    tags: ['multistep', 'contacts', 'mutating'],
    now: '2026-08-12T09:15',
    world: { contacts: [ARUN, PRIYA] },
    turns: [
      {
        user: 'Call Arun',
        expect: {
          calls: [
            { name: 'search_contacts', args: { query: 'Arun' } },
            { name: 'dial_number', args: { phone: '+91 98450 12345' } },
          ],
          answer: { mustContain: ['Arun'] },
        },
      },
    ],
    script: chain(
      [
        { tool: 'search_contacts', args: { query: 'Arun' } },
        { tool: 'dial_number', args: { phone: '+91 98450 12345' } },
      ],
      "Dialer's open with Arun's number — press call when you're ready.",
    ),
  },

  // A chain where the second tool needs the FIRST field of the result rather
  // than the second: the same contact row carries a phone and an email, and
  // picking the wrong one sends the deck to a phone number.
  {
    id: 'multi-contact-then-email',
    title: 'Email a contact by name uses the email, not the phone number',
    tags: ['multistep', 'contacts', 'mutating'],
    now: '2026-08-12T09:15',
    world: { contacts: [ARUN, PRIYA] },
    turns: [
      {
        user: 'Email Priya and tell her the deck is ready',
        expect: {
          calls: [
            { name: 'search_contacts', args: { query: 'Priya' } },
            { name: 'compose_email', args: { to: 'priya@example.com' } },
          ],
          answer: { mustNotContain: ['98860'] },
        },
      },
    ],
    script: chain(
      [
        { tool: 'search_contacts', args: { query: 'Priya' } },
        {
          tool: 'compose_email',
          args: {
            to: 'priya@example.com',
            subject: 'Deck ready',
            body: 'The deck is ready.',
          },
        },
      ],
      "Draft's open to Priya saying the deck is ready — send it when you like.",
    ),
  },

  // Two device tools in one turn, neither of which needs the other's result.
  // Phase 3 wants these running in parallel; today they are sequential and the
  // only requirement is that BOTH happen. A turn that reads the battery and
  // then forgets the second half of the request is the common failure.
  {
    id: 'multi-battery-then-dim',
    title: 'Two independent requests in one turn both happen',
    tags: ['multistep', 'device', 'mutating'],
    now: '2026-08-12T22:05',
    world: { battery: { level: 0.18, charging: false }, brightness: 0.8 },
    turns: [
      {
        user: 'How much battery is left, and drop the brightness to 20 percent',
        expect: {
          calls: [
            { name: 'get_battery', args: {} },
            { name: 'set_brightness', args: { level: 0.2 } },
          ],
          answer: { mustContain: ['18'] },
        },
      },
    ],
    expectWorld: { battery: { level: 0.18, charging: false }, brightness: 0.2 },
    script: chain(
      [{ tool: 'get_battery' }, { tool: 'set_brightness', args: { level: 0.2 } }],
      "You're down to 18%, and I've dropped the brightness to 20%.",
    ),
  },

  // OBSERVED: five identical calendar reads in one turn. The context after the
  // first one still looks exactly like a request to read the calendar, so the
  // planner decides it again — this scripts precisely that. The repeat must
  // never reach the tool, and the turn must still end with a real answer
  // rather than four wasted generations.
  {
    id: 'repeat-calendar-read',
    title: 'A repeated calendar read is suppressed, and the turn still answers',
    tags: ['multistep', 'suppression', 'calendar'],
    now: '2026-08-12T09:15',
    world: {
      calendarEvents: [
        { title: 'Intoglo tech meeting', start: '2026-08-13T16:00', durationMinutes: 60 },
      ],
    },
    turns: [
      {
        user: "What's on my calendar this week?",
        expect: {
          calls: [
            { name: 'list_calendar_events', args: { start: '2026-08-12', end: '2026-08-18' } },
          ],
          // Whether a suppressed decision is logged as a call is the runner's
          // business; that it never reached the tool is what matters.
          allowExtraCalls: true,
          answer: { mustContain: ['Intoglo'] },
        },
      },
    ],
    script: repeatCall(
      'list_calendar_events',
      { start: '2026-08-12', end: '2026-08-18' },
      'You have the Intoglo tech meeting on Thursday at 4 pm, and nothing else this week.',
    ),
  },

  // The same suppression on a tool where a repeat is not merely noisy.
  // OBSERVED: the planner re-emitted `set_alarm` after it had succeeded and the
  // phone ended up with two 7:00 alarms. The world is the assertion — one alarm
  // — because that is the thing the user has to go and delete.
  {
    id: 'repeat-alarm-set-once',
    title: 'A re-emitted set_alarm does not set a second alarm',
    tags: ['multistep', 'suppression', 'alarm', 'mutating'],
    now: '2026-08-10T22:30',
    turns: [
      {
        user: 'Set an alarm for 7 tomorrow morning',
        // One card. A second card means the repeat reached the tool.
        confirmations: [true],
        expect: {
          calls: [{ name: 'set_alarm', args: { hour: 7, minute: 0 } }],
          allowExtraCalls: true,
          answer: { mustNotContain: ['two alarms', 'both alarms'] },
        },
      },
    ],
    expectWorld: { alarms: [{ hour: 7, minute: 0 }] },
    script: repeatCall('set_alarm', { hour: 7, minute: 0 }, 'Alarm set for 7 am tomorrow.'),
  },

  // Exact-repeat suppression only catches an EXACT repeat. Arguments that
  // differ by a day slip past it, which is why there is a per-tool call cap as
  // well — three drifting calendar ranges would otherwise burn all four
  // planning steps and leave no room for the answer. The third call is capped
  // before it runs, so the loop never asks for a `{"respond": true}` here.
  {
    id: 'cap-calendar-ranges',
    title: 'A tool called with drifting arguments is capped at two calls',
    tags: ['multistep', 'suppression', 'calendar'],
    now: '2026-08-12T09:15',
    world: {
      calendarEvents: [
        { title: 'Intoglo tech meeting', start: '2026-08-13T16:00', durationMinutes: 60 },
      ],
    },
    turns: [
      {
        user: "What's on my calendar this week?",
        expect: {
          calls: [
            { name: 'list_calendar_events', args: { start: '2026-08-12', end: '2026-08-18' } },
            { name: 'list_calendar_events', args: { start: '2026-08-12', end: '2026-08-19' } },
          ],
          allowExtraCalls: true,
          answer: { mustContain: ['Intoglo'] },
        },
      },
    ],
    script: [
      { when: ANSWER, text: 'The Intoglo tech meeting on Thursday at 4 pm — that is all this week.' },
      { when: RANGE_B, text: RANGE_C },
      { when: RANGE_A, text: RANGE_B },
      { when: PLAN, text: RANGE_A },
    ],
  },
]);
