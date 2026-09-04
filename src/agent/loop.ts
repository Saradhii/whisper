// The agent loop, grammar-constrained. Each planning turn is forced (via GBNF)
// to emit exactly one decision: call a named tool, or respond to the user.
// This is the mechanism behind reliable on-device tool use (LiteRT-LM / AI Edge
// Gallery do the same) — the model literally cannot narrate fake success where
// a structured decision is required. Once planning is done, a final
// UNCONSTRAINED turn streams a natural-language answer to the user.
//
// The turn has three phases, in order:
//   plan    — decide and execute, up to MAX_STEPS times
//   answer  — one unconstrained, streamed reply
//   salvage — if that reply came back empty, say what actually happened
//
// What the loop says to the model lives in prompt.ts; this file is only about
// when. Pure orchestration (engine + tools injected) so it unit-tests in Node.
import type {
  AgentMessage,
  ChatMessage,
  Engine,
  GenerateTimings,
} from '@/src/engines/types';

import * as Recorder from './eval/recorder';
import { divergence, promptSize } from './eval/promptSize';
import { buildToolGrammar, parseDecision } from './grammar';
import { skipsPlanning } from './fastPath';
import { agentPrefix, answerNote, planInstruction, turnReference } from './prompt';
import * as Trace from './trace';
import { InvalidArguments, type AnyTool } from './types';

/** Planning turns per message. A chain that needs more than "look something up,
 *  then act on it" is beyond what a 1-2B planner does reliably anyway. */
const MAX_STEPS = 4;

/** Calls of one tool per turn. Two allows "text Arun and Priya"; the cap exists
 *  because arguments that differ only slightly (a calendar range shifted by a
 *  day) slip past exact-repeat suppression and would otherwise burn MAX_STEPS. */
const MAX_CALLS_PER_TOOL = 2;

/**
 * Tool results are bounded in TOKENS, per turn.
 *
 * Every executor used to bound its own output in characters or rows — 4000
 * chars for web_fetch, 20 calendar rows, 5 search hits with no per-row bound at
 * all — and none of those units are the one the context window is measured in.
 * A real page through web_fetch's 4000-char slice measures 1043 Qwen3 tokens,
 * which is more than the whole turn has to spend.
 *
 * The arithmetic, at a planning step, is:
 *   system(1804) + history(1280) + turnReference(~70) + accumulated
 *     + planInstruction(~45) + generate(256)
 * against nCtx 4096, leaving ~640 tokens for everything the turn accumulates.
 * Decisions and per-message template overhead take ~140 of that across four
 * steps, so the results themselves get ~320.
 *
 * Overflowing is not a soft failure. `ctx_shift` discards from the FRONT and
 * llama.rn does not expose `n_keep`, so the first thing evicted is the system
 * prompt — the tool catalog and the JSON protocol. The grammar keeps the output
 * well-formed, so the model goes on emitting valid tool calls chosen from a
 * catalog it can no longer see. Bounding here is what keeps that unreachable.
 */
const TURN_RESULT_TOKENS = 320;

/** Never clamp a result below this — a result cut to nothing is worse than a
 *  long one, because the model then answers from the request alone. */
const MIN_RESULT_TOKENS = 64;

/**
 * Chars per token, deliberately LOW. Real Qwen3 measures 3.84 on web text and
 * ~3.5 on prose, so dividing a token budget by 3 yields a character budget that
 * under-spends it. Erring the other way would put the clamp above the real
 * limit and defeat the point.
 */
const CHARS_PER_TOKEN = 3;

/** Roughly how many tokens `text` costs. Deliberately an over-estimate. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Cut `text` to at most `budgetTokens`, on a word boundary, marking the cut.
 *
 * The marker is not cosmetic: without it the model presents a truncated page as
 * the whole of what it read, which is the same class of dishonesty the answer
 * note exists to prevent.
 */
export function clampResult(text: string, budgetTokens: number): string {
  const budget = Math.max(MIN_RESULT_TOKENS, budgetTokens);
  const maxChars = budget * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut}… [truncated to fit the context window — this is only the beginning of the result]`;
}

// Planning is CONTROL FLOW, not prose. Sampling it at the chat temperature
// (0.7) means the choice between "call set_alarm" and "answer without acting"
// gets rolled on every turn — which is exactly how a request to set an alarm
// ends up as a chatty "I will set an alarm for 7" and no alarm. Decisions are
// decoded greedily; only the user-facing answer is sampled.
const PLAN_TEMPERATURE = 0;
// A decision object is tiny — cap it so a stray token stream can't run away.
const PLAN_MAX_TOKENS = 256;
// The answer is asked for in one or two sentences. Capping it keeps the whole
// turn inside the context reserve (see TOOL_PROMPT_RESERVE) and bounds the
// worst case, where a small model starts re-listing raw tool output forever.
const ANSWER_MAX_TOKENS = 320;

export type AgentEvent =
  | { type: 'token'; token: string }
  | {
      type: 'tool';
      /** Tool key (e.g. 'list_calendar_events') — lets the UI pick an icon. */
      name: string;
      label: string;
      status: 'running' | 'done' | 'denied' | 'error';
    }
  | {
      /** A planning decision, surfaced in the chat as a collapsible row so the
       *  user can see the agent choose to act (or not) instead of guessing. */
      type: 'plan';
      step: number;
      /** Raw decision JSON as the model emitted it. */
      text: string;
      /** True when planning was re-run under the tool-only grammar. */
      forced?: boolean;
    };

export type AgentCallbacks = {
  onEvent: (e: AgentEvent) => void;
  /** Ask the user to approve a side-effecting action. `name` is the tool key,
   *  so the confirmation UI can show the same glyph as the resulting chip. */
  confirm: (summary: string, name: string) => Promise<boolean>;
  /** Cooperative cancellation: the caller sets `aborted` (alongside
   *  engine.stop(), which only interrupts the CURRENT completion) and the loop
   *  exits between steps instead of planning further or answering. */
  signal?: { aborted: boolean };
};

/** What executing one decision did to the turn. */
type Outcome =
  /** The tool ran (or the user denied it) — the conversation moved on. */
  | 'acted'
  /** Nothing happened and nothing will: this exact call was already made, or
   *  the tool has been called as often as it may be. Planning again can only
   *  reproduce the result we are already holding. */
  | 'exhausted'
  /** The decision was unusable (unknown tool); let the planner try again. */
  | 'rejected';

/** Order-independent identity for a call, so `{a,b}` and `{b,a}` are one call. */
function signature(name: string, args: Record<string, unknown>): string {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(rec[k])}`).join(',')}}`;
  };
  return `${name}${stable(args)}`;
}

/**
 * llama.cpp's own numbers for one generation, condensed for a trace row.
 * `cached` is the one that matters: it says how much of the prompt was reused
 * rather than re-evaluated, which is the difference between a turn that is
 * slow because it is thinking and one that is slow because it threw away a
 * prefix it already had.
 */
function timingLabel(t?: GenerateTimings): string {
  if (!t) return '';
  const pps = t.promptMs > 0 ? Math.round((t.promptTokens / t.promptMs) * 1000) : 0;
  const tps = t.predictedMs > 0 ? Math.round((t.predictedTokens / t.predictedMs) * 1000) : 0;
  return (
    ` [cache ${t.cached} | prefill ${t.promptTokens}tok ${t.promptMs}ms ${pps}t/s` +
    ` | decode ${t.predictedTokens}tok ${t.predictedMs}ms ${tps}t/s]`
  );
}

/**
 * Character-level attribution for the same prefill, alongside llama.cpp's own
 * token-level counters.
 *
 * `n_past` in logcat says HOW MUCH a generation re-evaluated; nothing on the
 * device says WHAT. A reading of the emulator log put one turn's rebuilt tail
 * at ~720 tokens, which is four times anything rendering this module's output
 * in Node can account for — so the difference is in the conversation, the tool
 * traffic, or the template, and there was no way to tell which. This closes
 * that: it names how many characters are new and how many whole messages the
 * prompt still shares with the last one.
 *
 * Rendered only while the developer trace is recording, because it stringifies
 * the entire prompt.
 */
function tailTracker() {
  let last: AgentMessage[] = [];
  return (prompt: AgentMessage[]): string => {
    const prev = last;
    last = prompt;
    if (!Trace.isEnabled()) return '';
    const d = divergence(prev, prompt);
    return (
      ` [new ${d.reEvaluatedChars}c of ${promptSize(prompt).chars}c` +
      ` | shares ${d.sharedMessages}/${prompt.length} msgs]`
    );
  };
}

export async function runAgent(
  engine: Engine,
  tools: AnyTool[],
  history: ChatMessage[],
  { onEvent, confirm, signal }: AgentCallbacks,
  now: Date = new Date(),
): Promise<void> {
  // The user's own words, repeated in the turn reference so the decision is
  // made next to the request rather than next to the reference block.
  const lastRequest = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
  const byName = new Map(tools.map((t) => [t.name, t]));
  const names = tools.map((t) => t.name);
  const grammar = buildToolGrammar(names);

  // A greeting is not a decision — see fastPath.ts, and the "plan" phase below.
  // Decided here rather than at the loop, because it also decides whether the
  // turn needs a reference block at all.
  const plans = !skipsPlanning(lastRequest);

  // THE PROMPT IS APPEND-ONLY FROM HERE DOWN. `messages` is built once and only
  // ever grown; each generation renders it plus ONE trailing instruction. That
  // is what lets llama.cpp serve every earlier token from the KV cache instead
  // of re-evaluating the turn from the history onwards on every step.
  //
  // The reference block is omitted entirely on the fast path. It is 250-odd
  // characters the answer would have to evaluate for a "thanks", and a greeting
  // is the one turn shape whose whole point is that it costs a single
  // generation. A turn that never plans has no decision for a clock to inform.
  const messages: AgentMessage[] = [
    ...agentPrefix(tools, now),
    ...history,
    ...(plans ? [turnReference(now, lastRequest)] : []),
  ];

  // Corpus capture for the eval harness (eval/recorder.ts). Off by default and
  // a no-op until the user turns it on; the loop never branches on it, so the
  // recorded turn is the turn that actually ran.
  Recorder.startTurn(lastRequest);

  // Turn state. `ran` counts tools that returned something; `acted` narrows
  // that to the ones that CHANGED something. Both feed the answer note, which
  // is where honesty about the turn is enforced.
  // Call signature → how it settled. 'settled' means the call produced an
  // answer (a result, or a refusal the user gave) and must never run again;
  // 'failed' means it threw and so produced nothing, which a retry can fix.
  const spent = new Map<string, 'settled' | 'failed'>();
  const callCount = new Map<string, number>(); // per tool name
  const called: string[] = []; // tool names, in order, for the plan note
  const results: string[] = []; // plain-language results, for the salvage phase
  const failures: string[] = []; // error text, so the answer can't invent a result
  const denials: string[] = []; // labels the user refused, so the answer can't claim them
  const outcomes = new Map<string, string>(); // signature -> what the call returned
  let ran = 0;
  let acted = false; // a tool that CHANGED something succeeded
  // Tokens of tool output already committed to `messages` this turn. Every
  // result is clamped to what is LEFT, so four small results and one huge one
  // are both bounded by the same total.
  let resultTokensSpent = 0;

  const aborted = () => !!signal?.aborted;

  // Timings of the most recent generation, folded into its trace row.
  let planTimings: GenerateTimings | undefined;
  // How much of that generation's prompt was new, in characters. Reset per
  // turn, because the previous turn's prompt is what the cache is holding.
  const tail = tailTracker();
  let planTail = '';

  /** One grammar-constrained planning turn. */
  const plan = async (g: string) => {
    const started = Date.now();
    const prompt = [...messages, planInstruction(called)];
    planTail = tail(prompt);
    const res = await engine.generate(prompt, () => {}, {
      grammar: g,
      disableThinking: true,
      maxTokens: PLAN_MAX_TOKENS,
      temperature: PLAN_TEMPERATURE,
    });
    const ms = Date.now() - started;
    planTimings = res.timings;
    Recorder.generation(
      'plan',
      prompt,
      { grammar: g, temperature: PLAN_TEMPERATURE, maxTokens: PLAN_MAX_TOKENS },
      res.text,
      ms,
    );
    return { res, ms };
  };

  /** Record a decision and what came back, in the shape the examples teach:
   *  the raw decision as the assistant said it, then `Result of <name>: ...`. */
  const record = (decision: string, name: string, result: string) => {
    messages.push({ role: 'assistant', content: decision });
    messages.push({ role: 'user', content: `Result of ${name}: ${result}` });
  };

  /** Execute one decided tool call, feeding the result back into `messages`. */
  const execute = async (
    name: string,
    args: Record<string, unknown>,
    raw: string,
  ): Promise<Outcome> => {
    const tool = byName.get(name);
    if (!tool) {
      Trace.add('warn', `unknown tool: ${name}`);
      record(raw, name, 'that tool does not exist. Use one from the list, or answer.');
      return 'rejected';
    }

    // --- repeat suppression -------------------------------------------------
    // The failure this exists for, seen on device: the planner decides
    // list_calendar_events, reads its own result, and — the context still
    // looking exactly like a request to read the calendar — decides it again,
    // until MAX_STEPS runs out. Five identical chips, five identical reads.
    // With set_alarm the same loop is worse than noisy: the phone ends up with
    // two alarms, because the tool genuinely fires each time. A repeat cannot
    // produce information we do not already have, so it never reaches the tool.
    //
    // The one exception is a call that THREW. Then the repeat is not a repeat
    // of an answer, it is a retry of something that never produced one, and the
    // world may well have changed in between — the permission the user just
    // granted, the network coming back. It gets exactly one more go.
    const sig = signature(name, args);
    const prior = spent.get(sig);
    const used = callCount.get(name) ?? 0;
    if (prior === 'settled') {
      Trace.add('warn', `suppressed repeat call: ${name}`, { detail: raw });
      // Wording matters more than it looks. "You already made this exact call"
      // reads as confirmation of SUCCESS — after a denial the model turned it
      // into "I already scheduled the reminder." Restate the actual outcome.
      // The prior result is already in the prompt above; restating it in full
      // doubled a single web_fetch to ~2000 tokens. An excerpt keeps the
      // wording honest about the OUTCOME (a denial must not read as success)
      // without paying for the content twice.
      record(
        raw,
        name,
        `this call was already made and it returned: ${clampResult(outcomes.get(sig) ?? '', MIN_RESULT_TOKENS)}. Do not call it again; answer using that.`,
      );
      return 'exhausted';
    }
    if (prior === 'failed' && used >= 2) {
      Trace.add('warn', `${name} failed twice — not retrying`, { detail: raw });
      record(raw, name, 'this call has already failed twice. Tell the user it did not work.');
      return 'exhausted';
    }
    if (used >= MAX_CALLS_PER_TOOL) {
      Trace.add('warn', `${name} hit its per-turn call limit`, { detail: raw });
      record(raw, name, 'you have called this tool enough times. Answer with what you have.');
      return 'exhausted';
    }
    callCount.set(name, used + 1);

    const label = tool.label(args);
    let result: string;
    // Recorder bookkeeping only. `toolMs` stays 0 for a denial: that time is
    // the user reading a confirmation card, and folding it into the tool budget
    // would make the Phase 2 latency numbers meaningless.
    let status: 'done' | 'denied' | 'error' = 'done';
    let toolMs = 0;
    if (tool.requiresConfirmation && !(await confirm(label, name))) {
      onEvent({ type: 'tool', name, label, status: 'denied' });
      Trace.add('tool', `${name} denied by user`, { detail: label });
      // Settled, not failed: the retry path must never reopen a refusal.
      spent.set(sig, 'settled');
      denials.push(label);
      status = 'denied';
      result = 'The user REFUSED this action, so it did NOT happen. Do not retry it and do not claim you did it; ask what they want instead.';
    } else {
      onEvent({ type: 'tool', name, label, status: 'running' });
      const started = Date.now();
      try {
        result = await tool.run(args);
        ran++;
        if (tool.mutates) acted = true;
        spent.set(sig, 'settled');
        called.push(name);
        onEvent({ type: 'tool', name, label, status: 'done' });
        Trace.add('tool', `${name} ok`, { detail: result.slice(0, 400), ms: Date.now() - started });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        result = `Tool error: ${why}`;
        // Bad arguments are settled, not failed: retrying them unchanged would
        // fail identically. The model has to send different ones, which is a
        // different signature and therefore allowed anyway.
        spent.set(sig, e instanceof InvalidArguments ? 'settled' : 'failed');
        failures.push(why);
        status = 'error';
        onEvent({ type: 'tool', name, label, status: 'error' });
        Trace.add('error', `${name} threw`, { detail: result, ms: Date.now() - started });
      }
      toolMs = Date.now() - started;
    }
    // Single choke point: clamp once, then use the clamped text everywhere it
    // is remembered (prompt, repeat-suppression, salvage) so no path can
    // reintroduce the full string later.
    result = clampResult(result, TURN_RESULT_TOKENS - resultTokensSpent);
    resultTokensSpent += approxTokens(result);
    if (status === 'done') results.push(result);
    outcomes.set(sig, result);
    Recorder.toolCall(name, args, status, result, toolMs);
    record(raw, name, result);
    return 'acted';
  };

  /** Plan once, surface the decision, and act on it. Returns false to stop. */
  const step = async (index: number, g: string, forced = false): Promise<boolean> => {
    const { res, ms } = await plan(g);
    if (aborted()) return false;

    const decision = parseDecision(res.text);
    onEvent({ type: 'plan', step: index, text: res.text, ...(forced ? { forced } : {}) });
    // A decision we couldn't read is traced as an ERROR, not a plan: it means
    // the grammar isn't constraining the sampler, which is a different (and
    // much worse) problem than the model choosing to answer.
    if (decision.kind === 'tool') {
      Trace.add('plan', `${forced ? 'forced ' : ''}call ${decision.name}${timingLabel(planTimings)}${planTail}`, {
        detail: res.text,
        ms,
      });
    } else if (decision.malformed) {
      Trace.add('error', 'undecodable decision — grammar may not be applied', {
        detail: res.text,
        ms,
      });
    } else {
      Trace.add('plan', `respond without acting${timingLabel(planTimings)}${planTail}`, {
        detail: res.text,
        ms,
      });
    }
    if (decision.kind === 'respond') return false;

    return (await execute(decision.name, decision.arguments, res.text)) !== 'exhausted';
  };

  // --- plan: constrained decisions, no streaming (the output is control JSON) -
  //
  // A greeting is not a decision. Planning "hi" costs a 305-token re-prefill
  // (8.1s on the test AVD) to emit {"respond": true}, which is two thirds of
  // the whole turn — so a message that is certainly just conversation goes
  // straight to the answer. The gate is a closed pleasantry vocabulary and
  // fails toward planning; see fastPath.ts for why it is built that way, and
  // fastPath.test.ts for the property that keeps it honest.
  if (!plans) {
    Trace.add('plan', 'skipped planning — conversational turn', { detail: lastRequest, ms: 0 });
  } else {
    for (let i = 0; i < MAX_STEPS; i++) {
      if (aborted()) {
        Recorder.abandon(); // a cancelled turn never answered; it is not a trajectory
        return;
      }
      if (!(await step(i, grammar))) break;
    }
  }

  // There used to be a "recover" phase here: when the planner chose not to act,
  // a yes/no probe asked whether the user had in fact requested an action, and
  // on yes the turn re-planned under a grammar with the `respond` option
  // removed, so the only legal continuation was a tool call. It was written
  // when a GBNF quoting bug meant tool calls never parsed and every request was
  // answered with a promise to act.
  //
  // With the grammar fixed and the worked examples in place, the planner picks
  // the tool by itself on every action request that has been tried on a device
  // — alarm, reminder, calendar, contacts, SMS, email. The probe, meanwhile,
  // fired on conversational turns and forced a tool where none belonged:
  // "Thanks that is all for now" became a web search for "current time",
  // because a grammar with no `respond` alternative leaves nothing else to emit.
  // It cost an extra generation on every chat turn to make chat worse, so it is
  // gone. If narrated-instead-of-acted ever comes back, this is where it lived.

  // --- answer: unconstrained, streamed to the user ---------------------------
  if (aborted()) {
    Recorder.abandon();
    return;
  }
  // The answer prompt is the last planning prompt with its trailing instruction
  // swapped for this one — same system prefix, same reference block, same
  // decisions and results, in the same order. That is what makes the answer
  // phase cost its own note and nothing else: measured warm, it re-evaluates
  // ~335 characters where the plan phase before it built ~2000.
  messages.push(answerNote({ ran, acted, failed: failures, denied: denials }));
  const answerTail = tail(messages);
  const started = Date.now();
  let streamed = '';
  const res = await engine.generate(
    messages,
    (token) => {
      streamed += token;
      onEvent({ type: 'token', token });
    },
    { disableThinking: true, maxTokens: ANSWER_MAX_TOKENS },
  );
  Recorder.generation(
    'answer',
    messages,
    { maxTokens: ANSWER_MAX_TOKENS },
    res.text,
    Date.now() - started,
  );

  // The token callback is best-effort — llama.rn only forwards a partial when
  // the native side emits one, and the completion can resolve with text that
  // never streamed. Relying on the callback alone is why a turn could execute a
  // tool correctly and then show the user nothing at all. The returned text is
  // the source of truth; emit it if the stream came up empty.
  if (!streamed.trim() && res.text.trim()) {
    onEvent({ type: 'token', token: res.text });
  }

  // --- salvage: the model really did return nothing --------------------------
  // A turn that changed the world (an alarm now exists) must never end in
  // silence, so report the results we are already holding rather than leaving
  // the user with a bare chip.
  if (!streamed.trim() && !res.text.trim()) {
    Trace.add('warn', 'final answer was empty', { ms: Date.now() - started });
    const salvaged = results.length
      ? results.join(' ')
      : failures.length
        ? `Sorry — that didn't work: ${failures[0]}`
        : 'Sorry — I could not put a reply together. Please try again.';
    onEvent({ type: 'token', token: salvaged });
    Recorder.finishTurn(salvaged);
    return;
  }

  Trace.add('answer', `answered after ${ran} tool call(s)${timingLabel(res.timings)}${answerTail}`, {
    detail: `${(streamed || res.text).trim().length} chars`,
    ms: Date.now() - started,
  });
  Recorder.finishTurn((streamed || res.text).trim());
}
