// Calendar, reminders, and alarms — the date-and-time group.
//
// This is the group the project keeps re-shipping bugs into, so it is the
// largest. Every observed failure in `docs/agent-tool-test-sheet.md` under F2
// and F3 has a scenario here: "Friday at 1pm" landing on Monday at noon, "6pm
// today" becoming 16:00, "6pm today" becoming 6:28pm because the minute was
// copied off the wall clock, and "this week" collapsing to today→tomorrow.
//
// Every `now` is chosen so the right answer is unambiguous and the wrong one is
// obviously wrong: a weekday far enough from the target that an off-by-one
// cannot pass, a clock minute that is not zero so a copied minute shows up, and
// twice a `now` in the small hours where a `toISOString()` date would report
// yesterday for the whole of IST's first five and a half hours.
//
// August 2026, for reference: 10th Mon, 11th Tue, 12th Wed, 13th Thu, 14th Fri,
// 15th Sat, 16th Sun, 17th Mon.
import { ANSWER, PLAN, RESPOND, oneCall, scenarios } from './define';

export const CALENDAR_SCENARIOS = scenarios([
  // OBSERVED (F3): "this week" came back as Aug 2 → Aug 3. A lone "Tomorrow
  // is …" anchor was the most salient date in the note and swallowed the range,
  // so the week is now a table plus an explicit "this week means X to Y".
  // Seven days from `now`, inclusive — not Monday-to-Sunday, not today-tomorrow.
  {
    id: 'cal-list-this-week',
    title: 'This week is a seven-day range from today',
    tags: ['calendar', 'dates'],
    now: '2026-08-12T09:15',
    world: {
      calendarEvents: [
        { title: 'Intoglo tech meeting', start: '2026-08-13T16:00', durationMinutes: 60 },
        { title: 'Dentist', start: '2026-08-17T11:00', durationMinutes: 30 },
      ],
    },
    turns: [
      {
        user: "What's on my calendar this week?",
        expect: {
          calls: [
            { name: 'list_calendar_events', args: { start: '2026-08-12', end: '2026-08-18' } },
          ],
          answer: { mustContain: ['Intoglo'] },
        },
      },
    ],
    script: oneCall(
      'list_calendar_events',
      { start: '2026-08-12', end: '2026-08-18' },
      'You have the Intoglo tech meeting on Thursday at 4 pm and a dentist appointment on Monday at 11 am.',
    ),
  },

  // A single day is start === end, not a range ending tomorrow. The tool widens
  // the day itself (00:00 → 23:59), so the model must not try to help.
  {
    id: 'cal-list-tomorrow',
    title: 'Tomorrow is one day, start equal to end',
    tags: ['calendar', 'dates'],
    now: '2026-08-12T09:15',
    world: {
      calendarEvents: [{ title: 'Standup', start: '2026-08-13T09:30', durationMinutes: 15 }],
    },
    turns: [
      {
        user: 'Am I free tomorrow?',
        expect: {
          calls: [
            { name: 'list_calendar_events', args: { start: '2026-08-13', end: '2026-08-13' } },
          ],
          answer: { mustContain: ['Standup'] },
        },
      },
    ],
    script: oneCall(
      'list_calendar_events',
      { start: '2026-08-13', end: '2026-08-13' },
      'Not quite — you have Standup at 9:30 am tomorrow, and nothing after that.',
    ),
  },

  // An empty read IS the answer. The prompt says so ("No events in that range."
  // is quoted in it verbatim) because on device an empty result was treated as
  // a reason to look again, four more times.
  {
    id: 'cal-list-today-empty',
    title: 'An empty calendar is the answer, not a reason to look again',
    tags: ['calendar', 'empty'],
    now: '2026-08-12T09:15',
    world: { calendarEvents: [] },
    turns: [
      {
        user: 'Anything on my calendar today?',
        expect: {
          calls: [
            { name: 'list_calendar_events', args: { start: '2026-08-12', end: '2026-08-12' } },
          ],
          answer: {
            mustContain: ['nothing'],
            // "Nothing found" and "could not look" are different things and the
            // answer note has a whole branch about it. Nothing failed here.
            mustNotContain: ['could not', "couldn't", 'failed', 'error'],
          },
        },
      },
    ],
    script: oneCall(
      'list_calendar_events',
      { start: '2026-08-12', end: '2026-08-12' },
      'You have nothing scheduled today — the day is clear.',
    ),
  },

  // "This weekend" is the coming Saturday and Sunday, both of which are in the
  // seven-day table. Not today→Sunday, which is what a model doing its own
  // arithmetic tends to produce.
  {
    id: 'cal-list-weekend',
    title: 'This weekend is Saturday to Sunday',
    tags: ['calendar', 'dates'],
    now: '2026-08-12T09:15',
    world: {
      calendarEvents: [{ title: 'Trek to Skandagiri', start: '2026-08-15T05:00', durationMinutes: 480 }],
    },
    turns: [
      {
        user: 'What am I doing this weekend?',
        expect: {
          calls: [
            { name: 'list_calendar_events', args: { start: '2026-08-15', end: '2026-08-16' } },
          ],
          answer: { mustContain: ['Skandagiri'] },
        },
      },
    ],
    script: oneCall(
      'list_calendar_events',
      { start: '2026-08-15', end: '2026-08-16' },
      'You have the trek to Skandagiri early on Saturday. Sunday is free.',
    ),
  },

  // A weekday NAME has to resolve through the table to the next such day, not
  // to today. From Wednesday the table's "Monday" is the 17th.
  {
    id: 'cal-list-named-weekday',
    title: 'A named weekday resolves forward, off the date table',
    tags: ['calendar', 'dates'],
    now: '2026-08-12T09:15',
    world: {
      calendarEvents: [{ title: 'Dentist', start: '2026-08-17T11:00', durationMinutes: 30 }],
    },
    turns: [
      {
        user: 'What have I got on Monday?',
        expect: {
          calls: [
            { name: 'list_calendar_events', args: { start: '2026-08-17', end: '2026-08-17' } },
          ],
          answer: { mustContain: ['Dentist'] },
        },
      },
    ],
    script: oneCall(
      'list_calendar_events',
      { start: '2026-08-17', end: '2026-08-17' },
      'On Monday you have the dentist at 11 am.',
    ),
  },

  // OBSERVED (F2, test sheet row 8): "lunch with Priya on Friday at 1pm" was
  // written to Mon Aug 3 at 12:00 — wrong day AND wrong hour — back when the
  // tool took an ISO datetime. Friday is copied from the table; 1pm is 13.
  // The title assertion is the still-open half of that row: the event was
  // called "Put lunch with Priya", the imperative kept from the request.
  {
    id: 'cal-create-friday-1pm',
    title: 'Friday at 1pm lands on Friday at 13:00',
    tags: ['calendar', 'dates', 'mutating'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'Put lunch with Priya on my calendar for Friday at 1pm',
        confirmations: [true],
        expect: {
          calls: [
            {
              name: 'create_calendar_event',
              args: { title: 'Lunch with Priya', date: '2026-08-14', hour: 13, minute: 0 },
            },
          ],
          answer: { mustContain: ['Priya'] },
        },
      },
    ],
    expectWorld: {
      calendarEvents: [
        { title: 'Lunch with Priya', start: '2026-08-14T13:00', durationMinutes: 60 },
      ],
    },
    script: oneCall(
      'create_calendar_event',
      { title: 'Lunch with Priya', date: '2026-08-14', hour: 13, minute: 0 },
      'Done — lunch with Priya is on your calendar for Friday at 1 pm.',
    ),
  },

  // OBSERVED (F2, test sheet row 9): "6pm today" was proposed as 4:00 PM. And
  // separately, "8pm today" came back as 8:53 PM — the minute copied off the
  // wall clock, which is why `now` here is :40 and the expectation is :00.
  {
    id: 'cal-create-6pm-today',
    title: '6pm today is hour 18 minute 0, not 16:00 and not :40',
    tags: ['calendar', 'dates', 'mutating'],
    now: '2026-08-14T17:40',
    turns: [
      {
        user: 'Add a dentist appointment at 6pm today',
        confirmations: [true],
        expect: {
          calls: [
            {
              name: 'create_calendar_event',
              args: { date: '2026-08-14', hour: 18, minute: 0 },
            },
          ],
          answer: { mustContain: ['6'] },
        },
      },
    ],
    expectWorld: {
      calendarEvents: [
        { title: 'Dentist appointment', start: '2026-08-14T18:00', durationMinutes: 60 },
      ],
    },
    script: oneCall(
      'create_calendar_event',
      { title: 'Dentist appointment', date: '2026-08-14', hour: 18, minute: 0 },
      'Added — dentist appointment today at 6 pm.',
    ),
  },

  // The UTC trap. At 03:10 local in IST it is still the 11th in UTC, so any
  // date derived from `toISOString()` is a day behind and "today" becomes
  // yesterday for the first five and a half hours of every single day.
  {
    id: 'cal-create-small-hours',
    title: 'Today at 03:10 is still today, not yesterday in UTC',
    tags: ['calendar', 'dates', 'mutating', 'timezone'],
    now: '2026-08-12T03:10',
    turns: [
      {
        user: 'Book a call with the Intoglo team at 11am today',
        confirmations: [true],
        expect: {
          calls: [
            {
              name: 'create_calendar_event',
              args: { date: '2026-08-12', hour: 11, minute: 0 },
            },
          ],
          answer: { mustContain: ['11'] },
        },
      },
    ],
    expectWorld: {
      calendarEvents: [
        { title: 'Call with the Intoglo team', start: '2026-08-12T11:00', durationMinutes: 60 },
      ],
    },
    script: oneCall(
      'create_calendar_event',
      { title: 'Call with the Intoglo team', date: '2026-08-12', hour: 11, minute: 0 },
      'Booked — call with the Intoglo team today at 11 am.',
    ),
  },

  // duration_minutes defaults to 60, so "two hours" has to be sent explicitly.
  // Its absence is the quiet failure: the event exists, at the right time, an
  // hour too short, and nothing in the reply gives that away.
  {
    id: 'cal-create-two-hours',
    title: 'A stated duration is sent, not left at the 60-minute default',
    tags: ['calendar', 'mutating'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'Block two hours for deep work tomorrow at 9am',
        confirmations: [true],
        expect: {
          calls: [
            {
              name: 'create_calendar_event',
              args: { date: '2026-08-13', hour: 9, minute: 0, duration_minutes: 120 },
            },
          ],
          answer: { mustContain: ['two hours'] },
        },
      },
    ],
    expectWorld: {
      calendarEvents: [{ title: 'Deep work', start: '2026-08-13T09:00', durationMinutes: 120 }],
    },
    script: oneCall(
      'create_calendar_event',
      { title: 'Deep work', date: '2026-08-13', hour: 9, minute: 0, duration_minutes: 120 },
      'Blocked out two hours for deep work tomorrow from 9 am.',
    ),
  },

  // The other side of the minute rule: minute 0 is the default, but a minute
  // the user actually said must survive. A fix that hard-zeroed the minute
  // would pass every "6pm" scenario in this file and break this one.
  {
    id: 'cal-create-half-past',
    title: 'A stated minute survives; 8:30pm is 20:30',
    tags: ['calendar', 'dates', 'mutating'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'Add dinner at Toit on Saturday at 8:30pm',
        confirmations: [true],
        expect: {
          calls: [
            {
              name: 'create_calendar_event',
              args: { date: '2026-08-15', hour: 20, minute: 30, location: 'Toit' },
            },
          ],
          answer: { mustContain: ['Toit'] },
        },
      },
    ],
    expectWorld: {
      calendarEvents: [
        { title: 'Dinner', start: '2026-08-15T20:30', durationMinutes: 60, location: 'Toit' },
      ],
    },
    script: oneCall(
      'create_calendar_event',
      { title: 'Dinner', date: '2026-08-15', hour: 20, minute: 30, location: 'Toit' },
      'Dinner at Toit is on your calendar for Saturday at 8:30 pm.',
    ),
  },

  // OBSERVED (test sheet row 9): "call the plumber at 6pm today" was proposed
  // as 4:00 PM. Same bug as the calendar event, different tool — and the reply
  // to it was third person ("I reminded the user…"), which is why the answer
  // must not contain "the user".
  {
    id: 'rem-6pm-today',
    title: 'Remind me at 6pm today is 18:00 today',
    tags: ['reminder', 'dates', 'mutating'],
    now: '2026-08-14T17:40',
    turns: [
      {
        user: 'Remind me to call the plumber at 6pm today',
        confirmations: [true],
        expect: {
          calls: [
            { name: 'schedule_reminder', args: { date: '2026-08-14', hour: 18, minute: 0 } },
          ],
          answer: { mustContain: ['plumber'], mustNotContain: ['the user'] },
        },
      },
    ],
    expectWorld: {
      reminders: [{ message: 'Call the plumber', at: '2026-08-14T18:00' }],
    },
    script: oneCall(
      'schedule_reminder',
      { message: 'Call the plumber', date: '2026-08-14', hour: 18, minute: 0 },
      "I'll remind you to call the plumber at 6 pm today.",
    ),
  },

  // OBSERVED: "in an hour" at 13:09 came back as 13:09 — the model read the
  // clock and copied it. The note now carries "in an hour <time>" precomputed,
  // fenced behind "use ONLY if I say in N minutes/hours". 13:09 + 1h = 14:09,
  // and the non-zero minute is the whole point: it proves the relative branch
  // was taken rather than the on-the-hour default.
  {
    id: 'rem-in-an-hour',
    title: 'In an hour at 13:09 is 14:09, not 13:09 and not 14:00',
    tags: ['reminder', 'dates', 'mutating'],
    now: '2026-08-10T13:09',
    turns: [
      {
        user: 'Remind me to stretch in an hour',
        confirmations: [true],
        expect: {
          calls: [
            { name: 'schedule_reminder', args: { date: '2026-08-10', hour: 14, minute: 9 } },
          ],
          answer: { mustContain: ['stretch'] },
        },
      },
    ],
    expectWorld: { reminders: [{ message: 'Stretch', at: '2026-08-10T14:09' }] },
    script: oneCall(
      'schedule_reminder',
      { message: 'Stretch', date: '2026-08-10', hour: 14, minute: 9 },
      "I'll remind you to stretch at 2:09 pm.",
    ),
  },

  // OBSERVED: the relative-time anchors LEAK. With "in an hour 22:59" sitting
  // in the note, "remind me at 10pm" was scheduled for 10:59 PM. `now` is
  // 21:59 here precisely to re-create that: a leaked minute produces 22:59 and
  // a leaked "in an hour" produces 22:59 too, so only 22:00 passes.
  {
    id: 'rem-at-10pm-not-relative',
    title: 'At 10pm is 22:00 even when the relative anchor reads 22:59',
    tags: ['reminder', 'dates', 'mutating'],
    now: '2026-08-13T21:59',
    turns: [
      {
        user: 'Remind me to take my medicine at 10pm',
        confirmations: [true],
        expect: {
          calls: [
            { name: 'schedule_reminder', args: { date: '2026-08-13', hour: 22, minute: 0 } },
          ],
          answer: { mustContain: ['medicine'] },
        },
      },
    ],
    expectWorld: { reminders: [{ message: 'Take medicine', at: '2026-08-13T22:00' }] },
    script: oneCall(
      'schedule_reminder',
      { message: 'Take medicine', date: '2026-08-13', hour: 22, minute: 0 },
      "I'll remind you to take your medicine at 10 pm.",
    ),
  },

  // Relative time in the small hours, where the two bug classes meet: 00:40 +
  // 30 minutes is 01:10 on the SAME local day, but the UTC date is still the
  // 11th. A reminder scheduled a day late is silent — it just never fires.
  {
    id: 'rem-half-hour-after-midnight',
    title: 'In 30 minutes at 00:40 is 01:10 today, not tomorrow and not yesterday',
    tags: ['reminder', 'dates', 'mutating', 'timezone'],
    now: '2026-08-12T00:40',
    turns: [
      {
        user: 'Remind me in 30 minutes to check the oven',
        confirmations: [true],
        expect: {
          calls: [
            { name: 'schedule_reminder', args: { date: '2026-08-12', hour: 1, minute: 10 } },
          ],
          answer: { mustContain: ['oven'] },
        },
      },
    ],
    expectWorld: { reminders: [{ message: 'Check the oven', at: '2026-08-12T01:10' }] },
    script: oneCall(
      'schedule_reminder',
      { message: 'Check the oven', date: '2026-08-12', hour: 1, minute: 10 },
      "I'll remind you to check the oven at 1:10 am.",
    ),
  },

  // "Tomorrow at 8am" — an absolute time on a relative day. The tool throws for
  // a time already past, so an 8am reminder dated today would fail outright.
  {
    id: 'rem-tomorrow-morning',
    title: 'Tomorrow at 8am is tomorrow, at 08:00',
    tags: ['reminder', 'dates', 'mutating'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'Remind me to pay the rent tomorrow at 8am',
        confirmations: [true],
        expect: {
          calls: [
            { name: 'schedule_reminder', args: { date: '2026-08-13', hour: 8, minute: 0 } },
          ],
          answer: { mustContain: ['rent'] },
        },
      },
    ],
    expectWorld: { reminders: [{ message: 'Pay the rent', at: '2026-08-13T08:00' }] },
    script: oneCall(
      'schedule_reminder',
      { message: 'Pay the rent', date: '2026-08-13', hour: 8, minute: 0 },
      "I'll remind you to pay the rent at 8 am tomorrow.",
    ),
  },

  // The shape that has always worked — two plain integers, no date at all —
  // kept as the control. If this ever fails, the problem is the harness, not
  // the date handling.
  {
    id: 'alarm-7-tomorrow',
    title: 'Seven tomorrow morning is 7:00',
    tags: ['alarm', 'dates', 'mutating'],
    now: '2026-08-10T22:30',
    turns: [
      {
        user: 'Set an alarm for 7 tomorrow morning',
        confirmations: [true],
        expect: {
          calls: [{ name: 'set_alarm', args: { hour: 7, minute: 0 } }],
          answer: { mustContain: ['7'] },
        },
      },
    ],
    expectWorld: { alarms: [{ hour: 7, minute: 0 }] },
    script: oneCall('set_alarm', { hour: 7, minute: 0 }, 'Alarm set for 7 am.'),
  },

  // The 24-hour rule on the tool that has no date to hide behind: 6pm is 18,
  // and 6 is the answer a model that ignored the hint would give.
  {
    id: 'alarm-6pm-24h',
    title: 'An alarm for 6pm is hour 18',
    tags: ['alarm', 'dates', 'mutating'],
    now: '2026-08-10T13:09',
    turns: [
      {
        user: 'Set an alarm for 6pm so I leave on time',
        confirmations: [true],
        expect: {
          calls: [{ name: 'set_alarm', args: { hour: 18, minute: 0 } }],
          answer: { mustContain: ['6'] },
        },
      },
    ],
    expectWorld: { alarms: [{ hour: 18, minute: 0 }] },
    script: oneCall('set_alarm', { hour: 18, minute: 0 }, 'Alarm set for 6 pm.'),
  },

  // A stated minute and an optional label together, so a label that swallows
  // the minute (or a minute that ends up in the label) shows up.
  {
    id: 'alarm-quarter-past-labelled',
    title: 'A labelled alarm keeps its minute',
    tags: ['alarm', 'mutating'],
    now: '2026-08-10T22:30',
    turns: [
      {
        user: 'Set an alarm for 6:15 tomorrow morning and call it yoga',
        confirmations: [true],
        expect: {
          calls: [{ name: 'set_alarm', args: { hour: 6, minute: 15, label: 'Yoga' } }],
          answer: { mustContain: ['6:15'] },
        },
      },
    ],
    expectWorld: { alarms: [{ hour: 6, minute: 15, label: 'Yoga' }] },
    script: oneCall(
      'set_alarm',
      { hour: 6, minute: 15, label: 'Yoga' },
      'Alarm set for 6:15 am, labelled Yoga.',
    ),
  },

  // The narrated-instead-of-acted regression, which is what the grammar is for.
  // A promise is not a call: this asserts the tool ran, and that the reply is
  // in the past tense rather than "I will set an alarm for 5".
  {
    id: 'alarm-promise-is-not-an-action',
    title: 'A request to act produces a call, not a promise to act',
    tags: ['alarm', 'mutating', 'grammar'],
    now: '2026-08-10T22:30',
    turns: [
      {
        user: 'I need to be up at 5 tomorrow, sort it out',
        confirmations: [true],
        expect: {
          calls: [{ name: 'set_alarm', args: { hour: 5, minute: 0 } }],
          answer: { mustNotContain: ['I will set', "I'll set", 'let me set'] },
        },
      },
    ],
    expectWorld: { alarms: [{ hour: 5, minute: 0 }] },
    script: oneCall('set_alarm', { hour: 5, minute: 0 }, "Done — your alarm is set for 5 am."),
  },

  // No tool deletes or edits anything, and there is a prompt rule about it
  // because the model reached for the OPPOSITE tool: "delete my 9am meeting"
  // proposed CREATING a "9am meeting" (F8). Live-only — the whole question is
  // what a real planner does when nothing fits, and a script would only be
  // asserting my own answer back to me.
  {
    id: 'cal-no-delete-tool',
    title: 'No delete tool exists, so say so — never create instead',
    tags: ['calendar', 'no-tool', 'live-only'],
    now: '2026-08-12T09:15',
    world: {
      calendarEvents: [{ title: 'Standup', start: '2026-08-13T09:00', durationMinutes: 30 }],
    },
    turns: [
      {
        user: 'Delete my 9am meeting tomorrow',
        expect: {
          calls: [],
          answer: {
            mustContain: ["can't"],
            mustNotContain: ['created', 'added', 'scheduled', 'deleted', 'removed'],
          },
        },
      },
    ],
    // The event must still be there, and no new one may appear beside it.
    expectWorld: {
      calendarEvents: [{ title: 'Standup', start: '2026-08-13T09:00', durationMinutes: 30 }],
    },
  },

  // The platform filter drops set_alarm on iOS, and an unavailable tool must be
  // reported rather than substituted — a reminder is not an alarm. `tools`
  // restricts the registry, which is also how Phase 1's selective disclosure
  // will be measured.
  {
    id: 'alarm-not-registered',
    title: 'With no alarm tool registered, say so rather than substituting one',
    tags: ['alarm', 'no-tool', 'tool-set'],
    now: '2026-08-10T22:30',
    tools: ['schedule_reminder', 'list_calendar_events', 'create_calendar_event', 'get_battery'],
    turns: [
      {
        user: 'Set an alarm for 7 tomorrow morning',
        expect: {
          calls: [],
          answer: { mustNotContain: ['alarm is set', 'I set the alarm'] },
        },
      },
    ],
    expectWorld: { alarms: [], reminders: [] },
    script: [
      { when: ANSWER, text: "I can't set alarms on this phone — I don't have a clock tool. I can schedule a reminder instead if that helps." },
      { when: PLAN, text: RESPOND },
    ],
  },
]);
