// The corpus's own tests. Not a test of the agent — a test of the SCENARIOS,
// so that a malformed one fails here, named, instead of reaching the runner and
// being scored as a model failure.
//
// Beyond schema validity these pin the properties the corpus is worthless
// without: every one of the 18 tools exercised, ids unique so a score table can
// key on them, frozen clocks that are real local timestamps, and scripts whose
// assertions do not contradict the answers they script.
import { describe, expect, it } from 'vitest';

import { ScenarioSchema } from '@/src/agent/eval/types';
import { TOOL_DEFS } from '@/src/agent/toolDefs';

import { ALL_SCENARIO_INPUTS, ALL_SCENARIOS } from './index';

const TOOL_NAMES = Object.keys(TOOL_DEFS);

describe('scenario corpus', () => {
  it('is big enough to be a corpus rather than a sample', () => {
    expect(ALL_SCENARIOS.length).toBeGreaterThanOrEqual(60);
  });

  it('parses every scenario under ScenarioSchema', () => {
    for (const [i, input] of ALL_SCENARIO_INPUTS.entries()) {
      const parsed = ScenarioSchema.safeParse(input);
      const where = typeof input.id === 'string' ? input.id : `#${i}`;
      expect(parsed.success ? null : `${where}: ${parsed.error.message}`).toBeNull();
    }
  });

  it('gives every scenario a unique id', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const s of ALL_SCENARIOS) {
      if (seen.has(s.id)) duplicates.push(s.id);
      seen.add(s.id);
    }
    expect(duplicates).toEqual([]);
  });

  it('gives every scenario a title and at least one turn', () => {
    for (const s of ALL_SCENARIOS) {
      expect(s.title, s.id).not.toBe('');
      expect(s.turns.length, s.id).toBeGreaterThan(0);
      for (const turn of s.turns) expect(turn.user, s.id).not.toBe('');
    }
  });
});

describe('coverage', () => {
  // The corpus exists to catch regressions across the whole registry, so a tool
  // nobody wrote a scenario for is a hole, not an omission. This is the guard
  // that makes adding a 19th tool also add a scenario for it.
  it('exercises every tool in the registry', () => {
    const exercised = new Set(
      ALL_SCENARIOS.flatMap((s) => s.turns.flatMap((t) => t.expect.calls.map((c) => c.name))),
    );
    expect([...TOOL_NAMES].filter((n) => !exercised.has(n))).toEqual([]);
  });

  it('only expects calls to tools that exist', () => {
    for (const s of ALL_SCENARIOS) {
      for (const turn of s.turns) {
        for (const c of turn.expect.calls) {
          expect(TOOL_NAMES, `${s.id} expects ${c.name}`).toContain(c.name);
        }
      }
    }
  });

  it('only restricts `tools` to names that exist', () => {
    for (const s of ALL_SCENARIOS) {
      for (const name of s.tools) expect(TOOL_NAMES, s.id).toContain(name);
    }
  });

  // The whole point of the group: turns that must call nothing. If this ever
  // thins out, "thanks, that's all" is one prompt edit away from becoming a web
  // search again.
  it('has real weight on no-tool turns', () => {
    const noToolTurns = ALL_SCENARIOS.flatMap((s) => s.turns).filter(
      (t) => t.expect.calls.length === 0,
    );
    expect(noToolTurns.length).toBeGreaterThanOrEqual(10);
  });

  it('covers refusal and tool failure', () => {
    const refusals = ALL_SCENARIOS.filter((s) => s.turns.some((t) => t.confirmations.includes(false)));
    const failures = ALL_SCENARIOS.filter((s) => Object.keys(s.world.failing).length > 0);
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    expect(failures.length).toBeGreaterThanOrEqual(5);
  });
});

describe('frozen clocks', () => {
  // A scenario that used the real clock would pass today and fail tomorrow, and
  // every date assertion in the corpus is relative to `now`. It has to be a
  // LOCAL timestamp with no zone suffix, or the runner and the date table
  // disagree by the offset.
  it('freezes `now` as a local timestamp with no timezone suffix', () => {
    for (const s of ALL_SCENARIOS) {
      expect(s.now, s.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(Number.isNaN(+new Date(s.now)), s.id).toBe(false);
    }
  });

  // The date/time class of bug is the one this project keeps re-shipping, so
  // the corpus must keep testing it from both ends of the day — including the
  // window between midnight and 05:30 where a UTC date is still yesterday.
  it('includes small-hours clocks, where a UTC date would be yesterday', () => {
    const smallHours = ALL_SCENARIOS.filter((s) => {
      const hhmm = s.now.slice(11);
      return hhmm >= '00:00' && hhmm < '05:30';
    });
    expect(smallHours.map((s) => s.id).length).toBeGreaterThanOrEqual(2);
  });
});

describe('replay scripts', () => {
  // `script` is empty exactly when the scenario is live-only, and that has to
  // be declared rather than inferred: an unscripted scenario is otherwise
  // indistinguishable from one whose script was forgotten.
  it('marks every unscripted scenario live-only, and no others', () => {
    for (const s of ALL_SCENARIOS) {
      expect(s.script.length === 0, `${s.id} script/live-only mismatch`).toBe(
        s.tags.includes('live-only'),
      );
    }
  });

  it('compiles every regex matcher', () => {
    for (const s of ALL_SCENARIOS) {
      for (const step of s.script) {
        if (step.regex && step.when) expect(() => new RegExp(step.when!), s.id).not.toThrow();
      }
    }
  });

  it('keys every script step on a matcher rather than on position', () => {
    for (const s of ALL_SCENARIOS) {
      for (const step of s.script) expect(step.when, s.id).toBeTruthy();
    }
  });

  // A script that contradicts its own assertions scores a failure the harness
  // never had. These two catch it at authoring time.
  it('never scripts an answer containing a forbidden string', () => {
    for (const s of ALL_SCENARIOS) {
      const scripted = s.script.map((step) => step.text.toLowerCase());
      const forbidden = s.turns.flatMap((t) =>
        t.expect.answer.regex ? [] : t.expect.answer.mustNotContain,
      );
      for (const phrase of forbidden) {
        const offender = scripted.find((text) => text.includes(phrase.toLowerCase()));
        expect(offender ?? null, `${s.id} scripts a forbidden phrase "${phrase}"`).toBeNull();
      }
    }
  });

  it('scripts an answer that satisfies every required string', () => {
    // Single-turn only: with several turns there is no way to tell from here
    // which scripted answer belongs to which turn.
    for (const s of ALL_SCENARIOS) {
      const turn = s.turns[0];
      if (!s.script.length || s.turns.length !== 1 || !turn || turn.expect.answer.regex) continue;
      const scripted = s.script.map((step) => step.text.toLowerCase());
      for (const phrase of turn.expect.answer.mustContain) {
        const hit = scripted.some((text) => text.includes(phrase.toLowerCase()));
        expect(hit, `${s.id} never scripts required phrase "${phrase}"`).toBe(true);
      }
    }
  });
});
