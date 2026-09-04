// Pins the prompt surgery in ./layout.ts against the real rendered prompt.
//
// Runs in `npm run check` — no model needed, because everything under test is
// pure string work over messages built by `prompt.ts`.
//
// THE DIRECTION IS THE THING BEING TESTED. Every transform starts from the
// SHIPPED prompt (configuration C: date table in the reference block, no date
// anywhere in the system prefix) and produces a counterfactual. When A1 was
// shipped these ran the other way. A transform pointed at the wrong baseline
// does not fail — it silently measures a layout nobody is running and reports
// it as the product — so the assertions below are deliberately about direction:
//
//   * `current` is the LITERAL identity (same array reference), so the baseline
//     arm cannot drift into being a transform that happens to cancel out;
//   * the legacy note is compared against `legacyPlanNote()` itself;
//   * the A1 prefix is compared against the shape the pre-C `systemPrompt()`
//     actually emitted, reproduced here as a fixture.
//
// If the baseline moves again, these go red immediately.
import { describe, expect, it } from 'vitest';

import {
  agentPrefix,
  legacyPlanNote,
  mentionsTime,
  planInstruction,
  turnReference,
} from '@/src/agent/prompt';
import type { AgentMessage } from '@/src/engines/types';

import { buildFakeTools } from '../tools';
import { emptyWorld } from '../types';
import { ablate, applyLayout, toA1Layout, toLegacyLayout } from './layout';

const NOW = new Date('2026-08-12T09:15');
/** Mentions time ("week"), so the relative-times block renders and the legacy
 *  reconstruction is byte-comparable with `legacyPlanNote()`. */
const REQUEST = 'What is on my calendar this week?';
/** No time word at all, so the relative-times block is absent. */
const NO_TIME = 'Show me my photos from the beach';
const tools = () => buildFakeTools(emptyWorld(), NOW);

/** A planning prompt in the SHIPPED layout, built the way `runAgent()` builds it. */
function planPrompt(
  called: string[] = [],
  history: AgentMessage[] = [],
  request = REQUEST,
): AgentMessage[] {
  return [
    ...agentPrefix(tools()),
    { role: 'user', content: request },
    turnReference(NOW, request),
    ...history,
    planInstruction(called),
  ];
}

const systemOf = (m: AgentMessage[]) => m.find((x) => x.content.includes('Tools:'))!.content;
const refOf = (m: AgentMessage[]) => m.find((x) => x.content.startsWith('[Reference'))!.content;
const bracketOf = (s: string) => s.slice(0, s.indexOf(']') + 1);

// ---------------------------------------------------------------------------

describe('the shipped baseline this module transforms FROM', () => {
  it('keeps the date table in the reference block, not the system prefix', () => {
    // If this flips, every transform below is pointed at the wrong baseline.
    expect(refOf(planPrompt())).toContain('Dates (copy from this list, never work one out): ');
    expect(refOf(planPrompt())).toContain('today 2026-08-12');
    expect(systemOf(planPrompt())).not.toContain('Dates (copy from this list');
    expect(systemOf(planPrompt())).not.toContain('today 2026-08-12');
  });

  it('has a date-independent system prefix', () => {
    // The property configuration C exists for: the prefix is byte-identical on
    // any day, so a prewarmed KV snapshot survives midnight. `systemPrompt()`
    // takes no Date, so this is structural — but assert it anyway, because a
    // future edit could reintroduce a clock and nothing else would notice.
    expect(systemOf(planPrompt())).toBe(
      systemOf([
        ...agentPrefix(tools()),
        turnReference(new Date('2027-01-01T09:15'), REQUEST),
        planInstruction([]),
      ]),
    );
  });

  it('renders the relative-time block only when the request names a time', () => {
    expect(mentionsTime(REQUEST)).toBe(true);
    expect(mentionsTime(NO_TIME)).toBe(false);
    expect(turnReference(NOW, REQUEST).content).toContain('Use ONLY if I say');
    expect(turnReference(NOW, NO_TIME).content).not.toContain('Use ONLY if I say');
  });
});

describe('applyLayout("current") — the identity', () => {
  it('returns the very same array, not a copy', () => {
    // Reference equality on purpose. A baseline arm that rebuilt the prompt
    // could differ from the product by a stray space, and a space is a silent
    // KV-cache miss rather than an error.
    const msgs = planPrompt();
    expect(applyLayout(msgs, 'current')).toBe(msgs);
  });

  it('is the identity for an answer-phase prompt too', () => {
    const answer: AgentMessage[] = [
      ...agentPrefix(tools()),
      { role: 'user', content: REQUEST },
      { role: 'user', content: 'Now reply to me directly…' },
    ];
    expect(applyLayout(answer, 'current')).toBe(answer);
    // …and so are the counterfactuals: under C the answer prompt carries no
    // date table in any arm, so there is nothing to move.
    expect(applyLayout(answer, 'a1')).toBe(answer);
    expect(applyLayout(answer, 'legacy')).toBe(answer);
  });
});

describe('toA1Layout — moves the table INTO the system prefix', () => {
  it('takes the table out of the reference block', () => {
    const ref = refOf(toA1Layout(planPrompt()));
    expect(ref).not.toContain('Dates (copy from this list');
    expect(ref).not.toContain('today 2026-08-12');
    // The clock, the weekday, the relative times and the request all survive.
    expect(ref).toContain('09:15');
    expect(ref).toContain('Wednesday');
    expect(ref).toContain('Use ONLY if I say');
    expect(ref).toContain(REQUEST);
  });

  it('leaves no double space where the seam was removed', () => {
    // The seam carries its own leading space; consuming it with the seam is
    // what keeps the bracket well formed. A doubled space here would be a
    // silent cache miss on every turn, which is the failure mode
    // mentionsTime.test.ts guards for the other seam.
    expect(refOf(toA1Layout(planPrompt()))).not.toContain('  ');
    expect(refOf(toA1Layout(planPrompt(undefined, undefined, NO_TIME)))).not.toContain('  ');
  });

  it('reproduces the pre-C system prefix, table and date line and rule together', () => {
    const system = systemOf(toA1Layout(planPrompt()));
    expect(system).toContain(
      "You are Whisper, a helpful assistant running fully on the user's phone.\n" +
        "Today's date is 2026-08-12.\n" +
        '\n' +
        'Dates (copy from this list, never work one out):\n' +
        'today 2026-08-12',
    );
    expect(system).toContain('This week means 2026-08-12 to 2026-08-18.\n\nYou do real things');
    // The pointer moved with the table — under A1 the rule said "near the top
    // of this message"; moving only one of the two would be a configuration
    // nobody ever ran.
    expect(system).toContain('copy it from the date list near the top');
    expect(system).not.toContain('copy it from the date list in the note');
  });

  it('keeps every message and its order', () => {
    const before = planPrompt(['list_calendar_events']);
    const after = toA1Layout(before);
    expect(after.length).toBe(before.length);
    expect(after.map((m) => m.role)).toEqual(before.map((m) => m.role));
    // A1 was append-only too: the reference block stays ahead of the results
    // and the short instruction stays last.
    expect(after[after.length - 1]!.content).toContain('Reply with exactly one JSON object:');
  });

  it('throws rather than silently doing nothing when a landmark moves', () => {
    const broken = planPrompt().map((m) =>
      m.content.startsWith('[Reference')
        ? { ...m, content: '[Reference, not a request — it is 09:15 am on Wednesday, 2026-08-12.]' }
        : m,
    );
    expect(() => toA1Layout(broken)).toThrow(/prompt\.ts has been reworded/);
  });
});

describe('toLegacyLayout — rebuilds the pre-A1 single note', () => {
  it('reproduces legacyPlanNote() exactly, on a first planning step', () => {
    const out = toLegacyLayout(planPrompt());
    expect(out[out.length - 1]).toEqual(legacyPlanNote(NOW, [], REQUEST));
  });

  it('reproduces legacyPlanNote() exactly with spent calls', () => {
    const called = ['list_calendar_events'];
    const out = toLegacyLayout(planPrompt(called));
    expect(out[out.length - 1]).toEqual(legacyPlanNote(NOW, called, REQUEST));
  });

  it('moves the note AFTER the decisions and results', () => {
    const history: AgentMessage[] = [
      { role: 'assistant', content: '{"tool": "list_calendar_events", "arguments": {}}' },
      { role: 'user', content: 'Result of list_calendar_events: No events in that range.' },
    ];
    const out = toLegacyLayout(planPrompt(['list_calendar_events'], history));
    expect(out[out.length - 1]!.content).toContain('[Reference, not a request');
    const resultAt = out.findIndex((m) => m.content.startsWith('Result of'));
    // Re-rendering the note after everything is exactly the cache behaviour A1
    // removed, so the note must sit last and the result before it.
    expect(resultAt).toBeGreaterThan(0);
    expect(resultAt).toBe(out.length - 2);
  });

  it('restores "Today\'s date is …", which pre-A1 had and C removed', () => {
    // Caught by cross-checking against a direct measurement: without this line
    // the legacy arm scored 9/15 on `dates` instead of the 8/15 it scores when
    // the real pre-A1 prompt is used, because the planner still had today's
    // date from the prefix. C deleted the line to make the prefix
    // date-independent, so every earlier-layout counterfactual must put it back.
    const system = systemOf(toLegacyLayout(planPrompt()));
    expect(system).toContain(
      "You are Whisper, a helpful assistant running fully on the user's phone.\n" +
        "Today's date is 2026-08-12.\n",
    );
    // …and NOTHING else in the prefix changes: pre-A1 had no date table, and its
    // date rule already pointed at the note, exactly as C's does.
    expect(system).not.toContain('Dates (copy from this list');
    expect(system).toContain('copy it from the date list in the note');
    expect(system.replace("Today's date is 2026-08-12.\n", '')).toBe(systemOf(planPrompt()));
  });

  it('merges the reference block and the instruction into one message', () => {
    const before = planPrompt();
    const after = toLegacyLayout(before);
    expect(after.length).toBe(before.length - 1);
    expect(after.some((m) => m.content === REQUEST)).toBe(true);
  });

  it('handles a request that names no time', () => {
    const out = toLegacyLayout(planPrompt(undefined, undefined, NO_TIME));
    const note = out[out.length - 1]!.content;
    expect(note).toContain('Dates: today 2026-08-12');
    expect(note).not.toContain('  ');
    expect(bracketOf(note).endsWith(']')).toBe(true);
    expect(note).toContain(NO_TIME);
  });
});

describe('ablate — proves the gate can fail', () => {
  it('only applies to the reference block', () => {
    expect(ablate(systemOf(planPrompt()), 'dates')).toBeNull();
    expect(ablate('Result of list_calendar_events: No events in that range.', 'anchors')).toBeNull();
    expect(ablate(refOf(planPrompt()), 'none')).toBeNull();
  });

  it('"dates" removes the table and keeps the clock and relative times', () => {
    const cut = ablate(refOf(planPrompt()), 'dates')!;
    expect(cut).not.toContain('Dates (copy from this list');
    expect(cut).not.toContain('tomorrow 2026-08-13');
    expect(cut).not.toContain('This week means');
    expect(cut).toContain('09:15');
    // Today's date survives in the clock sentence: the experiment removes the
    // LOOKUP TABLE, not the model's sense of what day it is.
    expect(cut).toContain('2026-08-12');
    expect(cut).toContain('Use ONLY if I say');
    expect(cut).toContain(REQUEST);
    expect(cut).not.toContain('  ');
  });

  it('"anchors" removes the table and the relative times', () => {
    const cut = ablate(refOf(planPrompt()), 'anchors')!;
    expect(cut).not.toContain('Dates (copy from this list');
    expect(cut).not.toContain('Use ONLY if I say');
    expect(cut).not.toContain('in an hour');
    expect(cut).toContain('09:15');
    expect(cut).toContain('Wednesday');
    expect(cut).toContain(REQUEST);
    expect(cut).not.toContain('  ');
    // The bracket still closes; a cut that ate the `]` would change far more
    // than the anchors.
    expect(cut).toContain('2026-08-12.]');
  });

  it('"anchors" tolerates a turn that never had relative times', () => {
    const cut = ablate(turnReference(NOW, NO_TIME).content, 'anchors')!;
    expect(cut).not.toContain('Dates (copy from this list');
    expect(cut).toContain('2026-08-12.]');
  });

  it('throws rather than cutting nothing when the seam moves', () => {
    expect(() => ablate('[Reference, not a request — dates went missing]', 'dates')).toThrow(
      /prompt\.ts has been reworded/,
    );
  });
});
