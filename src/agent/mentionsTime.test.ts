// The specification for the conditional relative-times block.
//
// The load-bearing test is `never omits the block from a turn that has to
// produce a clock time`: it runs the predicate over every user message in the
// scenario corpus whose expected call takes an `hour` or a `minute` argument,
// and fails if the block would have been left out of even one of them. The set
// of such tools is derived from TOOL_DEFS rather than listed, so a new tool with
// an hour argument joins the property automatically instead of quietly escaping
// it.
//
// This is the same shape as fastPath.test.ts and deliberately so, but the two
// guard different severities. A false skip in fastPath is a SILENT lie — the
// user is told their alarm is set and it is not. A false omission here is a
// WRONG TIME ON A CONFIRMATION CARD: every tool that consumes the block has
// `requiresConfirmation: true` and renders the computed time into the label the
// user must tap, so the error is shown before anything happens. Widen the
// vocabulary in prompt.ts only with this green.
import { describe, expect, it } from 'vitest';

import { ALL_SCENARIOS } from './eval/scenarios';
import { mentionsTime, turnReference } from './prompt';
import { TOOL_DEFS } from './toolDefs';
import { paramsToJsonSchema } from './types';

/** Tools whose arguments include a clock time — the only consumers of the
 *  relative-times block. Derived, so it cannot go stale. */
const TIME_ARG_TOOLS = new Set(
  Object.entries(TOOL_DEFS)
    .filter(([, d]) => {
      const schema = paramsToJsonSchema(d.params) as { properties?: Record<string, unknown> };
      const props = schema.properties ?? {};
      return 'hour' in props || 'minute' in props;
    })
    .map(([name]) => name),
);

/** Every (message, needs-a-clock-time) pair the corpus declares. */
const TURNS = ALL_SCENARIOS.flatMap((s) =>
  s.turns.map((t) => ({
    id: s.id,
    user: t.user,
    needsClock: (t.expect?.calls ?? []).some((c) => TIME_ARG_TOOLS.has(c.name)),
  })),
);

describe('mentionsTime', () => {
  it('has a corpus, and tools that take a clock time', () => {
    expect(TIME_ARG_TOOLS).toContain('set_alarm');
    expect(TIME_ARG_TOOLS).toContain('schedule_reminder');
    expect(TIME_ARG_TOOLS).toContain('create_calendar_event');
    expect(TURNS.filter((t) => t.needsClock).length).toBeGreaterThan(15);
  });

  // THE safety property. Not a sample — every clock-bearing turn in the corpus.
  it('never omits the block from a turn that has to produce a clock time', () => {
    const falseOmissions = TURNS.filter((t) => t.needsClock && !mentionsTime(t.user)).map(
      (t) => `${t.id}: ${t.user}`,
    );
    expect(falseOmissions).toEqual([]);
  });

  it('keeps the block for a time named without any digit', () => {
    // The block's own fence is `Use ONLY if I say "in N minutes/hours"`, and the
    // digit test catches every request that writes the N. These are the ones
    // that do not, and they are why the vocabulary exists at all.
    for (const msg of [
      'remind me in half an hour',
      'wake me in an hour',
      'set an alarm for noon',
      'remind me at midnight',
      'call me in a couple of hours',
      "let's say quarter past",
      'remind me in a bit',
      'ping me later tonight',
      'set it for tomorrow morning',
      'put it in the calendar for Thursday',
      'wake me up early',
      'schedule a meeting with Arun',
      'add an event for the weekend',
    ]) {
      expect(mentionsTime(msg), msg).toBe(true);
    }
  });

  it('keeps the block for anything carrying a digit', () => {
    expect(mentionsTime('wake me at 5')).toBe(true);
    expect(mentionsTime('I need to be up at 5')).toBe(true);
    expect(mentionsTime('lunch at 12:30')).toBe(true);
  });

  it('keeps the block when there is no request to judge', () => {
    // Empty means "the caller did not say", not "certainly no time". The prewarm
    // and the reserve both render the block through this path.
    expect(mentionsTime('')).toBe(true);
    expect(mentionsTime('   ')).toBe(true);
  });

  it('omits the block from the knowledge questions it exists for', () => {
    // Each of these pays ~212 characters of pre-computed clock arithmetic it
    // cannot use — and the block has its own observed failure mode when it is
    // present and irrelevant: unfenced, "in an hour 22:59" turned "remind me at
    // 10pm" into 10:59 PM. Dropping it where it cannot apply removes that risk
    // as well as the tokens.
    for (const msg of [
      'What is the capital of France?',
      'How many continents are there?',
      'What does ephemeral mean?',
      'How long should I boil eggs for a soft yolk?',
      'Who wrote Hamlet?',
      'What can you actually do on my phone?',
      'What is a good stretch for lower back pain?',
    ]) {
      expect(mentionsTime(msg), msg).toBe(false);
    }
  });
});

describe('turnReference, conditional', () => {
  const at = new Date(2026, 7, 2, 13, 9);

  it('renders byte-identically to the unconditional block when it is kept', () => {
    // A stray space either side of the block would be a silent cache miss on
    // every turn that names a time — the prefix is matched by token equality,
    // and nothing would report it.
    // The full literal is spelled out rather than composed, so that a lost or
    // doubled space at EITHER seam — before the date table, or between it and
    // the fenced block — fails here instead of silently costing a re-prefill.
    expect(turnReference(at, 'wake me in an hour').content).toBe(
      '[Reference, not a request — it is 01:09 pm on Sunday, 2026-08-02. ' +
        'Dates (copy from this list, never work one out): today 2026-08-02, ' +
        'tomorrow 2026-08-03, Tuesday 2026-08-04, Wednesday 2026-08-05, ' +
        'Thursday 2026-08-06, Friday 2026-08-07, Saturday 2026-08-08. ' +
        'This week means 2026-08-02 to 2026-08-08. ' +
        'Use ONLY if I say "in N minutes/hours": in 30 minutes it is 13:39, ' +
        'in an hour 14:09, in three hours 16:09. If I name a time instead ' +
        '("at 10pm", "at 7:30"), use exactly that, with minute 0 unless I said a minute.]\n' +
        'What I actually asked you: "wake me in an hour"',
    );
  });

  it('keeps the clock and the echo when it drops the relative times', () => {
    // The clock line is NOT conditional: "What time is it?" is answered from it,
    // and the echoed request is the fix for the planner answering this block
    // instead of the person ("Thanks, that is all for now" -> a web search for
    // "current time"). Only the fenced arithmetic goes.
    const note = turnReference(at, 'What is the capital of France?').content;
    expect(note).toBe(
      '[Reference, not a request — it is 01:09 pm on Sunday, 2026-08-02. ' +
        'Dates (copy from this list, never work one out): today 2026-08-02, ' +
        'tomorrow 2026-08-03, Tuesday 2026-08-04, Wednesday 2026-08-05, ' +
        'Thursday 2026-08-06, Friday 2026-08-07, Saturday 2026-08-08. ' +
        'This week means 2026-08-02 to 2026-08-08.' +
        ']\n' +
        'What I actually asked you: "What is the capital of France?"',
    );
    expect(note).not.toMatch(/in an hour/);
  });

  it('saves the whole fenced block and nothing else', () => {
    // One-character requests either side — '9' carries a digit and keeps the
    // block, 'q' carries nothing and drops it — so the difference is the fenced
    // block plus the space before it, and nothing else. 212 characters is ~55
    // estimated tokens, ~0.79s of prefill at the AVD's 70 tok/s.
    const kept = turnReference(at, '9').content.length;
    const dropped = turnReference(at, 'q').content.length;
    expect(kept - dropped).toBe(212);
  });
});
