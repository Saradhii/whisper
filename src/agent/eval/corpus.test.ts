// The gate. Runs the whole replayable corpus through the real agent loop and
// fails the build when the score drops.
//
// This is the piece that changes how the project is developed. Every harness
// change until now has been validated by flashing a build to an emulator and
// reading chat bubbles — which cannot tell you that the fix for "6pm today"
// broke the calendar range, and cannot run on a pull request. Now it can.
//
// The floors below are a RATCHET, not a target. They are the scores the corpus
// actually achieves today; raise them when the harness improves, and never lower
// one to make a red build green — a drop is the harness telling you something
// regressed, which is the entire point of having built this.
import { describe, expect, it } from 'vitest';

import { scoreAll } from './run';
import { ALL_SCENARIOS, LIVE_ONLY_SCENARIOS } from './scenarios';
import type { ScoreReport } from './types';

/** Replay mode can only score scenarios that carry a script. */
const REPLAYABLE = ALL_SCENARIOS.filter((s) => s.script.length > 0);

/**
 * Current scores, pinned. Written from an observed run, not from ambition.
 *
 * `meanSteps` is a CEILING and belongs here as much as the accuracy floors: a
 * harness change that keeps every answer correct while spending twice as many
 * planning turns to get there has made the app slower and hotter for nothing,
 * and on a phone running the model locally that is a real regression. It is the
 * cheapest available proxy for the Phase 2 latency budget.
 */
const FLOOR = {
  completed: 75,
  toolCorrect: 75,
  argsCorrect: 75,
  answerCorrect: 75,
  meanStepsCeiling: 2.2,
} as const;

function table(report: ScoreReport): string {
  const pct = (n: number) => `${((n / report.turns) * 100).toFixed(1)}%`;
  const rows = [
    ['scenarios', String(report.scenarios)],
    ['turns', String(report.turns)],
    ['completed', `${report.completed}/${report.turns} (${pct(report.completed)})`],
    ['tool correct', `${report.toolCorrect}/${report.turns} (${pct(report.toolCorrect)})`],
    ['args correct', `${report.argsCorrect}/${report.turns} (${pct(report.argsCorrect)})`],
    ['answer correct', `${report.answerCorrect}/${report.turns} (${pct(report.answerCorrect)})`],
    ['mean steps', report.meanSteps.toFixed(2)],
    ['drifted', String(report.drifted)],
  ];
  const failures = report.perTurn
    .filter((t) => !t.completed)
    .map((t) => `  FAIL ${t.scenarioId} turn ${t.turnIndex} :: ${t.failures.join('; ')}`);
  return [
    '',
    '  agent eval — replay mode',
    ...rows.map(([k, v]) => `  ${String(k).padEnd(16)}${v}`),
    ...(failures.length ? ['', ...failures] : []),
    '',
  ].join('\n');
}

describe('agent eval corpus', () => {
  it('meets the scored floor', async () => {
    const report = await scoreAll(REPLAYABLE);
    // Printed unconditionally: a green run's numbers are what you ratchet the
    // floor against, so they have to be visible without deliberately breaking
    // something to see them.
    console.log(table(report));

    expect(report.completed).toBeGreaterThanOrEqual(FLOOR.completed);
    expect(report.toolCorrect).toBeGreaterThanOrEqual(FLOOR.toolCorrect);
    expect(report.argsCorrect).toBeGreaterThanOrEqual(FLOOR.argsCorrect);
    expect(report.answerCorrect).toBeGreaterThanOrEqual(FLOOR.answerCorrect);
    expect(report.meanSteps).toBeLessThanOrEqual(FLOOR.meanStepsCeiling);
  });

  it('scores no drifted generations in replay mode', async () => {
    // Scripts are authored against the current prompt, so drift here means a
    // script is being selected by fallback order rather than by its `when` —
    // it would still pass while testing something other than what it says.
    const report = await scoreAll(REPLAYABLE);
    expect(report.drifted).toBe(0);
  });

  it('keeps the live-only set small and declared', () => {
    // Live-only scenarios cost nothing in CI and therefore protect nothing in
    // CI. They are legitimate — some behaviour only a real planner exhibits —
    // but the set growing quietly is how a corpus stops being a gate.
    expect(LIVE_ONLY_SCENARIOS.length).toBeLessThanOrEqual(5);
    expect(REPLAYABLE.length + LIVE_ONLY_SCENARIOS.length).toBe(ALL_SCENARIOS.length);
  });
});
