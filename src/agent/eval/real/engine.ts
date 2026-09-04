// A `FixtureEngine` backed by the real model, so the existing corpus runner can
// drive a real planner without knowing the difference.
//
// ACCURACY ONLY — see the banner in ./model.ts. Nothing here may be used to
// support a latency claim.
//
// The whole design of this file is "change as little as possible". `runScenario`
// already freezes the clock, rebuilds the world, and scores tools and arguments
// separately; `scoreAll` already takes a `makeEngine` factory. So the real
// planner slots in at exactly one seam and every expectation in
// `src/agent/eval/scenarios/` is reused verbatim. Re-implementing the corpus, or
// the prompt, would only test the copy.
import type { AgentMessage, Engine, GenerateResult } from '@/src/engines/types';

import type { FixtureEngine } from '../engine';
import type { RealModel } from './model';

/**
 * A deliberate mutilation of the prompt, applied on the way to the model.
 *
 * This exists because of a standard this project set for itself: a harness that
 * cannot reproduce a known bug is not yet a gate. The date table in
 * `planNote()` was added to fix a specific, documented class of failure — "in an
 * hour" at 13:09 coming back as 13:09, "6pm today" as 16:00, "Friday at 1pm"
 * landing on Monday noon. If removing it does NOT move the score, then the score
 * is not sensitive to the thing the corpus most needs to protect, and no green
 * run from it means anything.
 *
 * It is applied HERE, at the engine boundary, and not by editing `prompt.ts`:
 * the ablation must be a property of one eval run, not a diff someone can
 * forget to revert. The app's runtime code is never touched.
 */
export type Ablation =
  /** Ship exactly what `prompt.ts` renders. */
  | 'none'
  /** Drop the seven-day date list and the "this week means" span, keeping the
   *  wall clock and the relative-time lines. Isolates the date TABLE. */
  | 'dates'
  /** Drop the entire reference block after the clock — date table and
   *  relative-time anchors both. The full "no lookup table" condition. */
  | 'anchors';

export const ABLATIONS: Ablation[] = ['none', 'dates', 'anchors'];

// Landmarks copied from `anchors()` / `planNote()` in src/agent/prompt.ts.
// Deliberately plain string search, never a regex: an ablation that silently
// matched nothing would report "removing the date table changed no scores",
// which is the single most misleading result this harness could produce. So a
// miss is loud — see `ablate()`.
const TABLE_START = 'Dates: ';
const RELATIVE_START = 'Use ONLY if I say';
const BLOCK_END = ']';

/**
 * Cut the requested section out of a plan note.
 *
 * Returns `null` when the message is not a plan note (the system message, the
 * user's own turn, a tool result), so the caller can tell "nothing to do here"
 * apart from "the landmark moved".
 */
export function ablate(content: string, mode: Ablation): string | null {
  if (mode === 'none') return null;
  const start = content.indexOf(TABLE_START);
  if (start < 0) return null;
  const end =
    mode === 'dates' ? content.indexOf(RELATIVE_START, start) : content.indexOf(BLOCK_END, start);
  if (end < 0) {
    throw new Error(
      `ablation "${mode}" found ${JSON.stringify(TABLE_START)} but not its end marker ` +
        `${JSON.stringify(mode === 'dates' ? RELATIVE_START : BLOCK_END)}. planNote() has been ` +
        `reworded — update the landmarks in src/agent/eval/real/engine.ts, because an ` +
        `ablation that quietly removes nothing would report a regression test as passing.`,
    );
  }
  return content.slice(0, start) + content.slice(end);
}

export type RealEngineOptions = {
  ablation?: Ablation;
  /** Fixed sampler seed. The planning phase runs at temperature 0 and is greedy
   *  regardless; this pins the UNCONSTRAINED answer phase, which the app samples
   *  at 0.7 and which would otherwise vary between runs for reasons that have
   *  nothing to do with the change under test. */
  seed?: number;
  /** Called with every generation, for a transcript when a scenario surprises
   *  you. Scoring never depends on it. */
  onGeneration?: (g: {
    phase: 'plan' | 'answer';
    prompt: AgentMessage[];
    text: string;
    ms: number;
  }) => void;
};

/**
 * Wrap a loaded model as the `Engine` the agent loop expects.
 *
 * `drifted` is always 0: drift is a REPLAY concept — it counts recordings whose
 * prompt no longer hashes to what was captured. A live planner sees whatever the
 * prompt is today, so there is nothing to be stale against.
 */
export function realEngine(model: RealModel, opts: RealEngineOptions = {}): FixtureEngine {
  const ablation = opts.ablation ?? 'none';
  let generations = 0;

  const engine: Engine = {
    load: async () => {},
    stop: async () => {},
    unload: async () => {},
    generate: async (messages, onToken, genOpts): Promise<GenerateResult> => {
      // The presence of a grammar is what distinguishes the two phases, exactly
      // as it does in `LlamaEngine` and in the fixture engine.
      const phase = genOpts?.grammar ? 'plan' : 'answer';

      const sent = messages.map((m) => {
        const cut = ablate(m.content, ablation);
        return cut === null ? m : { ...m, content: cut };
      });

      const started = Date.now();
      const text = await model.complete(
        sent.map((m) => ({ role: m.role, content: m.content })),
        {
          ...(genOpts?.grammar ? { grammar: genOpts.grammar } : {}),
          maxTokens: genOpts?.maxTokens,
          // Defaulting to 0.7 mirrors `LlamaEngine.doGenerate()`, which is what
          // the answer phase actually gets on device — the loop passes no
          // temperature there.
          temperature: genOpts?.temperature ?? 0.7,
          ...(opts.seed === undefined ? {} : { seed: opts.seed }),
          disableThinking: genOpts?.disableThinking,
        },
      );
      const ms = Date.now() - started;
      generations++;
      opts.onGeneration?.({ phase, prompt: sent, text, ms });

      // Emit the answer in one chunk when unconstrained, which is what the
      // fixture engine does. Matching it keeps a real score and a replay score
      // comparable: `runScenario` reconstructs the answer from token events, and
      // a differently-chunked stream would join to a different string.
      if (!genOpts?.grammar && text) onToken(text);
      return { text, toolCalls: [] };
    },
  };

  return Object.defineProperties(engine, {
    generations: { get: () => generations, enumerable: true },
    drifted: { get: () => 0, enumerable: true },
  }) as FixtureEngine;
}
