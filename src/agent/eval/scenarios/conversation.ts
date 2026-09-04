// Turns that need NO tool at all.
//
// This group is large on purpose. The system prompt's own claim is that "MOST
// turns need no tool", the worked examples carry four no-tool cases against
// six tool ones because the balance itself teaches, and the single worst
// regression this app has shipped on a conversational turn was answering
// "Thanks that is all for now" with a web search for "current time" — lifted
// out of the reference block in the planning note, because the note had become
// the longest and most recent user message in the window.
//
// Every scenario here asserts `calls: []`. One tool call is a failure, whatever
// the answer says. A handful are live-only: where the entire question is what a
// real planner decides, a script would only assert my own answer back at me.
//
// A `noTool()` script emits {"respond": true} however the prompt reads, so those
// scenarios pin the LOOP (nothing forces a tool where the planner chose none)
// and nothing about the prompt. That gap shipped: on the emulator "what is the
// capital of France" drew a `web_search` on one turn and a `search_contacts` on
// the next, while `chat-known-fact` — that same question, `calls: []` — scored
// green. The scenarios tagged `guarded` use `noToolUnlessTaught()` instead, so
// each one goes red when the specific rule, tool description, or worked example
// it quotes leaves the prompt.
import { ANSWER, PLAN, RESPOND, call, noTool, noToolUnlessTaught, scenarios } from './define';

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

  // OBSERVED on the emulator, 2026-09-05, the same question asked twice in one
  // session: `web_search("capital of France")` the first time and
  // `search_contacts("capital of France")` the second — a pointless scan of the
  // address book, in an app whose pitch is privacy — and then the answer given
  // from the model's own knowledge both times. Right by luck, twice, at the
  // price of an extra plan/execute/prefill cycle each.
  //
  // Guarded on the search_contacts description, because that is the half of the
  // fix aimed at the contacts branch: the old description's only discriminator
  // was "by name", and three tools in the catalog open with "Search".
  {
    id: 'chat-known-fact',
    title: 'A fact the model knows needs no tool — not even the address book',
    tags: ['no-tool', 'guarded'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: "What's the capital of France?",
        expect: { calls: [], answer: { mustContain: ['Paris'] } },
      },
    ],
    script: noToolUnlessTaught(
      'never for a topic, a place, or a fact',
      call('search_contacts', { query: 'capital of France' }),
      'Paris.',
    ),
  },

  // The class the three original no-tool worked examples missed: not small talk
  // and not advice, just a bare factual question, which is the shape that reads
  // as "go and look it up". Guarded on the worked example added for it — the
  // teaching this codebase's own evidence says moves a 1.7B model furthest, and
  // the first thing a token-trimming pass would delete.
  {
    id: 'chat-continents',
    title: 'General knowledge is answered, never searched',
    tags: ['no-tool', 'guarded'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'How many continents are there?',
        expect: { calls: [], answer: { mustContain: ['seven'] } },
      },
    ],
    script: noToolUnlessTaught(
      'No tool needed — a fact you already know',
      call('web_search', { query: 'how many continents are there' }),
      'Seven.',
    ),
  },

  // Arithmetic small enough to do in the model's head. It carries digits, so
  // `skipsPlanning()` refuses it and it goes through the planner exactly as a
  // request for an alarm would — which is the point: this is the planner's
  // decision, not the fast path's.
  {
    id: 'chat-arithmetic',
    title: 'Arithmetic the model can do itself is not a lookup',
    tags: ['no-tool', 'guarded'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: "What's 15 percent of 240?",
        expect: { calls: [], answer: { mustContain: ['36'] } },
      },
    ],
    script: noToolUnlessTaught(
      'for a fact you already',
      call('web_search', { query: '15 percent of 240' }),
      "That's 36.",
    ),
  },

  // Guarded on the web_search description, the other half of the tool-catalog
  // fix. "Search the web" said what the tool does and nothing about when it is
  // the right call, so it was chosen for questions already answerable.
  {
    id: 'chat-word-meaning',
    title: 'A word the model knows is not a web search',
    tags: ['no-tool', 'guarded'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'What does ephemeral mean?',
        expect: {
          calls: [],
          answer: { mustNotContain: ['I searched', 'looked it up'] },
        },
      },
    ],
    script: noToolUnlessTaught(
      'facts you do NOT already know',
      call('web_search', { query: 'ephemeral definition' }),
      'Short-lived — it lasts only a little while.',
    ),
  },

  // The replayable half of `chat-opinion` below, guarded on the headline rule
  // itself. An opinion has no correct wording, so only the tool count is
  // asserted here; the wording stays a live-only question.
  {
    id: 'chat-opinion-preference',
    title: 'A preference question is answered, not researched',
    tags: ['no-tool', 'guarded'],
    now: '2026-08-12T09:15',
    turns: [
      {
        user: 'Which is nicer to walk in, morning or evening?',
        expect: { calls: [] },
      },
    ],
    script: noToolUnlessTaught(
      'MOST turns need no tool at all',
      call('web_search', { query: 'best time of day to walk' }),
      'Early morning, if you can manage it — cooler air and quieter streets.',
    ),
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
