// Authoring helpers for the scenario corpus. Data only — zod and the eval
// contract, nothing else — so the corpus imports cleanly into Node with no
// device, no Expo, and no dependency on the runner or the recorder.
//
// The scripts live here rather than in each scenario because getting a replay
// script RIGHT is fiddly and getting it wrong is silent: a mis-keyed script
// makes the fake engine hand back the wrong decision and the scenario scores a
// failure the harness never had. Three facts about the loop drive every matcher
// below, and all three are load-bearing:
//
//   1. `planNote()` is appended AFTER the history for a planning turn and
//      nowhere else, so its tail — "…a tool call, or {"respond": true}." — is
//      present in exactly the planning generations.
//   2. `answerNote()` opens every answer generation with "Now reply to me
//      directly", and a planning prompt never contains it.
//   3. After a call runs, `record()` pushes the RAW decision text back into the
//      conversation. So the decision JSON itself is the cleanest key for "this
//      is the generation AFTER that call" — better than the tool name, which
//      also appears in the worked examples in the system prompt, and better
//      than "You have already called …", which the loop only writes for calls
//      that SUCCEEDED (a denial or a throw never reaches `called.push`).
//
// Matchers are ordered most-specific-first in every script, so the corpus
// behaves the same whether the runner consumes a matched entry or leaves it in
// place. Nothing here depends on generation ORDER — a harness change that adds
// or removes a generation must not invalidate sixty scenarios.
import { z } from 'zod';

import { ScenarioSchema, ScriptedResponseSchema } from '@/src/agent/eval/types';

/** Scenario as AUTHORED: defaults not yet applied. `Scenario` (the exported
 *  type) is the parsed shape, which would demand every optional field. */
export type ScenarioInput = z.input<typeof ScenarioSchema>;
type ScriptedResponse = z.input<typeof ScriptedResponseSchema>;

/** Identity, for the type-check only. Parsing happens in index.ts so a broken
 *  scenario names itself instead of throwing an anonymous zod error. */
export function scenarios(list: ScenarioInput[]): ScenarioInput[] {
  return list;
}

/** Unique to the tail of `planNote()` — present in planning generations only. */
export const PLAN = 'a tool call, or {"respond": true}';

/** Unique to the head of `answerNote()` — present in answer generations only. */
export const ANSWER = 'Now reply to me directly';

/** The loop's own line naming calls that have already SUCCEEDED this turn. Not
 *  written for a denied or a failed call, which is why most scripts key off the
 *  decision text instead. */
export const already = (tool: string) => `You have already called ${tool}`;

export const RESPOND = '{"respond": true}';

/** A decision in the exact shape `buildToolGrammar()` permits. `JSON.stringify`
 *  emits no spaces, which also keeps these strings distinct from the spaced
 *  examples in `examples.ts` — so a decision used as a matcher can only ever
 *  match the real transcript. */
export const call = (tool: string, args: Record<string, unknown> = {}): string =>
  JSON.stringify({ tool, arguments: args });

/**
 * A turn that needs no tool: decide to respond, then answer.
 *
 * Two generations, and the assertion that matters is that the harness adds no
 * third. The removed recover phase used to force a tool here regardless of what
 * the planner decided — "Thanks that is all for now" became a web search — so
 * these scripts are a live tripwire for anything like it coming back.
 */
export function noTool(answer: string): ScriptedResponse[] {
  return [
    { when: ANSWER, text: answer },
    { when: PLAN, text: RESPOND },
  ];
}

/** A turn with exactly one tool call: call, stop, answer. */
export function oneCall(
  tool: string,
  args: Record<string, unknown>,
  answer: string,
): ScriptedResponse[] {
  const decision = call(tool, args);
  return [
    { when: ANSWER, text: answer },
    // The decision is echoed back into the transcript by `record()`, so its
    // presence means the call has been made — whether it returned, threw, or
    // was refused at the confirmation card.
    { when: decision, text: RESPOND },
    { when: PLAN, text: decision },
  ];
}

/**
 * A chain of DIFFERENT calls — look a number up, then text it.
 *
 * Each decision keys the next one, so the chain is driven by what has actually
 * happened rather than by a generation counter.
 */
export function chain(
  calls: { tool: string; args?: Record<string, unknown> }[],
  answer: string,
): ScriptedResponse[] {
  const decisions = calls.map((c) => call(c.tool, c.args ?? {}));
  const steps = decisions.map((d, i) => ({ when: d, text: decisions[i + 1] ?? RESPOND }));
  return [
    { when: ANSWER, text: answer },
    // Reversed: the LAST decision is the most specific key, because by then
    // every earlier decision is in the transcript too.
    ...steps.reverse(),
    { when: PLAN, text: decisions[0] ?? RESPOND },
  ];
}

/**
 * A planner that decides the SAME call twice — the naive behaviour repeat
 * suppression exists to absorb.
 *
 * Keyed on "You have already called", which the loop writes only after the
 * first call succeeded: that is precisely the prompt where the observed device
 * failure re-emitted the call anyway, five times for a calendar read and twice
 * for an alarm the phone then actually set twice.
 */
export function repeatCall(
  tool: string,
  args: Record<string, unknown>,
  answer: string,
): ScriptedResponse[] {
  const decision = call(tool, args);
  return [
    { when: ANSWER, text: answer },
    { when: already(tool), text: decision },
    { when: PLAN, text: decision },
  ];
}

/**
 * A planner that retries a call the user REFUSED.
 *
 * A denial never reaches `called.push`, so there is no "already called" line to
 * key on — the decision text is the only evidence in the prompt that the card
 * was ever shown. The retry must be suppressed and the answer must still not
 * claim the action happened.
 */
export function retryCall(
  tool: string,
  args: Record<string, unknown>,
  answer: string,
): ScriptedResponse[] {
  const decision = call(tool, args);
  return [
    { when: ANSWER, text: answer },
    { when: decision, text: decision },
    { when: PLAN, text: decision },
  ];
}
