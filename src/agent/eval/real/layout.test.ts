// Pins the prompt surgery in ./layout.ts against the real rendered prompt.
//
// This runs in `npm run check` — it needs no model, because everything under
// test is pure string work over messages built by `prompt.ts`. That matters a
// lot: the two experiments this harness exists to run are only worth anything
// if the transforms actually transform. A landmark that goes stale when someone
// rewords the prompt would turn "the date table is load bearing" into "removing
// it changed nothing", silently and in the reassuring direction.
//
// The legacy-layout assertion is the important one: it checks the RECONSTRUCTED
// note against `legacyPlanNote()` itself, so the A/B really is comparing the
// two arrangements the app has actually had, not an approximation of one.
import { describe, expect, it } from 'vitest';

import { agentPrefix, legacyPlanNote, planInstruction, turnReference } from '@/src/agent/prompt';
import type { AgentMessage } from '@/src/engines/types';

import { buildFakeTools } from '../tools';
import { emptyWorld } from '../types';
import { ablate, applyLayout, toLegacyLayout } from './layout';

const NOW = new Date('2026-08-12T09:15');
const REQUEST = 'What is on my calendar this week?';
const tools = () => buildFakeTools(emptyWorld(), NOW);

/** A planning prompt in the shipped layout, built the way `runAgent()` builds it. */
function currentPlanPrompt(called: string[] = [], history: AgentMessage[] = []): AgentMessage[] {
  return [
    ...agentPrefix(tools()),
    { role: 'user', content: REQUEST },
    turnReference(NOW, REQUEST),
    ...history,
    planInstruction(called),
  ];
}

describe('ablate', () => {
  it('finds the date table where systemPrompt puts it', () => {
    const system = agentPrefix(tools())[0]!.content;
    expect(system).toContain('Dates (copy from this list, never work one out):');
    expect(system).toContain('today 2026-08-12');
    expect(system).toContain('This week means 2026-08-12 to 2026-08-18');
  });

  it('"dates" removes the table from the system prefix and nothing else', () => {
    const system = agentPrefix(tools())[0]!.content;
    const cut = ablate(system, 'dates')!;
    expect(cut).not.toContain('tomorrow 2026-08-13');
    expect(cut).not.toContain('This week means');
    // Today's date survives: it is its own line in systemPrompt, and the
    // experiment is "remove the lookup table", not "hide what day it is".
    expect(cut).toContain("Today's date is 2026-08-12.");
    // The rest of the prefix is untouched.
    expect(cut).toContain('Tools:');
    expect(cut).toContain('Worked examples:');
    expect(cut.length).toBeLessThan(system.length);
  });

  it('"dates" leaves the reference block alone', () => {
    expect(ablate(turnReference(NOW, REQUEST).content, 'dates')).toBeNull();
  });

  it('"anchors" also strips the relative times from the reference block', () => {
    const ref = turnReference(NOW, REQUEST).content;
    expect(ref).toContain('in an hour 10:15');
    const cut = ablate(ref, 'anchors')!;
    expect(cut).not.toContain('in an hour');
    expect(cut).not.toContain('Use ONLY if I say');
    // Clock, weekday and the echoed request all survive.
    expect(cut).toContain('09:15');
    expect(cut).toContain('Wednesday');
    expect(cut).toContain(REQUEST);
    // The bracket still closes — a cut that ate the `]` would change far more
    // than the anchors.
    expect(cut).toContain('2026-08-12. ]');
  });

  it('"none" is a no-op everywhere', () => {
    expect(ablate(agentPrefix(tools())[0]!.content, 'none')).toBeNull();
    expect(ablate(turnReference(NOW, REQUEST).content, 'none')).toBeNull();
  });

  it('throws rather than cutting nothing when a landmark moves', () => {
    expect(() => ablate('Dates (copy from this list, never work one out):\nno blank line', 'dates'))
      .toThrow(/prompt.ts has been reworded/);
  });
});

describe('toLegacyLayout', () => {
  it('reproduces legacyPlanNote() exactly, on a first planning step', () => {
    const out = toLegacyLayout(currentPlanPrompt());
    expect(out[out.length - 1]).toEqual(legacyPlanNote(NOW, [], REQUEST));
  });

  it('reproduces legacyPlanNote() exactly with spent calls', () => {
    const called = ['list_calendar_events'];
    const out = toLegacyLayout(currentPlanPrompt(called));
    expect(out[out.length - 1]).toEqual(legacyPlanNote(NOW, called, REQUEST));
  });

  it('takes the date table OUT of the system prefix', () => {
    const out = toLegacyLayout(currentPlanPrompt());
    expect(out[0]!.content).not.toContain('Dates (copy from this list');
    expect(out[0]!.content).not.toContain('tomorrow 2026-08-13');
    // …and it is in the note instead, which is the whole point of the A/B.
    expect(out[out.length - 1]!.content).toContain('Dates: today 2026-08-12');
  });

  it('moves the note AFTER the decisions and results', () => {
    const history: AgentMessage[] = [
      { role: 'assistant', content: '{"tool": "list_calendar_events", "arguments": {}}' },
      { role: 'user', content: 'Result of list_calendar_events: No events in that range.' },
    ];
    const out = toLegacyLayout(currentPlanPrompt(['list_calendar_events'], history));
    const last = out[out.length - 1]!.content;
    expect(last).toContain('[Reference, not a request');
    // The result must now come BEFORE the note — that re-render-after-everything
    // placement is exactly the cache behaviour A1 removed.
    const resultAt = out.findIndex((m) => m.content.startsWith('Result of'));
    expect(resultAt).toBeGreaterThan(0);
    expect(resultAt).toBeLessThan(out.length - 1);
  });

  it('preserves every message, losing nothing', () => {
    const before = currentPlanPrompt();
    const after = toLegacyLayout(before);
    // reference + instruction merge into one note, so exactly one fewer.
    expect(after.length).toBe(before.length - 1);
    expect(after.some((m) => m.content === REQUEST)).toBe(true);
  });
});

describe('applyLayout', () => {
  it('is a no-op for "current"', () => {
    const msgs = currentPlanPrompt();
    expect(applyLayout(msgs, 'current')).toBe(msgs);
  });

  it('on an answer-phase prompt, only strips the system date table', () => {
    // The answer phase has no reference block and no planning instruction, so
    // there is no note to rebuild — but the system prefix must still match the
    // legacy one, or the two arms would differ by more than the layout.
    const answer: AgentMessage[] = [
      ...agentPrefix(tools()),
      { role: 'user', content: REQUEST },
      { role: 'user', content: 'Now reply to me directly…' },
    ];
    const out = applyLayout(answer, 'legacy');
    expect(out.length).toBe(answer.length);
    expect(out[0]!.content).not.toContain('Dates (copy from this list');
    expect(out[2]!.content).toBe('Now reply to me directly…');
  });
});

const bracket = (s: string) => s.slice(0, s.indexOf(']') + 1);
const stripToday = (s: string) => s.replace(/Today's date is [0-9-]+\./, '');

describe('toTableInNote (configuration C)', () => {
  it('takes the date table out of the system prefix', () => {
    const out = applyLayout(currentPlanPrompt(), 'table-in-note');
    expect(out[0]!.content).not.toContain('Dates (copy from this list');
    expect(out[0]!.content).not.toContain('tomorrow 2026-08-13');
    // Everything else in the prefix survives — this is a MOVE, not a cut.
    expect(out[0]!.content).toContain('Tools:');
    expect(out[0]!.content).toContain('Worked examples:');
  });

  it('leaves the system prefix free of the date table, so a KV snapshot outlives midnight', () => {
    // The property this configuration exists for: render the prefix on two
    // different days and, once the one remaining `Today's date is …` line is
    // discounted, get byte-identical text.
    const a = applyLayout(currentPlanPrompt(), 'table-in-note')[0]!.content;
    const dayLater = new Date('2026-08-13T09:15');
    const b = applyLayout(
      [
        ...agentPrefix(tools()),
        { role: 'user', content: REQUEST },
        turnReference(dayLater, REQUEST),
        planInstruction([]),
      ],
      'table-in-note',
    )[0]!.content;
    expect(stripToday(a)).toBe(stripToday(b));
  });

  it('puts the table in the reference block, exactly where legacy puts it', () => {
    const c = applyLayout(currentPlanPrompt(), 'table-in-note');
    const ref = c.find((m) => m.content.startsWith('[Reference'))!.content;
    const legacy = legacyPlanNote(NOW, [], REQUEST).content;
    // The bracket — clock, dates, relative times — must match legacy's byte for
    // byte, so any difference in the A/B is attributable to STRUCTURE and not to
    // the dates being presented differently.
    expect(bracket(ref)).toBe(bracket(legacy));
  });

  it('keeps A1 structure: reference before the results, short instruction last', () => {
    const history: AgentMessage[] = [
      { role: 'assistant', content: '{"tool": "list_calendar_events", "arguments": {}}' },
      { role: 'user', content: 'Result of list_calendar_events: No events in that range.' },
    ];
    const before = currentPlanPrompt(['list_calendar_events'], history);
    const out = applyLayout(before, 'table-in-note');
    const refAt = out.findIndex((m) => m.content.startsWith('[Reference'));
    const resultAt = out.findIndex((m) => m.content.startsWith('Result of'));
    expect(refAt).toBeLessThan(resultAt);
    // …and the trailing instruction is still its own short message, which is the
    // half of A1 that produces the saving. Legacy would have merged it away.
    expect(out[out.length - 1]!.content).toContain('Reply with exactly one JSON object:');
    expect(out.length).toBe(before.length);
  });

  it('handles a turn whose request names no time', () => {
    // `turnReference` renders the relative times only when the request names a
    // time, so the common case has none — the table must still land INSIDE the
    // bracket rather than after it.
    const asked = 'Show me my photos from the beach';
    const plain: AgentMessage[] = [
      ...agentPrefix(tools()),
      { role: 'user', content: asked },
      turnReference(NOW, asked),
      planInstruction([]),
    ];
    expect(turnReference(NOW, asked).content).not.toContain('Use ONLY if I say');
    const ref = applyLayout(plain, 'table-in-note').find((m) =>
      m.content.startsWith('[Reference'),
    )!.content;
    expect(ref).toContain('Dates: today 2026-08-12');
    expect(ref.indexOf('Dates:')).toBeLessThan(ref.indexOf(']'));
  });
});
