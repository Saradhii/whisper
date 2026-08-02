// Worked examples for the planning prompt.
//
// For a 1-2B model these do more work than any rule text. The planner's job is
// to pick between two structurally identical JSON objects, and a rule ("stop
// once you have the result") is abstract where a transcript is not. Every
// example is rendered in EXACTLY the message shape the loop produces at
// runtime — a decision line, then `Result of <name>: ...` — so the pattern the
// model is asked to continue is byte-for-byte the pattern it already sees.
//
// Each one pins a specific behaviour. The first two are the failures actually
// caught on a phone; the rest are the cases the fix must not break.
//   alarm          — OBSERVED: the planner re-emitted set_alarm after it had
//                    succeeded, and the phone ended up with two 7:00 alarms.
//   calendar week  — OBSERVED: five identical list_calendar_events calls in one
//                    turn, and a range of yesterday→tomorrow for "this week".
//   empty result   — an empty read is an answer, not a reason to look again.
//   contacts → sms — the one case where a SECOND call is right, so the
//                    stop-after-one lesson doesn't overfit into never chaining.
//   denial         — a refusal stays refused; never retry behind the user.
//   no tool        — plain conversation must not reach for a tool at all.
//
// Pure module (no Expo, no engine) so the rendered prompt is unit-tested.
import type { AnyTool } from './types';

export type WorkedExample = {
  /** Short heading, for the model's benefit as much as the reader's. */
  title: string;
  /** Tools the example uses. Skipped entirely unless all are registered — an
   *  example calling set_alarm on iOS would teach a tool that isn't there. */
  tools: string[];
  /** What the user said. */
  user: string;
  /** Parenthetical anchor ("today is Monday 2026-03-02") for examples whose
   *  arguments are dates: without it the arithmetic looks arbitrary. */
  given?: string;
  /** Tool calls, in order, each with the result the loop fed back. */
  steps: { call: string; result: string }[];
};

/**
 * The examples, ordered so the most common request comes first.
 *
 * Dates deliberately sit in March 2026 — far from any plausible "today" — and
 * the system prompt tells the model never to copy them. A placeholder like
 * `<today>` reads as literal text to a small model and gets emitted verbatim;
 * a concrete date at least shows the arithmetic (Monday → the following
 * Sunday) that the model is meant to reproduce with real numbers.
 */
export const WORKED_EXAMPLES: WorkedExample[] = [
  {
    title: 'One action, one call',
    tools: ['set_alarm'],
    user: 'Set an alarm for 7 tomorrow morning',
    steps: [
      {
        call: '{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 0}}',
        result: 'Alarm set for 7:00.',
      },
    ],
  },
  {
    title: 'Reading something, then answering',
    tools: ['list_calendar_events'],
    user: "What's on my calendar this week?",
    given: 'today is Monday 2026-03-02',
    steps: [
      {
        call:
          '{"tool": "list_calendar_events", "arguments": ' +
          '{"start": "2026-03-02", "end": "2026-03-08"}}',
        result: '- Intoglo tech meeting — 2026-03-04, 16:00',
      },
    ],
  },
  {
    title: 'An empty result is still an answer',
    tools: ['list_calendar_events'],
    user: 'Am I free tomorrow?',
    given: 'today is Monday 2026-03-02',
    steps: [
      {
        call:
          '{"tool": "list_calendar_events", "arguments": ' +
          '{"start": "2026-03-03", "end": "2026-03-03"}}',
        result: 'No events in that range.',
      },
    ],
  },
  {
    title: 'Two DIFFERENT tools in a row',
    tools: ['search_contacts', 'compose_sms'],
    user: "Text Arun that I'm running ten minutes late",
    steps: [
      {
        call: '{"tool": "search_contacts", "arguments": {"query": "Arun"}}',
        result: '- Arun Menon · +91 98450 12345',
      },
      {
        call:
          '{"tool": "compose_sms", "arguments": ' +
          '{"phone": "+91 98450 12345", "message": "Running ten minutes late."}}',
        result: 'SMS composer opened; the user must press send.',
      },
    ],
  },
  {
    title: 'Looking something up on the web',
    tools: ['web_search'],
    user: 'How late is the Nandi Hills gate open?',
    steps: [
      {
        call: '{"tool": "web_search", "arguments": {"query": "Nandi Hills gate closing time"}}',
        // No literal URL here. The first version of this example carried
        // "https://example.com" in its result, and on a turn that needed no
        // tool at all the planner called web_fetch on it — copied straight out
        // of the example, exactly like the dates the prompt warns about.
        result: '- Nandi Hills timings — the gate is open 6:00 AM to 10:00 PM daily.',
      },
    ],
  },
  {
    title: 'A refused action stays refused',
    tools: ['schedule_reminder'],
    user: 'Remind me to take my medicine in an hour',
    given: 'it is 14:05 on Monday 2026-03-02',
    steps: [
      {
        call:
          '{"tool": "schedule_reminder", "arguments": ' +
          '{"message": "Take medicine", "date": "2026-03-02", "hour": 15, "minute": 5}}',
        result: 'The user denied this action. Do not retry it; ask what they want instead.',
      },
    ],
  },
  // Three no-tool examples against six tool ones, because the balance itself
  // teaches. With a single one, "Thanks that is all for now" was answered with
  // a web search for "current time" — the planner had been shown six ways to
  // call a tool and one way not to, and it took the hint.
  {
    title: 'No tool needed — small talk',
    tools: [],
    user: 'Thanks, that was perfect',
    steps: [],
  },
  {
    title: 'No tool needed — you already know this',
    tools: [],
    user: 'What is a good stretch for lower back pain?',
    steps: [],
  },
  {
    title: 'No tool needed — nothing to act on',
    tools: [],
    user: 'Morning! How are you doing today?',
    steps: [],
  },
];

/** Render one example as the transcript the loop would have produced. */
function render(ex: WorkedExample): string {
  const lines = [`# ${ex.title}`, `User: ${ex.user}${ex.given ? ` (${ex.given})` : ''}`];
  for (const step of ex.steps) {
    lines.push(step.call);
    // Matches the exact wording of the result messages execute() pushes, so
    // the example and the live conversation are one continuous pattern.
    lines.push(`Result of ${nameOf(step.call)}: ${step.result}`);
  }
  lines.push('{"respond": true}');
  return lines.join('\n');
}

function nameOf(call: string): string {
  return /"tool"\s*:\s*"([^"]+)"/.exec(call)?.[1] ?? 'tool';
}

/**
 * Render the examples usable with `tools`. Filtering matters on iOS, where
 * set_alarm isn't registered: an example is a demonstration that a tool exists,
 * so showing one for a missing tool is a direct invitation to hallucinate it.
 */
export function renderExamples(tools: AnyTool[]): string {
  const available = new Set(tools.map((t) => t.name));
  return WORKED_EXAMPLES.filter((ex) => ex.tools.every((t) => available.has(t)))
    .map(render)
    .join('\n\n');
}
