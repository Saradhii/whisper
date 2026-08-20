import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/src/engines/types';

import { buildToolGrammar } from '../grammar';
import { legalToolNames, renderPrompt, replayEngine, scriptedEngine } from './engine';
import { hashMessages, ScriptedResponseSchema, TrajectorySchema, type Trajectory } from './types';

const script = (rows: { when?: string; regex?: boolean; text: string }[]) =>
  rows.map((r) => ScriptedResponseSchema.parse(r));

const msg = (content: string): AgentMessage[] => [{ role: 'user', content }];

const gen = (index: number, messages: AgentMessage[], text: string) => ({
  index,
  phase: index === 0 ? ('plan' as const) : ('answer' as const),
  messages: messages.map((m) => ({ role: m.role, content: m.content })),
  promptHash: hashMessages(messages.map((m) => ({ role: m.role, content: m.content }))),
  text,
  ms: 10,
});

const trajectory = (generations: ReturnType<typeof gen>[]): Trajectory =>
  TrajectorySchema.parse({
    v: 1,
    id: 'traj-1',
    at: 0,
    modelId: 'test',
    request: 'x',
    generations,
    toolCalls: [],
    answer: '',
    timings: { totalMs: 0, planMs: 0, toolMs: 0, answerMs: 0 },
  });

describe('scriptedEngine', () => {
  it('falls back to sequential order when no response declares a `when`', async () => {
    const engine = scriptedEngine(script([{ text: 'first' }, { text: 'second' }]));
    expect((await engine.generate(msg('a'), () => {})).text).toBe('first');
    expect((await engine.generate(msg('b'), () => {})).text).toBe('second');
    expect(engine.generations).toBe(2);
  });

  it('matches `when` against the whole rendered prompt, out of order', async () => {
    const engine = scriptedEngine(
      script([{ when: 'set an alarm', text: 'alarm' }, { text: 'fallback' }]),
    );
    expect((await engine.generate(msg('please set an alarm'), () => {})).text).toBe('alarm');
  });

  it('honours the regex flag', async () => {
    const engine = scriptedEngine(
      script([{ when: 'Result of (set_alarm|schedule_reminder):', regex: true, text: 'hit' }]),
    );
    expect((await engine.generate(msg('Result of schedule_reminder: ok'), () => {})).text).toBe('hit');
  });

  it('consumes each response once, so an identical prompt still advances', async () => {
    // Two planning turns can render byte-identical prompts. A script that kept
    // handing back the same entry would loop the agent forever on one decision.
    const engine = scriptedEngine(script([{ when: 'same', text: 'one' }, { when: 'same', text: 'two' }]));
    expect((await engine.generate(msg('same'), () => {})).text).toBe('one');
    expect((await engine.generate(msg('same'), () => {})).text).toBe('two');
  });

  it('throws naming the scenario when it runs out, rather than returning empty', async () => {
    // An empty completion is something a real model does, and the loop salvages
    // it — so a fixture that ran dry and returned '' would be scored as a model
    // failure with no hint that the SCRIPT is what is short.
    const engine = scriptedEngine(script([{ text: 'only' }]), { scenarioId: 'alarm-basic' });
    await engine.generate(msg('a'), () => {});
    await expect(engine.generate(msg('b'), () => {})).rejects.toThrow(/alarm-basic/);
    await expect(engine.generate(msg('b'), () => {})).rejects.toThrow(/ran out of responses/);
  });

  it('streams the answer turn and stays silent while planning', async () => {
    const engine = scriptedEngine(script([{ text: '{"respond": true}' }, { text: 'hello' }]));
    const planned: string[] = [];
    await engine.generate(msg('a'), (t) => planned.push(t), { grammar: 'root ::= "x"' });
    const streamed: string[] = [];
    await engine.generate(msg('b'), (t) => streamed.push(t));
    expect(planned).toEqual([]);
    expect(streamed).toEqual(['hello']);
  });
});

describe('replayEngine', () => {
  it('matches a recorded generation by promptHash', async () => {
    const a = msg('prompt A');
    const b = msg('prompt B');
    // Recorded in the opposite order to the one they are asked for: the hash is
    // what selects, not the position.
    const engine = replayEngine(trajectory([gen(0, b, 'B answer'), gen(1, a, 'A answer')]));
    expect((await engine.generate(a, () => {})).text).toBe('A answer');
    expect((await engine.generate(b, () => {})).text).toBe('B answer');
    expect(engine.drifted).toBe(0);
  });

  it('falls back to recorded order and counts drift when the prompt has changed', async () => {
    // The recording is stale — someone edited prompt.ts. Replay still produces a
    // score (a stale signal beats no signal), but the run has to be able to say
    // so, or the table silently grades a new prompt against an old completion.
    const engine = replayEngine(trajectory([gen(0, msg('old prompt'), 'recorded')]));
    expect((await engine.generate(msg('new prompt'), () => {})).text).toBe('recorded');
    expect(engine.drifted).toBe(1);
  });

  it('throws naming the trajectory when the recording is exhausted', async () => {
    const engine = replayEngine(trajectory([gen(0, msg('a'), 'x')]), { scenarioId: 'recorded-42' });
    await engine.generate(msg('a'), () => {});
    await expect(engine.generate(msg('a'), () => {})).rejects.toThrow(/recorded-42/);
  });
});

describe('renderPrompt', () => {
  it('tags each message with its role so a script can pin tool results', () => {
    expect(renderPrompt([{ role: 'user', content: 'Result of set_alarm: ok' }])).toBe(
      'user: Result of set_alarm: ok',
    );
  });
});

// --- grammar legality -------------------------------------------------------
// These pin the hole found when workstream A landed: the fixture engine read
// `opts.grammar` only to decide whether to stream, so the 77-scenario corpus
// scored a GREEN run against a reintroduced GBNF quoting bug that on a real
// device breaks every tool call. Verified by experiment, not by inspection.
describe('grammar legality', () => {
  it('accepts a decision the grammar can actually produce', async () => {
    const engine = scriptedEngine(
      [{ when: undefined, regex: false, text: '{"tool": "set_alarm", "arguments": {"hour": 7}}' }],
      { scenarioId: 'ok' },
    );
    const res = await engine.generate(
      [{ role: 'user', content: 'wake me at 7' }],
      () => {},
      { grammar: buildToolGrammar(['set_alarm']) },
    );
    expect(res.text).toContain('set_alarm');
  });

  it('rejects a decision the grammar cannot produce (the shipped quoting bug)', async () => {
    // The bug: literal delimiters left unescaped, so the sampler may only emit
    // the bare characters set_alarm — never the quoted JSON string.
    const broken = buildToolGrammar(['set_alarm']).replace(
      'toolname    ::= "\\"set_alarm\\""',
      'toolname    ::= "set_alarm"',
    );
    const engine = scriptedEngine(
      [{ when: undefined, regex: false, text: '{"tool": "set_alarm", "arguments": {"hour": 7}}' }],
      { scenarioId: 'broken-grammar' },
    );
    await expect(
      engine.generate([{ role: 'user', content: 'wake me at 7' }], () => {}, { grammar: broken }),
    ).rejects.toThrow(/could not produce this decision/);
  });

  it('reads the legal emissions back out of a well-formed grammar', () => {
    expect(legalToolNames(buildToolGrammar(['set_alarm', 'web_search']))).toEqual([
      '"set_alarm"',
      '"web_search"',
    ]);
  });

  it('leaves an unconstrained answer turn alone', async () => {
    const engine = scriptedEngine([{ when: undefined, regex: false, text: 'Alarm set for 7.' }], {
      scenarioId: 'answer',
    });
    const res = await engine.generate([{ role: 'user', content: 'hi' }], () => {});
    expect(res.text).toBe('Alarm set for 7.');
  });
});
