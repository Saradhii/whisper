// Turns that need NO tool at all.
//
// This group is large on purpose. The system prompt's own claim is that "MOST
// turns need no tool", the worked examples carry three no-tool cases against
// six tool ones because the balance itself teaches, and the single worst
// regression this app has shipped on a conversational turn was answering
// "Thanks that is all for now" with a web search for "current time" — lifted
// out of the reference block in the planning note, because the note had become
// the longest and most recent user message in the window.
//
// Every scenario here asserts `calls: []`. One tool call is a failure, whatever
// the answer says. A handful are live-only: where the entire question is what a
// real planner decides, a script would only assert my own answer back at me.
import { ANSWER, PLAN, RESPOND, call, noTool, scenarios } from './define';

export const CONVERSATION_SCENARIOS = scenarios([
  // OBSERVED (N2/F4): this exact sentence produced a `web_fetch` on
  // example.com, copied out of a worked example's result. Then, later, a
  // `web_search` for "current time", copied out of the planning note. It is the
  // canary for anything that forces a tool where the planner chose not to.
  {
    id: 'chat-thats-all',
    title: "Thanks, that is all for now — no tool, ever",
    tags: ['no-tool'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'Thanks, that is all for now',
        expect: {
          calls: [],
          answer: { mustNotContain: ['searched', 'looked up', 'I found'] },
        },
      },
    ],
    script: noTool("Any time — I'm here when you need me."),
  },

  // A greeting is a greeting. The date table sitting in the note makes "today"
  // salient, and a planner that reads the note as the request answers it.
  {
    id: 'chat-greeting',
    title: 'A greeting is answered, not acted on',
    tags: ['no-tool'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'Morning! How are you doing today?',
        expect: { calls: [], answer: { mustNotContain: ['calendar', 'battery'] } },
      },
    ],
    script: noTool("Morning! I'm good — what can I do for you?"),
  },

  {
    id: 'chat-praise',
    title: 'Praise is small talk',
    tags: ['no-tool'],
    now: '2026-08-12T09:15',
    turns: [{ user: 'Thanks, that was perfect', expect: { calls: [] } }],
    script: noTool('Glad it helped.'),
  },

  // A bare acknowledgement is the shortest possible turn and has no request in
  // it at all. `planNote` repeats the user's words last, so what the planner
  // sees just before deciding is the word "ok" — and the reference block above
  // it is far longer.
  {
    id: 'chat-acknowledgement',
    title: 'A bare ok needs nothing done',
    tags: ['no-tool'],
    now: '2026-08-12T09:15',
    turns: [{ user: 'ok', expect: { calls: [] } }],
    script: noTool('Right — let me know if you need anything else.'),
  },

  {
    id: 'chat-goodnight',
    title: 'Goodnight is not a request to set an alarm',
    tags: ['no-tool'],
    now: '2026-08-12T23:10',
    turns: [
      {
        user: 'Alright, goodnight',
        expect: { calls: [], answer: { mustNotContain: ['alarm', 'reminder'] } },
      },
    ],
    expectWorld: { alarms: [], reminders: [] },
    script: noTool('Goodnight — sleep well.'),
  },

  // Something the model plainly knows. OBSERVED (N1/F6): it searched the web
  // and then described the search instead of answering.
  {
    id: 'chat-known-fact',
    title: 'A fact the model knows needs no web search',
    tags: ['no-tool'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: "What's the capital of France?",
        expect: { calls: [], answer: { mustContain: ['Paris'] } },
      },
    ],
    script: noTool('Paris.'),
  },

  {
    id: 'chat-how-long-eggs',
    title: 'General knowledge is answered from the model, not the web',
    tags: ['no-tool'],
    now: '2026-08-12T18:30',
    turns: [
      {
        user: 'How long should I boil eggs for a soft yolk?',
        expect: { calls: [], answer: { mustNotContain: ['I searched', 'according to'] } },
      },
    ],
    script: noTool('About six minutes in already-boiling water, then straight into cold water.'),
  },

  // The clock is in the planning note as reference material, so the answer
  // turn has it too. There is no time tool, and reaching for `web_search` here
  // is the observed failure in its purest form.
  {
    id: 'chat-what-time',
    title: 'The time comes from the note, not from a search',
    tags: ['no-tool'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'What time is it?',
        expect: { calls: [], answer: { mustContain: ['9:15'] } },
      },
    ],
    script: noTool("It's 9:15 in the morning."),
  },

  // A question ABOUT the tools is not a reason to run one. The catalog is in
  // the system prompt; describing it needs no call.
  {
    id: 'chat-capabilities',
    title: 'Describing what it can do does not require doing any of it',
    tags: ['no-tool'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'What can you actually do on my phone?',
        expect: { calls: [] },
      },
    ],
    script: noTool(
      'I can set alarms and reminders, read and add calendar events, look things up in your contacts, search the web, and a few phone things like battery and clipboard.',
    ),
  },

  // The follow-up turn, which is where the old recover phase did its damage:
  // an action had just happened, the history was full of it, and the next
  // conversational turn was read as a request to act again. The alarm count
  // after both turns is the assertion — one, not two.
  {
    id: 'chat-followup-after-action',
    title: 'A thank-you after an action does not repeat the action',
    tags: ['no-tool', 'multi-turn'],
    now: '2026-08-10T22:30',
    turns: [
      {
        user: 'Set an alarm for 7 tomorrow morning',
        confirmations: [true],
        expect: {
          calls: [{ name: 'set_alarm', args: { hour: 7, minute: 0 } }],
        },
      },
      {
        user: 'Perfect, thanks — that is all for now',
        expect: {
          calls: [],
          answer: { mustNotContain: ['I set another', 'alarm has been set again'] },
        },
      },
    ],
    expectWorld: { alarms: [{ hour: 7, minute: 0 }] },
    // Hand-written rather than composed, because the two turns share every
    // matcher except the second turn's own words. Most specific first: turn 2
    // is keyed on text that cannot appear anywhere in turn 1.
    script: [
      {
        when: 'that is all for now[\\s\\S]*Now reply to me directly',
        regex: true,
        text: "Any time — shout if you need anything else.",
      },
      { when: 'that is all for now', text: RESPOND },
      { when: ANSWER, text: 'Alarm set for 7 am tomorrow.' },
      { when: 'You have already called set_alarm', text: RESPOND },
      { when: PLAN, text: call('set_alarm', { hour: 7, minute: 0 }) },
    ],
  },

  // Live-only: an opinion has no correct tool call and no correct wording, so
  // the only thing worth measuring is whether a real planner reaches for the
  // web. Scripting it would assert nothing.
  {
    id: 'chat-opinion',
    title: 'An opinion question is answered, not researched',
    tags: ['no-tool', 'live-only'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'Do you think I should learn Kannada or Hindi first?',
        expect: { calls: [] },
      },
    ],
  },

  // Live-only, and the original N1 row from the device pass: "What is a good
  // stretch for lower back pain" was answered with a web search and then a
  // description of that search. The fix was prompt-side, so only a real model
  // can show whether it held.
  {
    id: 'chat-stretch-advice',
    title: 'Advice the model knows is given directly',
    tags: ['no-tool', 'live-only'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'What is a good stretch for lower back pain?',
        expect: {
          calls: [],
          answer: { mustNotContain: ['I searched', 'several resources'] },
        },
      },
    ],
  },
]);
