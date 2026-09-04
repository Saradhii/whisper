// Turning a `ScoreReport` into something a person can act on, and into a number
// a build can fail on.
//
// ACCURACY ONLY — see the banner in ./model.ts.
//
// The grouping is the point. A run that is 90% overall and 45% on `dates` is a
// completely different report from one that is 90% everywhere, and only a
// per-tag table shows it. This project's recurring failure has never been "the
// model got worse in general" — it has been the right tool called with a date
// computed instead of copied. `argsCorrect` on the `dates` group is the single
// number this whole harness exists to produce.
import type { Scenario, ScoreReport, TurnScore } from '../types';

/** Tags whose scores are called out individually, in this order. Everything
 *  else is folded into the overall row only. */
export const HEADLINE_TAGS = ['dates', 'no-tool', 'multistep', 'suppression', 'refusal'] as const;

export type Metrics = {
  turns: number;
  completed: number;
  toolCorrect: number;
  argsCorrect: number;
  /**
   * Tool AND arguments both right — the metric to read first.
   *
   * `argsCorrect` alone is misleading and this harness found out the hard way.
   * `scoreTurn()` only compares arguments for calls whose tool NAME matched
   * (deliberately: the arguments of a different tool are not a meaningful
   * comparison), so a turn where the planner called nothing at all scores
   * `argsCorrect: true` on a vacuous truth. Ablating the date table made two
   * scenarios stop calling the tool altogether, and `argsCorrect` went UP by
   * one as a result. Conjoining the two is what makes the number monotone in
   * the thing anyone actually cares about.
   */
  callsCorrect: number;
  answerCorrect: number;
};

export type Summary = {
  overall: Metrics;
  /** Keyed by tag. Only tags that matched at least one scenario appear. */
  groups: Record<string, Metrics>;
  meanSteps: number;
};

function tally(turns: TurnScore[]): Metrics {
  return {
    turns: turns.length,
    completed: turns.filter((t) => t.completed).length,
    toolCorrect: turns.filter((t) => t.toolCorrect).length,
    argsCorrect: turns.filter((t) => t.argsCorrect).length,
    callsCorrect: turns.filter((t) => t.toolCorrect && t.argsCorrect).length,
    answerCorrect: turns.filter((t) => t.answerCorrect).length,
  };
}

export function summarize(report: ScoreReport, scenarios: Scenario[]): Summary {
  const tagsById = new Map(scenarios.map((s) => [s.id, s.tags]));
  const groups: Record<string, Metrics> = {};
  for (const tag of HEADLINE_TAGS) {
    const rows = report.perTurn.filter((t) => tagsById.get(t.scenarioId)?.includes(tag));
    if (rows.length) groups[tag] = tally(rows);
  }
  return { overall: tally(report.perTurn), groups, meanSteps: report.meanSteps };
}

const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : '—');

function row(label: string, m: Metrics): string {
  const cell = (n: number) => `${String(n).padStart(3)}/${String(m.turns).padEnd(3)} ${pct(n, m.turns).padStart(6)}`;
  return (
    `  ${label.padEnd(14)}` +
    `${cell(m.callsCorrect)}  ${cell(m.toolCorrect)}  ${cell(m.argsCorrect)}  ` +
    `${cell(m.completed)}  ${cell(m.answerCorrect)}`
  );
}

export function formatTable(
  summary: Summary,
  meta: { model: string; backend: string; ablation: string; seed: number; ms: number },
): string {
  // `call ok` leads because it is the only column that is monotone in accuracy:
  // see the note on Metrics.callsCorrect.
  const head =
    `  ${''.padEnd(14)}${'call ok'.padEnd(14)}  ${'tool'.padEnd(14)}  ${'args'.padEnd(14)}  ` +
    `${'completed'.padEnd(14)}  answer`;
  const lines = [
    '',
    `  agent eval — REAL MODEL (accuracy only; these timings mean nothing)`,
    `  model ${meta.model}   backend ${meta.backend}   ablation ${meta.ablation}   seed ${meta.seed}`,
    `  wall ${(meta.ms / 1000).toFixed(1)}s   mean steps ${summary.meanSteps.toFixed(2)}`,
    '',
    head,
    '  ' + '-'.repeat(94),
    row('OVERALL', summary.overall),
  ];
  const tags = Object.keys(summary.groups);
  if (tags.length) {
    lines.push('  ' + '-'.repeat(94));
    for (const tag of tags) lines.push(row(tag, summary.groups[tag]!));
  }
  lines.push('');
  return lines.join('\n');
}

/** The failing rows, most useful first: a wrong ARGUMENT is a subtler and more
 *  dangerous defect than a wrong tool, so those are listed before the rest. */
export function formatFailures(report: ScoreReport, limit = 40): string {
  const bad = report.perTurn.filter((t) => !t.completed);
  if (!bad.length) return '  no failing turns\n';
  const ranked = [
    ...bad.filter((t) => t.toolCorrect && !t.argsCorrect),
    ...bad.filter((t) => !t.toolCorrect),
    ...bad.filter((t) => t.toolCorrect && t.argsCorrect),
  ];
  const shown = ranked.slice(0, limit);
  return (
    [
      `  ${bad.length} failing turn(s):`,
      ...shown.map((t) => `    ${t.scenarioId} #${t.turnIndex} :: ${t.failures.join('; ')}`),
      ...(ranked.length > shown.length ? [`    … and ${ranked.length - shown.length} more`] : []),
    ].join('\n') + '\n'
  );
}

// ---------------------------------------------------------------------------
// Variance
// ---------------------------------------------------------------------------

/**
 * Spread of one metric across repeated runs.
 *
 * Reported because the alternative is that someone reads a two-point move as a
 * regression. Planning decodes at temperature 0 and is greedy, so the plan half
 * should be stable; the ANSWER phase samples at 0.7, so `answerCorrect` — and
 * therefore `completed` — legitimately wobbles. Knowing which of those a drop
 * landed in is the difference between "revert the prompt change" and "run it
 * again".
 */
export type Spread = { min: number; max: number; mean: number; stdev: number };

export function spread(values: number[]): Spread {
  const n = values.length || 1;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { min: Math.min(...values), max: Math.max(...values), mean, stdev: Math.sqrt(variance) };
}

export function formatVariance(runs: Summary[]): string {
  if (runs.length < 2) return '';
  const keys = ['callsCorrect', 'toolCorrect', 'argsCorrect', 'completed', 'answerCorrect'] as const;
  const lines = [
    '',
    `  run-to-run variance over ${runs.length} repeats (different seeds, same corpus)`,
    `  ${'metric'.padEnd(16)}${'min'.padStart(5)}${'max'.padStart(6)}${'mean'.padStart(8)}${'stdev'.padStart(8)}`,
    '  ' + '-'.repeat(44),
  ];
  for (const key of keys) {
    const s = spread(runs.map((r) => r.overall[key]));
    lines.push(
      `  ${key.padEnd(16)}${String(s.min).padStart(5)}${String(s.max).padStart(6)}` +
        `${s.mean.toFixed(1).padStart(8)}${s.stdev.toFixed(2).padStart(8)}`,
    );
  }
  const dates = runs.every((r) => r.groups.dates);
  if (dates) {
    const s = spread(runs.map((r) => r.groups.dates!.callsCorrect));
    lines.push(
      `  ${'dates call ok'.padEnd(16)}${String(s.min).padStart(5)}${String(s.max).padStart(6)}` +
        `${s.mean.toFixed(1).padStart(8)}${s.stdev.toFixed(2).padStart(8)}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type Baseline = {
  /** What produced it — a baseline from a different model or ablation is not a
   *  baseline for this run and must not silently gate it. */
  model: string;
  ablation: string;
  recordedAt: string;
  /** Absolute turn counts, not percentages: the corpus grows, and a percentage
   *  floor silently loosens every time a scenario is added. */
  overall: Metrics;
  groups: Record<string, Metrics>;
};

export type Regression = { where: string; metric: string; was: number; now: number };

/**
 * Compare a run to its baseline.
 *
 * `tolerance` is in TURNS, and it exists only because the answer phase samples
 * at 0.7. It applies to `completed` and `answerCorrect`, which a reseed can move
 * on its own — and NOT to `toolCorrect` or `argsCorrect`, which come out of a
 * greedy, grammar-constrained decode and have no business drifting at all.
 *
 * A baseline is a RATCHET, exactly as the floors in `corpus.test.ts` are: raise
 * it when a change improves the score, and never lower one to make a red run
 * green. A drop here is the harness doing its job.
 */
export function compare(baseline: Baseline, now: Summary, tolerance = 2): Regression[] {
  const out: Regression[] = [];
  const check = (where: string, was: Metrics | undefined, got: Metrics | undefined) => {
    if (!was || !got) return;
    const strict = ['callsCorrect', 'toolCorrect', 'argsCorrect'] as const;
    const loose = ['completed', 'answerCorrect'] as const;
    for (const m of strict) {
      if (got[m] < was[m]) out.push({ where, metric: m, was: was[m], now: got[m] });
    }
    for (const m of loose) {
      if (got[m] < was[m] - tolerance) out.push({ where, metric: m, was: was[m], now: got[m] });
    }
  };
  check('overall', baseline.overall, now.overall);
  for (const tag of Object.keys(baseline.groups)) {
    check(tag, baseline.groups[tag], now.groups[tag]);
  }
  return out;
}
