// The fixture engine: an `Engine` with no weights behind it.
//
// It exists so a prompt or grammar change can be scored in CI. The alternative
// is what this project has been doing — flashing a build to an emulator and
// reading a chat bubble — which cannot tell you whether the change that fixed
// "6pm today" broke the calendar range, and cannot run on a pull request at all.
//
// Two sources, one interface:
//   scripted — canned completions written by hand alongside a scenario. Cheap,
//              deterministic, and the only mode that works before a device has
//              ever run the turn.
//   replay   — a `Trajectory` recorded on a real phone. The completions are what
//              the model actually said, so a harness change is scored against
//              real model behaviour rather than against what we wish it said.
//
// Pure module (zod types only) so the whole thing runs in Node under vitest.
import type { AgentMessage, Engine, GenerateResult } from '@/src/engines/types';

import { parseDecision } from '../grammar';
import { hashMessages, type RecordedGeneration, type ScriptedResponse, type Trajectory } from './types';

/**
 * An `Engine` plus the two counters the score table needs.
 *
 * `generations` is the step count the loop actually spent — the metric that
 * catches a harness churning through four planning turns to reach an answer it
 * had after one. `drifted` counts replayed generations whose prompt no longer
 * hashes to what was recorded, i.e. recordings that have gone stale.
 */
export type FixtureEngine = Engine & {
  readonly generations: number;
  readonly drifted: number;
};

export type FixtureEngineOptions = {
  /** Named in every error this engine throws. A bare "out of responses" in a
   *  60-scenario run tells you nothing about which scenario to go and fix. */
  scenarioId?: string;
  /**
   * Permit canned decisions the grammar could not produce (see
   * `assertProducible`). Strict by default, because the whole value of the
   * corpus rests on replaying only what a real constrained decode could emit.
   *
   * The exception it exists for: the loop's defensive branches — an unknown tool
   * name, an undecodable decision — are reachable in production precisely WHEN
   * the grammar isn't being applied, so testing them requires scripting output
   * the grammar forbids. That is legitimate, and it has to be said out loud
   * rather than being the default.
   */
  allowUnproducible?: boolean;
};

/**
 * The text a `ScriptedResponse.when` is matched against: every message in the
 * prompt, role-tagged, in order.
 *
 * Exported because scenario authors have to be able to predict what their `when`
 * will see. Roles are included so a script can pin the difference between the
 * user asking something and the loop feeding a `Result of <tool>:` line back.
 */
export function renderPrompt(messages: AgentMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

/** The tail of a prompt, for error messages — the whole thing is ~2000 tokens
 *  of catalog and examples, and only the last note says what was being asked. */
function tail(messages: AgentMessage[]): string {
  const last = messages[messages.length - 1];
  return last ? `${last.role}: ${last.content}`.slice(-400) : '(no messages)';
}

function exhausted(scenarioId: string, n: number, messages: AgentMessage[]): Error {
  // Thrown, never returned as ''. An empty completion is a legal thing for a
  // model to produce — the loop has a salvage branch for exactly that — so a
  // fixture that ran dry and returned '' would be scored as a model failure and
  // send whoever reads the table looking for a bug in prompt.ts.
  return new Error(
    `[${scenarioId}] the fixture engine ran out of responses at generation ${n + 1}. ` +
      `The scenario's script is shorter than the turn the loop actually ran. ` +
      `Last prompt message was:\n${tail(messages)}`,
  );
}

function matchesWhen(r: ScriptedResponse, prompt: string): boolean {
  if (r.when === undefined) return false;
  return r.regex ? new RegExp(r.when).test(prompt) : prompt.includes(r.when);
}

/**
 * Replay a hand-written script.
 *
 * Selection is `when` first, order second. A purely positional script breaks the
 * moment the harness adds or removes a generation — and adding or removing a
 * generation is precisely the kind of change this harness is built to evaluate,
 * so a corpus that couldn't survive one would be useless. Each response is
 * consumed at most once, so two turns that render an identical prompt still
 * advance instead of deadlocking on the same entry.
 */
export function scriptedEngine(
  script: ScriptedResponse[],
  opts: FixtureEngineOptions = {},
): FixtureEngine {
  const scenarioId = opts.scenarioId ?? 'scenario';
  const used = new Set<number>();
  let generations = 0;

  const pick = (messages: AgentMessage[]): string => {
    const prompt = renderPrompt(messages);
    for (let i = 0; i < script.length; i++) {
      const r = script[i];
      if (!r || used.has(i)) continue;
      if (matchesWhen(r, prompt)) {
        used.add(i);
        return r.text;
      }
    }
    // Nothing matched by content: fall through to the next unconditional entry.
    // A `when` that never matched is deliberately NOT skipped over here — it
    // stays available for a later generation.
    for (let i = 0; i < script.length; i++) {
      const r = script[i];
      if (!r || used.has(i) || r.when !== undefined) continue;
      used.add(i);
      return r.text;
    }
    throw exhausted(scenarioId, generations, messages);
  };

  return makeEngine({
    next: (messages) => {
      const text = pick(messages);
      generations++;
      return text;
    },
    counts: () => ({ generations, drifted: 0 }),
  }, scenarioId, opts.allowUnproducible);
}

/**
 * Replay a trajectory recorded on a device.
 *
 * Matching is by `promptHash`, not by position: the recording is a fixed list of
 * (prompt, completion) pairs, and the only honest way to reuse it is to check
 * that the prompt being asked about is still the prompt the model saw. When it
 * isn't, the run still proceeds in recorded order — a stale recording is more
 * useful than no signal — but the generation is counted as drifted so the score
 * table can say "these 12 scenarios need re-recording" instead of quietly
 * grading a prompt against a completion produced for a different one.
 */
export function replayEngine(
  trajectory: Trajectory,
  opts: FixtureEngineOptions = {},
): FixtureEngine {
  const scenarioId = opts.scenarioId ?? trajectory.id;
  // Recorded order is `index`, which is what the loop will ask for; sorting
  // makes the fallback independent of how the file happened to be written.
  const ordered = [...trajectory.generations].sort((a, b) => a.index - b.index);
  const used = new Set<RecordedGeneration>();
  let generations = 0;
  let drifted = 0;

  const pick = (messages: AgentMessage[]): string => {
    const hash = hashMessages(messages.map((m) => ({ role: m.role, content: m.content })));
    const hit = ordered.find((g) => !used.has(g) && g.promptHash === hash);
    if (hit) {
      used.add(hit);
      return hit.text;
    }
    const next = ordered.find((g) => !used.has(g));
    if (!next) throw exhausted(scenarioId, generations, messages);
    used.add(next);
    drifted++;
    return next.text;
  };

  return makeEngine({
    next: (messages) => {
      const text = pick(messages);
      generations++;
      return text;
    },
    counts: () => ({ generations, drifted }),
  }, scenarioId, opts.allowUnproducible);
}

/**
 * The exact character sequences the `toolname` rule permits the sampler to emit,
 * or null if the grammar has no such rule.
 *
 * GBNF double quotes DELIMIT a literal rather than being part of it, so
 * `"set_alarm"` permits the bare characters `set_alarm` while `"\"set_alarm\""`
 * permits `"set_alarm"` WITH the quotes. That one level of quoting is the whole
 * difference between valid JSON and garbage, and getting it wrong is not
 * hypothetical here — it shipped, and it broke every tool call in the app.
 */
export function legalToolNames(grammar: string): string[] | null {
  const rule = /^\s*toolname\s*::=(.*)$/m.exec(grammar);
  if (!rule?.[1]) return null;
  return rule[1]
    .split('|')
    .map((alt) => alt.trim())
    .filter((alt) => alt.startsWith('"') && alt.endsWith('"') && alt.length >= 2)
    // Strip the delimiters, then unescape — what's left is what the sampler is
    // actually allowed to produce.
    .map((alt) => alt.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
}

/**
 * Reject a canned completion the constrained sampler could never have produced.
 *
 * Without this the fixture engine ignores the grammar's CONTENT entirely — it
 * reads `opts.grammar` only to decide whether to stream — so a scenario scripts
 * `{"tool": "set_alarm", …}`, the loop parses it happily, and the corpus reports
 * a green run against a grammar that on a real device emits unparseable output
 * and silently degrades every request into a narrated non-action.
 *
 * That is not a hypothetical: it is the exact bug this project shipped, and the
 * 77-scenario corpus was verified to miss it. Replaying decisions the sampler
 * cannot emit turns the whole harness into a check that the SCRIPTS are
 * self-consistent, which is worth nothing.
 *
 * Only the tool-name position is checked. A full GBNF interpreter would be the
 * complete answer and is far more machinery than the failure justifies; the name
 * is where the quoting lives, and it is the alternation the loop builds
 * per-scenario. A malformed decision is deliberately NOT rejected — the loop has
 * a documented fallback for undecodable output, and a scenario is entitled to
 * exercise it.
 */
function assertProducible(scenarioId: string, grammar: string, text: string): void {
  const decision = parseDecision(text);
  if (decision.kind !== 'tool') return;
  const legal = legalToolNames(grammar);
  if (!legal) return;
  // A tool name occupies the `toolname` slot as a JSON string, quotes included.
  const required = JSON.stringify(decision.name);
  if (legal.includes(required)) return;
  throw new Error(
    `[${scenarioId}] the script emits ${required} for the tool name, but this ` +
      `grammar only permits the sampler to emit: ${legal.map((l) => JSON.stringify(l)).join(', ')}. ` +
      `A real constrained decode could not produce this decision, so replaying it ` +
      `would score a grammar bug as a pass. Check buildToolGrammar()'s quoting.`,
  );
}

/** The `Engine` shell both sources share. */
function makeEngine(
  source: {
    next: (messages: AgentMessage[]) => string;
    counts: () => { generations: number; drifted: number };
  },
  scenarioId = 'scenario',
  allowUnproducible = false,
): FixtureEngine {
  const engine: Engine = {
    load: async () => {},
    stop: async () => {},
    unload: async () => {},
    generate: async (messages, onToken, opts): Promise<GenerateResult> => {
      const text = source.next(messages);
      if (opts?.grammar && !allowUnproducible) assertProducible(scenarioId, opts.grammar, text);
      // Only the unconstrained answer turn streams on a real engine; planning
      // decodes control JSON with no token callback. Mirroring that here is what
      // makes the loop's "the stream came up empty" fallback reachable in tests.
      if (!opts?.grammar && text) onToken(text);
      return { text, toolCalls: [] };
    },
  };
  return Object.defineProperties(engine, {
    generations: { get: () => source.counts().generations, enumerable: true },
    drifted: { get: () => source.counts().drifted, enumerable: true },
  }) as FixtureEngine;
}
