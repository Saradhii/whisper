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
import { ablate, applyLayout, type Ablation, type Layout } from './layout';
import type { RealModel } from './model';

export type RealEngineOptions = {
  ablation?: Ablation;
  /** Which prompt arrangement to render. See ./layout.ts. */
  layout?: Layout;
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
  const layout = opts.layout ?? 'current';
  let generations = 0;

  const engine: Engine = {
    load: async () => {},
    stop: async () => {},
    unload: async () => {},
    generate: async (messages, onToken, genOpts): Promise<GenerateResult> => {
      // The presence of a grammar is what distinguishes the two phases, exactly
      // as it does in `LlamaEngine` and in the fixture engine.
      const phase = genOpts?.grammar ? 'plan' : 'answer';

      // Layout first, then ablation: an ablation names a section of the
      // CURRENT prompt, and applying it before the rearrangement would cut from
      // a document that is about to be rebuilt.
      const laid = applyLayout(messages, layout);
      const sent = laid.map((m) => {
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
