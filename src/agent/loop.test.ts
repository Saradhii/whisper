import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentMessage, Engine, GenerateResult } from '@/src/engines/types';
import { runAgent, type AgentEvent } from './loop';
import { defineTool } from './types';

type Seen = {
  messages: AgentMessage[];
  grammar: boolean;
  /** The grammar text, so tests can assert on the respond escape hatch. */
  grammarText?: string;
  temperature?: number;
};

// Fake engine: replays a scripted list of decision/answer texts and records
// every message list + options it receives. Planning turns are grammar-
// constrained (opts.grammar set); the final turn streams (onToken).
function fakeEngine(script: string[]) {
  const seen: Seen[] = [];
  let turn = 0;
  const engine: Engine = {
    load: async () => {},
    stop: async () => {},
    unload: async () => {},
    generate: async (messages, onToken, opts) => {
      seen.push({
        messages: JSON.parse(JSON.stringify(messages)),
        grammar: !!opts?.grammar,
        ...(opts?.grammar ? { grammarText: opts.grammar } : {}),
        ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
      const text = script[Math.min(turn++, script.length - 1)]!;
      if (!opts?.grammar && text) onToken(text); // final turn streams
      const res: GenerateResult = { text, toolCalls: [] };
      return res;
    },
  };
  return { engine, seen };
}

const echoTool = defineTool({
  name: 'echo',
  description: 'echo',
  params: z.object({ text: z.string() }),
  label: (a) => `Echo ${a.text}`,
  execute: async (a) => `echoed: ${a.text}`,
});

const guardedTool = defineTool({
  name: 'guarded',
  description: 'needs confirmation',
  params: z.object({}),
  label: () => 'Guarded action',
  requiresConfirmation: true,
  execute: async () => 'did the thing',
});

const cb = (events: AgentEvent[], allow = true) => ({
  onEvent: (e: AgentEvent) => events.push(e),
  confirm: async () => allow,
});

/** Turns that carry a grammar are planning/check turns; the last is the answer. */
const planning = (seen: Seen[]) => seen.filter((s) => s.grammar);
const finalTurn = (seen: Seen[]) => seen.filter((s) => !s.grammar);
/** The recovery grammar: tool calls only, no `respond` alternative. (The yes/no
 *  check grammar also lacks "respond", hence the toolcall requirement.) */
const forcedPlan = (seen: Seen[]) =>
  seen.filter((s) => s.grammarText?.includes('toolcall') && !s.grammarText.includes('respond'));

describe('runAgent (grammar-constrained)', () => {
  it('answers directly when the model responds without a tool', async () => {
    // respond → final answer. No probe in between: the forced-tool recovery
    // phase was removed after it started overriding correct decisions.
    const { engine, seen } = fakeEngine(['{"respond": true}', 'hi there']);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'hi' }], cb(events));
    expect(seen[0]!.grammar).toBe(true); // decision
    expect(finalTurn(seen)).toHaveLength(1); // exactly one unconstrained turn
    expect(events).toContainEqual({ type: 'token', token: 'hi there' });
  });

  it('decodes planning decisions greedily, not at the chat temperature', async () => {
    // Sampling the decision at 0.7 is what let "set an alarm" become a promise
    // to set one — every planning turn must be temperature 0.
    const { engine, seen } = fakeEngine(['{"respond": true}', 'hi']);
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'hi' }], cb([]));
    for (const turn of planning(seen)) expect(turn.temperature).toBe(0);
  });

  it('puts the wall clock in the planning turn, not the cached system prefix', async () => {
    const { engine, seen } = fakeEngine(['{"respond": true}', 'hi']);
    const at = new Date('2026-08-02T09:30:00Z');
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'hi' }], cb([]), at);
    const system = seen[0]!.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('2026-08-02');
    // The trailing note carries the clock so the stable prefix stays stable.
    const note = seen[0]!.messages[seen[0]!.messages.length - 1]!;
    expect(note.content).toMatch(/Reference, not a request/);
    expect(note.content).toContain('Sunday');
    // …and the user's own words are repeated last, next to the decision.
    expect(note.content).toContain('"hi"');
  });

  it('emits a plan event for every decision', async () => {
    const { engine } = fakeEngine([
      '{"tool": "echo", "arguments": {"text": "yo"}}',
      '{"respond": true}',
      'done',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'echo yo' }], cb(events));
    const plans = events.filter((e) => e.type === 'plan');
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({ step: 0, text: '{"tool": "echo", "arguments": {"text": "yo"}}' });
  });

  it('executes a tool then streams a final answer', async () => {
    const { engine, seen } = fakeEngine([
      '{"tool": "echo", "arguments": {"text": "yo"}}',
      '{"respond": true}',
      'I echoed yo.',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'echo yo' }], cb(events));
    expect(events).toContainEqual({ type: 'tool', name: 'echo', label: 'Echo yo', status: 'running' });
    expect(events).toContainEqual({ type: 'tool', name: 'echo', label: 'Echo yo', status: 'done' });
    // The tool result is fed back into the conversation for the model.
    const withResult = seen.find((s) =>
      s.messages.some((m) => m.role === 'user' && m.content.startsWith('Result of echo:')),
    );
    expect(withResult).toBeDefined();
    expect(events).toContainEqual({ type: 'token', token: 'I echoed yo.' });
  });

  it('feeds invalid model arguments back as a validation message', async () => {
    const { engine, seen } = fakeEngine([
      '{"tool": "echo", "arguments": {"wrong": 1}}',
      '{"respond": true}',
      'ok',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'x' }], cb(events));
    const toolResult = seen
      .flatMap((s) => s.messages)
      .find((m) => m.role === 'user' && m.content.includes('Result of echo:'));
    expect(toolResult?.content).toMatch(/Invalid arguments/);
    // And the chip says so. Bad arguments used to come back as an ordinary
    // result: a green tick over a call that never ran.
    expect(events).toContainEqual({ type: 'tool', name: 'echo', label: 'echo', status: 'error' });
  });

  it('does not spend the retry on arguments that cannot become valid', async () => {
    // A tool that threw may work next time; the same rejected arguments never
    // will. Only the first costs an execution.
    const { engine } = fakeEngine(['{"tool": "echo", "arguments": {"wrong": 1}}']);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'x' }], cb(events));
    expect(events.filter((e) => e.type === 'tool' && e.status === 'running')).toHaveLength(1);
  });

  it('denied confirmation skips execution and tells the model', async () => {
    const { engine, seen } = fakeEngine([
      '{"tool": "guarded", "arguments": {}}',
      '{"respond": true}',
      'understood',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [guardedTool], [{ role: 'user', content: 'x' }], cb(events, false));
    expect(events).toContainEqual({ type: 'tool', name: 'guarded', label: 'Guarded action', status: 'denied' });
    expect(
      seen.flatMap((s) => s.messages).find((m) => m.content.includes('Result of guarded:'))
        ?.content,
    ).toMatch(/REFUSED/);
  });

  it('never force-retries an action the user denied', async () => {
    // Denial leaves zero successful runs — the recovery pass must still not
    // fire, or "Deny" would be silently overridden.
    const { engine, seen } = fakeEngine([
      '{"tool": "guarded", "arguments": {}}',
      '{"respond": true}',
      'understood',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [guardedTool], [{ role: 'user', content: 'x' }], cb(events, false));
    expect(forcedPlan(seen)).toHaveLength(0);
    expect(events.filter((e) => e.type === 'tool' && e.status === 'done')).toHaveLength(0);
  });

  it('reports unknown tools instead of crashing', async () => {
    const { engine, seen } = fakeEngine([
      '{"tool": "nope", "arguments": {}}',
      '{"respond": true}',
      'sorry',
    ]);
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'x' }], cb([]));
    expect(
      seen.flatMap((s) => s.messages).find((m) => m.content.includes('does not exist')),
    ).toBeDefined();
  });

  it('surfaces a tool execution error as a result, not an exception', async () => {
    const boom = defineTool({
      name: 'boom',
      description: 'throws',
      params: z.object({}),
      label: () => 'Boom',
      execute: async () => {
        throw new Error('kapow');
      },
    });
    const { engine, seen } = fakeEngine([
      '{"tool": "boom", "arguments": {}}',
      '{"respond": true}',
      'oh no',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [boom], [{ role: 'user', content: 'x' }], cb(events));
    expect(events).toContainEqual({ type: 'tool', name: 'boom', label: 'Boom', status: 'error' });
    expect(
      seen.flatMap((s) => s.messages).find((m) => m.content.includes('Result of boom:'))?.content,
    ).toBe('Result of boom: Tool error: kapow');
  });

  it('stops after MAX_STEPS when the model keeps finding new calls to make', async () => {
    // A fresh tool each time, so neither repeat suppression nor the per-tool
    // cap can be what ends the loop — only the step cap can, and the user must
    // still get a reply when it does.
    const many = [0, 1, 2, 3, 4].map((i) =>
      defineTool({
        name: `step${i}`,
        description: 'step',
        params: z.object({}),
        label: () => `Step ${i}`,
        execute: async () => 'stepped',
      }),
    );
    let n = 0;
    const engine: Engine = {
      load: async () => {},
      stop: async () => {},
      unload: async () => {},
      generate: async (_m, _onToken, opts) =>
        opts?.grammar
          ? { text: `{"tool": "step${n++}", "arguments": {}}`, toolCalls: [] }
          : { text: 'done', toolCalls: [] },
    };
    const events: AgentEvent[] = [];
    await runAgent(engine, many, [{ role: 'user', content: 'x' }], cb(events));
    // The cap, not the model, ends planning — and the user still gets a reply.
    expect(events.filter((e) => e.type === 'plan')).toHaveLength(4);
    expect(events).toContainEqual({ type: 'token', token: 'done' });
  });
});

// The failure in the shipped build: one "set an alarm" produced two alarms, and
// one "what's on my calendar" produced five identical reads. The planner reads
// its own tool result, sees a context that still looks exactly like the original
// request, and — at temperature 0 — deterministically decides the same call
// again. Nothing downstream can undo a second alarm, so the loop refuses to
// place the call at all.
describe('runAgent repeat suppression', () => {
  it('runs an identical call once, however often the planner asks', async () => {
    const { engine, seen } = fakeEngine(['{"tool": "echo", "arguments": {"text": "yo"}}']);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'echo yo' }], cb(events));

    expect(events.filter((e) => e.type === 'tool' && e.status === 'running')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool' && e.status === 'done')).toHaveLength(1);
    // Two planning turns (the call, then its suppressed repeat) and the answer —
    // the loop stops planning instead of burning every step on the same call.
    expect(seen).toHaveLength(3);
    expect(seen[2]!.grammar).toBe(false);
  });

  it('tells the model why the repeat produced nothing', async () => {
    const { engine, seen } = fakeEngine(['{"tool": "echo", "arguments": {"text": "yo"}}']);
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'echo yo' }], cb([]));
    expect(
      seen.flatMap((s) => s.messages).find((m) => m.content.includes('this call was already made and it returned')),
    ).toBeDefined();
  });

  it('ignores argument key order when deciding what counts as a repeat', async () => {
    const pair = defineTool({
      name: 'pair',
      description: 'pair',
      params: z.object({ a: z.string(), b: z.string() }),
      label: () => 'Pair',
      execute: async () => 'paired',
    });
    const { engine } = fakeEngine([
      '{"tool": "pair", "arguments": {"a": "1", "b": "2"}}',
      '{"tool": "pair", "arguments": {"b": "2", "a": "1"}}',
      '{"respond": true}',
      'ok',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [pair], [{ role: 'user', content: 'x' }], cb(events));
    expect(events.filter((e) => e.type === 'tool' && e.status === 'done')).toHaveLength(1);
  });

  it('still allows the same tool with genuinely different arguments', async () => {
    const { engine } = fakeEngine([
      '{"tool": "echo", "arguments": {"text": "one"}}',
      '{"tool": "echo", "arguments": {"text": "two"}}',
      '{"respond": true}',
      'echoed both',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'x' }], cb(events));
    expect(events.filter((e) => e.type === 'tool' && e.status === 'done')).toHaveLength(2);
  });

  it('caps one tool per turn, so near-identical arguments cannot loop either', async () => {
    // A calendar range shifted by a day is a new signature but the same read.
    const { engine } = fakeEngine([
      '{"tool": "echo", "arguments": {"text": "1"}}',
      '{"tool": "echo", "arguments": {"text": "2"}}',
      '{"tool": "echo", "arguments": {"text": "3"}}',
      'ignored',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'x' }], cb(events));
    expect(events.filter((e) => e.type === 'tool' && e.status === 'done')).toHaveLength(2);
  });

  it('chains two different tools without interference', async () => {
    const lookup = defineTool({
      name: 'lookup',
      description: 'lookup',
      params: z.object({ who: z.string() }),
      label: (a) => `Look up ${a.who}`,
      execute: async () => '+91 98450 12345',
    });
    const { engine } = fakeEngine([
      '{"tool": "lookup", "arguments": {"who": "Arun"}}',
      '{"tool": "echo", "arguments": {"text": "late"}}',
      '{"respond": true}',
      'Texted Arun.',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [lookup, echoTool], [{ role: 'user', content: 'text Arun' }], cb(events));
    const done = events.filter((e) => e.type === 'tool' && e.status === 'done');
    expect(done.map((e) => e.type === 'tool' && e.name)).toEqual(['lookup', 'echo']);
  });

  it('retries a call that THREW, once', async () => {
    // Caught on the emulator: the calendar read failed because the system
    // provider had just been killed, the planner sensibly tried again, and
    // repeat suppression refused it — turning a recoverable blip into a dead
    // turn. A call that errored produced no result, so a retry is not a repeat.
    let calls = 0;
    const flaky = defineTool({
      name: 'flaky',
      description: 'fails once',
      params: z.object({}),
      label: () => 'Flaky',
      execute: async () => {
        if (++calls === 1) throw new Error('provider died');
        return 'worked the second time';
      },
    });
    const { engine } = fakeEngine([
      '{"tool": "flaky", "arguments": {}}',
      '{"tool": "flaky", "arguments": {}}',
      '{"respond": true}',
      'Got it.',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [flaky], [{ role: 'user', content: 'x' }], cb(events));
    expect(calls).toBe(2);
    expect(events).toContainEqual({ type: 'tool', name: 'flaky', label: 'Flaky', status: 'error' });
    expect(events).toContainEqual({ type: 'tool', name: 'flaky', label: 'Flaky', status: 'done' });
  });

  it('gives up on a call that fails twice', async () => {
    let calls = 0;
    const broken = defineTool({
      name: 'broken',
      description: 'always fails',
      params: z.object({}),
      label: () => 'Broken',
      execute: async () => {
        calls++;
        throw new Error('nope');
      },
    });
    const { engine } = fakeEngine(['{"tool": "broken", "arguments": {}}']);
    await runAgent(engine, [broken], [{ role: 'user', content: 'x' }], cb([]));
    expect(calls).toBe(2); // one attempt, one retry, then stop
  });

  it('never reopens an action the user denied, even though nothing "ran"', async () => {
    // A denial is a settled answer, not a failure to work around — the retry
    // path must not treat it as one.
    let executed = 0;
    const guarded2 = defineTool({
      name: 'guarded',
      description: 'needs confirmation',
      params: z.object({}),
      label: () => 'Guarded action',
      requiresConfirmation: true,
      execute: async () => {
        executed++;
        return 'did the thing';
      },
    });
    const { engine } = fakeEngine(['{"tool": "guarded", "arguments": {}}']);
    await runAgent(engine, [guarded2], [{ role: 'user', content: 'x' }], cb([], false));
    expect(executed).toBe(0);
  });

  it('tells the answer turn that everything failed, so it cannot invent a result', async () => {
    const boom = defineTool({
      name: 'boom',
      description: 'throws',
      params: z.object({}),
      label: () => 'Boom',
      execute: async () => {
        throw new Error('provider died');
      },
    });
    const { engine, seen } = fakeEngine(['{"tool": "boom", "arguments": {}}']);
    await runAgent(engine, [boom], [{ role: 'user', content: 'x' }], cb([]));
    const answer = finalTurn(seen)[0]!;
    const note = answer.messages[answer.messages.length - 1]!.content;
    expect(note).toMatch(/FAILED/);
    expect(note).toContain('provider died');
  });

  it('names the spent calls in the next planning turn', async () => {
    // The prompt-side half of the same fix: the planner is told, right at the
    // decision point, what it has already done.
    const { engine, seen } = fakeEngine([
      '{"tool": "echo", "arguments": {"text": "yo"}}',
      '{"respond": true}',
      'ok',
    ]);
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'echo yo' }], cb([]));
    const second = planning(seen)[1]!;
    const note = second.messages[second.messages.length - 1]!;
    expect(note.content).toContain('already called echo');
  });
});

describe('runAgent answering', () => {
  it('accepts a decision to answer instead of forcing a tool behind it', async () => {
    // There was a recovery phase here that re-planned under a grammar with no
    // `respond` alternative whenever a yes/no probe thought the user had asked
    // for an action. On device it fired on "Thanks that is all for now" and,
    // having no way to emit `respond`, searched the web for "current time".
    // A decision to answer is now final.
    const { engine, seen } = fakeEngine(['{"respond": true}', 'Sure thing.']);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'thanks!' }], cb(events));
    expect(forcedPlan(seen)).toHaveLength(0);
    expect(events.some((e) => e.type === 'tool')).toBe(false);
    expect(planning(seen)).toHaveLength(1); // one decision, no probe
    expect(events).toContainEqual({ type: 'token', token: 'Sure thing.' });
  });

  it('leaves pure conversation alone', async () => {
    const { engine, seen } = fakeEngine(['{"respond": true}', 'Hello!']);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'hello' }], cb(events));
    expect(forcedPlan(seen)).toHaveLength(0);
    expect(events.some((e) => e.type === 'tool')).toBe(false);
  });

  it('tells the model not to promise anything when nothing ran', async () => {
    const { engine, seen } = fakeEngine(['{"respond": true}', 'Hello!']);
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'hello' }], cb([]));
    const answerTurn = finalTurn(seen)[0]!;
    const instruction = answerTurn.messages[answerTurn.messages.length - 1]!.content;
    expect(instruction).toMatch(/do not claim or promise/);
  });

  it('asks for a past-tense summary when tools did run', async () => {
    const { engine, seen } = fakeEngine([
      '{"tool": "echo", "arguments": {"text": "yo"}}',
      '{"respond": true}',
      'Echoed yo.',
    ]);
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'echo yo' }], cb([]));
    const answerTurn = finalTurn(seen)[0]!;
    const instruction = answerTurn.messages[answerTurn.messages.length - 1]!.content;
    expect(instruction).toMatch(/Answer my question directly/);
  });

  it('asks for a past-tense summary when a tool CHANGED something', async () => {
    // `mutates` is what separates "I set the alarm for 7" from "the battery is
    // at 100%" — without it, reads came back in the past tense too.
    const mutator = defineTool({
      name: 'mutate',
      description: 'changes something',
      params: z.object({}),
      label: () => 'Mutate',
      mutates: true,
      execute: async () => 'changed it',
    });
    const { engine, seen } = fakeEngine([
      '{"tool": "mutate", "arguments": {}}',
      '{"respond": true}',
      'Done.',
    ]);
    await runAgent(engine, [mutator], [{ role: 'user', content: 'do it' }], cb([]));
    const answerTurn = finalTurn(seen)[0]!;
    expect(answerTurn.messages[answerTurn.messages.length - 1]!.content).toMatch(/past tense/);
  });

  it('never lets the answer turn narrate a refused action', async () => {
    // The worst thing found on device: deny the card, and the reply was
    // "I already scheduled the reminder for 6 pm today."
    const { engine, seen } = fakeEngine([
      '{"tool": "guarded", "arguments": {}}',
      '{"respond": true}',
      'ok',
    ]);
    await runAgent(engine, [guardedTool], [{ role: 'user', content: 'x' }], cb([], false));
    const answerTurn = finalTurn(seen)[0]!;
    const instruction = answerTurn.messages[answerTurn.messages.length - 1]!.content;
    expect(instruction).toMatch(/REFUSED/);
    expect(instruction).toContain('Guarded action');
    expect(instruction).toMatch(/Never say you already did it/);
  });

  it('emits the completion text when no tokens streamed', async () => {
    // Verified on device: a turn set an alarm correctly, then the final
    // generation resolved in 638ms having streamed nothing, so the user saw a
    // chip and no reply. The returned text is the source of truth.
    const engine: Engine = {
      load: async () => {},
      stop: async () => {},
      unload: async () => {},
      generate: async (_m, _onToken, opts) => ({
        // Planning decides to answer; the final turn returns text but never
        // invokes the token callback.
        text: opts?.grammar ? '{"respond": true}' : 'All done.',
        toolCalls: [],
      }),
    };
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'hi' }], cb(events));
    expect(events).toContainEqual({ type: 'token', token: 'All done.' });
  });

  it('falls back to the tool results when the model returns nothing at all', async () => {
    let turn = 0;
    const engine: Engine = {
      load: async () => {},
      stop: async () => {},
      unload: async () => {},
      generate: async (_m, _onToken, opts) => {
        if (!opts?.grammar) return { text: '   ', toolCalls: [] }; // empty answer
        turn++;
        return {
          text: turn === 1 ? '{"tool": "echo", "arguments": {"text": "yo"}}' : '{"respond": true}',
          toolCalls: [],
        };
      },
    };
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'echo yo' }], cb(events));
    // A turn that changed something must never end silently.
    expect(events).toContainEqual({ type: 'token', token: 'echoed: yo' });
  });

  it('apologizes rather than going silent when nothing ran and nothing generated', async () => {
    const engine: Engine = {
      load: async () => {},
      stop: async () => {},
      unload: async () => {},
      generate: async (_m, _onToken, opts) => ({
        text: opts?.grammar ? (opts.grammar.includes('toolcall') ? '{"respond": true}' : 'no') : '',
        toolCalls: [],
      }),
    };
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'hi' }], cb(events));
    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ token: expect.stringMatching(/could not put a reply/) });
  });

  it('generates nothing at all once the user stops generation', async () => {
    const signal = { aborted: true };
    const { engine, seen } = fakeEngine(['{"tool": "echo", "arguments": {"text": "yo"}}', 'x']);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'echo yo' }], {
      ...cb(events),
      signal,
    });
    expect(seen).toHaveLength(0); // aborted before the first plan
    expect(events).toHaveLength(0);
  });
});
