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
import type { AgentMessage, ChatMessage, Engine } from '@/src/engines/types';

import * as Recorder from './eval/recorder';
import { buildToolGrammar, parseDecision } from './grammar';
import { answerNote, planNote, systemPrompt } from './prompt';
import * as Trace from './trace';
import { InvalidArguments, type AnyTool } from './types';

/** Planning turns per message. A chain that needs more than "look something up,
 *  then act on it" is beyond what a 1-2B planner does reliably anyway. */
const MAX_STEPS = 4;

/** Calls of one tool per turn. Two allows "text Arun and Priya"; the cap exists
 *  because arguments that differ only slightly (a calendar range shifted by a
 *  day) slip past exact-repeat suppression and would otherwise burn MAX_STEPS. */
const MAX_CALLS_PER_TOOL = 2;

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

export async function runAgent(
  engine: Engine,
  tools: AnyTool[],
  history: ChatMessage[],
  { onEvent, confirm, signal }: AgentCallbacks,
  now: Date = new Date(),
): Promise<void> {
  // The user's own words, repeated in the planning note so the decision is made
  // next to the request rather than next to the reference block.
  const lastRequest = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
  const byName = new Map(tools.map((t) => [t.name, t]));
  const names = tools.map((t) => t.name);
  const grammar = buildToolGrammar(names);
  const messages: AgentMessage[] = [
    { role: 'system', content: systemPrompt(tools, now) },
    ...history,
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

  const aborted = () => !!signal?.aborted;

  /** One grammar-constrained planning turn. */
  const plan = async (g: string) => {
    const started = Date.now();
    const prompt = [...messages, planNote(now, called, lastRequest)];
    const res = await engine.generate(prompt, () => {}, {
      grammar: g,
      disableThinking: true,
      maxTokens: PLAN_MAX_TOKENS,
      temperature: PLAN_TEMPERATURE,
    });
    const ms = Date.now() - started;
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
      record(raw, name, `this call was already made and it returned: ${outcomes.get(sig)}. Do not call it again; answer using that.`);
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
        results.push(result);
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
      Trace.add('plan', `${forced ? 'forced ' : ''}call ${decision.name}`, { detail: res.text, ms });
    } else if (decision.malformed) {
      Trace.add('error', 'undecodable decision — grammar may not be applied', {
        detail: res.text,
        ms,
      });
    } else {
      Trace.add('plan', 'respond without acting', { detail: res.text, ms });
    }
    if (decision.kind === 'respond') return false;

    return (await execute(decision.name, decision.arguments, res.text)) !== 'exhausted';
  };

  // --- plan: constrained decisions, no streaming (the output is control JSON) -
  for (let i = 0; i < MAX_STEPS; i++) {
    if (aborted()) {
      Recorder.abandon(); // a cancelled turn never answered; it is not a trajectory
      return;
    }
    if (!(await step(i, grammar))) break;
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
  messages.push(answerNote({ ran, acted, failed: failures, denied: denials }));
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

  Trace.add('answer', `answered after ${ran} tool call(s)`, {
    detail: `${(streamed || res.text).trim().length} chars`,
    ms: Date.now() - started,
  });
  Recorder.finishTurn((streamed || res.text).trim());
}
