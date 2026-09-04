// The real-model gate. Drives the SAME corpus as `corpus.test.ts` through the
// SAME agent loop, but with an actual Qwen3-1.7B-Q4_K_M decoding under the
// actual GBNF grammar instead of a script.
//
// ============================ READ THIS FIRST ============================
// ACCURACY ONLY. NEVER QUOTE A TIMING FROM THIS SUITE. See ./model.ts.
// =========================================================================
//
// WHY THIS EXISTS
// `corpus.test.ts` scores 74 scenarios at 100% and is wired into `npm run
// check`. It is genuinely good at what it does — it regression-tests harness
// STRUCTURE, and `assertProducible()` was added to it after a run passed for the
// wrong reason. But it replays SCRIPTED decisions, so it cannot answer the one
// question two concurrent prompt changes need answered: does a REAL planner
// still decide correctly after the prompt moved? The fixture emits the same
// canned decision either way, which makes "eval stayed green" no evidence at
// all about accuracy.
//
// WHY IT IS NOT IN `npm run check`
// It needs a 1.1 GB GGUF and a native runner that CI and other agents will not
// have. It skips — loudly, with instructions — when either is missing.
//
//   npm run eval:real                            score and gate
//   WHISPER_EVAL_ABLATION=dates npm run eval:real   prove the gate can fail
//   WHISPER_EVAL_REPEATS=3 npm run eval:real     measure run-to-run variance
//   WHISPER_EVAL_ONLY=dates npm run eval:real    one tag, for a fast loop
//   WHISPER_EVAL_UPDATE_BASELINE=1 npm run eval:real   re-record the ratchet
import fs from 'fs';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scoreAll } from '../run';
import { ALL_SCENARIOS } from '../scenarios';
import type { Scenario, ScoreReport } from '../types';
import { realEngine, ABLATIONS, type Ablation } from './engine';
import { availability, loadRealModel, MODEL_PATH, type RealModel } from './model';
import {
  compare,
  formatFailures,
  formatTable,
  formatVariance,
  summarize,
  type Baseline,
  type Summary,
} from './report';

// Resolved from the project root, not from `__dirname`: this file is
// transformed to ESM by Vite before it runs, where `__dirname` is not defined.
// Vitest always runs with the project root as cwd.
const BASELINE_PATH = path.join(process.cwd(), 'src/agent/eval/real/baseline.json');

const ABLATION = (process.env.WHISPER_EVAL_ABLATION ?? 'none') as Ablation;
const REPEATS = Math.max(1, Number(process.env.WHISPER_EVAL_REPEATS ?? 1));
const SEED = Number(process.env.WHISPER_EVAL_SEED ?? 1);
const ONLY = process.env.WHISPER_EVAL_ONLY ?? '';
const UPDATE = process.env.WHISPER_EVAL_UPDATE_BASELINE === '1';

/**
 * Every scenario, including the live-only ones.
 *
 * Replay mode has to skip scenarios with no script; this mode is the reason
 * those scenarios were written. Filtering by tag or id is for iterating on one
 * failure — a filtered run never updates the baseline, because a baseline
 * recorded over eight scenarios would gate the other sixty-six at zero.
 */
function corpus(): Scenario[] {
  if (!ONLY) return ALL_SCENARIOS;
  const wanted = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
  return ALL_SCENARIOS.filter((s) => wanted.some((w) => s.tags.includes(w) || s.id === w));
}

const check = availability();

// `describe.skipIf` rather than a thrown error: a machine without the weights is
// not a broken machine, and this suite must be safe for any agent to invoke.
describe.skipIf(!check.ok)('agent eval corpus — real model', () => {
  let model: RealModel;

  beforeAll(async () => {
    model = await loadRealModel();
  }, 600_000);

  afterAll(async () => {
    await model?.dispose();
  });

  it('scores the corpus with a real planner', async () => {
    if (!ABLATIONS.includes(ABLATION)) {
      throw new Error(
        `WHISPER_EVAL_ABLATION=${ABLATION} is not one of: ${ABLATIONS.join(', ')}`,
      );
    }
    const scenarios = corpus();
    expect(scenarios.length).toBeGreaterThan(0);

    const runs: Summary[] = [];
    let last: ScoreReport | undefined;

    for (let r = 0; r < REPEATS; r++) {
      const seed = SEED + r;
      const started = Date.now();
      const report = await scoreAll(scenarios, () =>
        realEngine(model, { ablation: ABLATION, seed }),
      );
      const summary = summarize(report, scenarios);
      runs.push(summary);
      last = report;
      console.log(
        formatTable(summary, {
          model: path.basename(MODEL_PATH),
          backend: model.backend,
          ablation: ABLATION,
          seed,
          ms: Date.now() - started,
        }),
      );
    }

    console.log(formatVariance(runs));
    if (last) console.log(formatFailures(last));

    const summary = runs[0]!;

    // --- the ratchet -------------------------------------------------------
    const baseline = readBaseline();

    if (UPDATE) {
      if (ONLY) throw new Error('refusing to record a baseline from a filtered run (WHISPER_EVAL_ONLY is set)');
      if (ABLATION !== 'none') throw new Error('refusing to record a baseline from an ablated run');
      writeBaseline(summary);
      console.log(`  baseline written to ${BASELINE_PATH}\n`);
      return;
    }

    if (!baseline) {
      console.log(
        `  no baseline yet — record one with:\n` +
          `    WHISPER_EVAL_UPDATE_BASELINE=1 npm run eval:real\n`,
      );
      return;
    }

    if (ABLATION !== 'none' || ONLY) {
      // An ablated or filtered run is an EXPERIMENT, not a gate: it is supposed
      // to score worse, and failing the build for that would make the one
      // command that proves this harness works also the one that breaks CI.
      // Print the delta, which is the whole artifact of such a run.
      console.log(delta(baseline, summary, ABLATION, ONLY));
      return;
    }

    const regressions = compare(baseline, summary);
    if (regressions.length) {
      const detail = regressions
        .map((g) => `    ${g.where}.${g.metric}: ${g.was} -> ${g.now}`)
        .join('\n');
      throw new Error(
        `real-model accuracy regressed against ${path.basename(BASELINE_PATH)} ` +
          `(recorded ${baseline.recordedAt}):\n${detail}\n\n` +
          `  Do NOT lower the baseline to make this green. Either the prompt change\n` +
          `  under test costs accuracy — report it and stop — or the corpus improved\n` +
          `  and the ratchet should be RAISED with WHISPER_EVAL_UPDATE_BASELINE=1.`,
      );
    }
    console.log(`  no regression against the baseline recorded ${baseline.recordedAt}\n`);
  }, 7_200_000);
});

// A skipped suite prints nothing useful on its own, and "0 tests" is exactly the
// outcome someone would mistake for a pass. Say why, once, with the fix.
if (!check.ok) {
  console.log(
    `\n  agent eval — real model: SKIPPED\n  ${check.reason.split('\n').join('\n  ')}\n`,
  );
}

// ---------------------------------------------------------------------------

function readBaseline(): Baseline | null {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  const model = path.basename(MODEL_PATH);
  if (parsed.model !== model) {
    throw new Error(
      `baseline.json was recorded against ${parsed.model} but this run used ${model}. ` +
        `Scores are not comparable across models — record a new baseline, or point ` +
        `WHISPER_EVAL_MODEL at the original.`,
    );
  }
  return parsed;
}

function writeBaseline(summary: Summary): void {
  const baseline: Baseline = {
    model: path.basename(MODEL_PATH),
    ablation: 'none',
    recordedAt: new Date().toISOString(),
    overall: summary.overall,
    groups: summary.groups,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
}

/** The output of an ablation run: what the mutilation cost, per group. */
function delta(baseline: Baseline, now: Summary, ablation: string, only: string): string {
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const line = (label: string, was: { argsCorrect: number; toolCorrect: number; completed: number; turns: number } | undefined, got: typeof was) =>
    was && got
      ? `  ${label.padEnd(14)}args ${String(got.argsCorrect).padStart(3)}/${String(got.turns).padEnd(3)} ` +
        `(${sign(got.argsCorrect - was.argsCorrect)})   tool ${String(got.toolCorrect).padStart(3)}/${String(got.turns).padEnd(3)} ` +
        `(${sign(got.toolCorrect - was.toolCorrect)})   completed ${String(got.completed).padStart(3)} ` +
        `(${sign(got.completed - was.completed)})`
      : `  ${label.padEnd(14)}(not in baseline)`;
  return [
    '',
    `  ABLATION "${ablation}"${only ? ` (filtered: ${only})` : ''} vs baseline ${baseline.recordedAt}`,
    '  ' + '-'.repeat(76),
    line('OVERALL', baseline.overall, now.overall),
    ...Object.keys(now.groups).map((t) => line(t, baseline.groups[t], now.groups[t])),
    '',
    `  A drop here is the harness PASSING its own test: it proves the corpus is`,
    `  sensitive to the prompt section that was removed.`,
    '',
  ].join('\n');
}
