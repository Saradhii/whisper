// Tests for the runner itself, not for the agent.
//
// A harness whose assertions silently pass is worse than no harness: it turns a
// regression into a green tick. So every assertion class the corpus relies on —
// wrong tool, wrong argument, forbidden answer, extra call, stale recording —
// is proven here to FAIL when it should, on a scenario that is otherwise
// identical to one that passes.
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@/src/engines/types';

import { replayEngine, scriptedEngine, type FixtureEngine } from './engine';
import { runScenario, scoreAll } from './run';
import { hashMessages, ScenarioSchema, TrajectorySchema, type Scenario, type Trajectory } from './types';

const NOW = '2026-08-12T09:15';

/** The reference scenario: one alarm, correctly set, correctly reported. Every
 *  failure test below is this with exactly one thing changed. */
function alarmScenario(patch: Record<string, unknown> = {}): Scenario {
  return ScenarioSchema.parse({
    id: 'alarm-7am',
    title: 'set an alarm for 7am',
    now: NOW,
    tools: ['set_alarm'],
    turns: [
      {
        user: 'set an alarm for 7am',
        expect: {
          calls: [{ name: 'set_alarm', args: { hour: 7, minute: 0 } }],
          answer: { mustContain: ['7:00'], mustNotContain: ['I will'] },
        },
      },
    ],
    expectWorld: { alarms: [{ hour: 7, minute: 0 }] },
    script: [
      { text: '{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 0}}' },
      { text: '{"respond": true}' },
      { text: 'Done — your alarm is set for 7:00 AM.' },
    ],
    ...patch,
  });
}

const engineFor = (s: Scenario) => scriptedEngine(s.script, { scenarioId: s.id });

/** Failures of the first turn, plus anything scenario-scoped folded into it. */
const failures = async (s: Scenario) => (await runScenario(s, engineFor(s))).turns[0]!.score.failures;

describe('runScenario — a scenario that should pass, passes', () => {
  it('scores the reference scenario clean', async () => {
    const run = await runScenario(alarmScenario(), engineFor(alarmScenario()));
    const score = run.turns[0]!.score;
    expect(score.failures).toEqual([]);
    expect(score).toMatchObject({
      scenarioId: 'alarm-7am',
      turnIndex: 0,
      completed: true,
      toolCorrect: true,
      argsCorrect: true,
      answerCorrect: true,
      steps: 2,
    });
    expect(run.world.alarms).toEqual([{ hour: 7, minute: 0 }]);
    expect(run.drifted).toBe(0);
  });

  it('freezes the clock from the scenario, so the corpus does not rot', async () => {
    // Every date in the planning note is rendered off `now`. If the runner used
    // the real clock the corpus would pass today and drift out from under itself
    // tomorrow, for reasons unrelated to the agent.
    const seen: AgentMessage[][] = [];
    const s = alarmScenario();
    const engine = spyOn(engineFor(s), seen);
    await runScenario(s, engine);
    const prompt = seen[0]!.map((m) => m.content).join('\n');
    expect(prompt).toContain('2026-08-12');
    expect(prompt).toContain('today 2026-08-12, tomorrow 2026-08-13');
  });

  it('gives each run its own world', async () => {
    const a = await runScenario(alarmScenario(), engineFor(alarmScenario()));
    const b = await runScenario(alarmScenario(), engineFor(alarmScenario()));
    expect(a.world.alarms).toHaveLength(1);
    expect(b.world.alarms).toHaveLength(1); // not 2 — the worlds are not shared
    expect(alarmScenario().world.alarms).toEqual([]); // and the scenario is untouched
  });

  it('asserts that a conversational turn used NO tool', async () => {
    // The regression that motivated `calls: []`: the removed recover phase
    // turned "thanks, that's all" into a web search for "current time".
    const s = alarmScenario({
      id: 'chat-thanks',
      turns: [{ user: 'thanks, that is all', expect: { calls: [] } }],
      expectWorld: { alarms: [] },
      script: [{ text: '{"respond": true}' }, { text: 'Any time!' }],
    });
    expect((await runScenario(s, engineFor(s))).turns[0]!.score.completed).toBe(true);
  });

  it('carries the answer into the next turn as history', async () => {
    const seen: AgentMessage[][] = [];
    const s = alarmScenario({
      id: 'two-turns',
      turns: [
        { user: 'set an alarm for 7am', expect: { calls: [{ name: 'set_alarm', args: { hour: 7 } }] } },
        { user: 'thanks', expect: { calls: [] } },
      ],
      script: [
        { text: '{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 0}}' },
        { text: '{"respond": true}' },
        { text: 'Alarm set for 7:00 AM.' },
        { text: '{"respond": true}' },
        { text: 'Any time.' },
      ],
    });
    const run = await runScenario(s, spyOn(engineFor(s), seen));
    expect(run.turns.every((t) => t.score.completed)).toBe(true);
    const secondTurn = seen[3]!.map((m) => m.content).join('\n');
    expect(secondTurn).toContain('Alarm set for 7:00 AM.');
  });
});

describe('runScenario — each assertion class fails when it should', () => {
  it('fails on the WRONG TOOL', async () => {
    const s = alarmScenario({
      script: [
        { text: '{"tool": "get_battery", "arguments": {}}' },
        { text: '{"respond": true}' },
        { text: 'Your battery is at 72%.' },
      ],
      tools: ['set_alarm', 'get_battery'],
    });
    const run = await runScenario(s, engineFor(s));
    const score = run.turns[0]!.score;
    expect(score.toolCorrect).toBe(false);
    expect(score.completed).toBe(false);
    expect(score.failures).toContainEqual(expect.stringContaining('expected set_alarm, got get_battery'));
  });

  it('fails on the WRONG ARGUMENT, and scores it separately from the tool', async () => {
    // The failure this whole harness is for: 7am asked, 19:00 set. The tool is
    // right, so a combined pass rate would show this as a near-miss at worst.
    const s = alarmScenario({
      turns: [
        {
          user: 'set an alarm for 7am',
          expect: { calls: [{ name: 'set_alarm', args: { hour: 7, minute: 0 } }] },
        },
      ],
      expectWorld: { alarms: [{ hour: 19, minute: 0 }] },
      script: [
        { text: '{"tool": "set_alarm", "arguments": {"hour": 19, "minute": 0}}' },
        { text: '{"respond": true}' },
        { text: 'Done — your alarm is set.' },
      ],
    });
    const score = (await runScenario(s, engineFor(s))).turns[0]!.score;
    expect(score.toolCorrect).toBe(true);
    expect(score.argsCorrect).toBe(false);
    expect(score.completed).toBe(false);
    expect(score.failures).toContainEqual(expect.stringContaining('call 0 set_alarm.hour: expected 7, got 19'));
  });

  it('fails on a FORBIDDEN ANSWER STRING', async () => {
    const s = alarmScenario({
      script: [
        { text: '{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 0}}' },
        { text: '{"respond": true}' },
        { text: 'I will set an alarm for 7:00 AM.' },
      ],
    });
    const score = (await runScenario(s, engineFor(s))).turns[0]!.score;
    expect(score.toolCorrect).toBe(true);
    expect(score.argsCorrect).toBe(true);
    expect(score.answerCorrect).toBe(false);
    expect(score.failures).toContainEqual(expect.stringContaining('must NOT contain "I will"'));
  });

  it('fails on a missing REQUIRED ANSWER STRING', async () => {
    const s = alarmScenario({
      script: [
        { text: '{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 0}}' },
        { text: '{"respond": true}' },
        { text: 'All done.' },
      ],
    });
    expect(await failures(s)).toContainEqual(expect.stringContaining('must contain "7:00"'));
  });

  it('fails on an UNEXPECTED EXTRA CALL, unless the scenario allows it', async () => {
    const extra = {
      script: [
        { text: '{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 0}}' },
        { text: '{"tool": "set_alarm", "arguments": {"hour": 8, "minute": 0}}' },
        { text: '{"respond": true}' },
        { text: 'Done — your alarm is set for 7:00 AM.' },
      ],
    };
    const strict = alarmScenario(extra);
    const strictScore = (await runScenario(strict, engineFor(strict))).turns[0]!.score;
    expect(strictScore.toolCorrect).toBe(false);
    expect(strictScore.failures).toContainEqual(expect.stringContaining('unexpected extra call: set_alarm'));

    const lenient = alarmScenario({
      ...extra,
      expectWorld: { alarms: [{ hour: 7, minute: 0 }, { hour: 8, minute: 0 }] },
      turns: [
        {
          user: 'set an alarm for 7am',
          expect: {
            calls: [{ name: 'set_alarm', args: { hour: 7 } }],
            allowExtraCalls: true,
            answer: { mustContain: ['7:00'] },
          },
        },
      ],
    });
    expect((await runScenario(lenient, engineFor(lenient))).turns[0]!.score.completed).toBe(true);
  });

  it('fails on a WORLD that does not match, however confident the answer was', async () => {
    // "I've set your alarm for 7" with no alarm on the phone. The answer passes
    // every string assertion; only the final-state check catches it.
    const s = alarmScenario({
      turns: [{ user: 'set an alarm for 7am', expect: { calls: [] } }],
      script: [{ text: '{"respond": true}' }, { text: 'Done — your alarm is set for 7:00 AM.' }],
    });
    const score = (await runScenario(s, engineFor(s))).turns[0]!.score;
    expect(score.completed).toBe(false);
    expect(score.failures).toContainEqual(expect.stringContaining('world.alarms: expected 1 item(s), got 0'));
  });

  it('fails when one request produced TWO alarms', async () => {
    // Array length is checked on purpose: a subset match would score the
    // double-fire bug that repeat suppression exists for as a clean pass.
    const s = alarmScenario({
      expectWorld: { alarms: [{ hour: 7, minute: 0 }] },
      turns: [
        {
          user: 'set an alarm for 7am',
          expect: { calls: [{ name: 'set_alarm' }], allowExtraCalls: true },
        },
      ],
      script: [
        { text: '{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 0}}' },
        { text: '{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 1}}' },
        { text: '{"respond": true}' },
        { text: 'Alarm set.' },
      ],
    });
    expect(await failures(s)).toContainEqual(expect.stringContaining('world.alarms: expected 1 item(s), got 2'));
  });

  it('fails on a STALE promptHash by reporting drift, without losing the score', async () => {
    // A stale recording still produces a number — better than no signal — but
    // the run has to say so, or the table quietly grades a rewritten prompt
    // against completions the model produced for the old one.
    const s = alarmScenario();
    const recorded = await record(s);
    const fresh = await runScenario(s, replayEngine(recorded, { scenarioId: s.id }));
    expect(fresh.drifted).toBe(0);
    expect(fresh.turns[0]!.score.completed).toBe(true);

    const stale = TrajectorySchema.parse({
      ...recorded,
      generations: recorded.generations.map((g, i) => (i === 0 ? { ...g, promptHash: 'deadbeef' } : g)),
    });
    const run = await runScenario(s, replayEngine(stale, { scenarioId: s.id }));
    expect(run.drifted).toBe(1);
    expect(run.turns[0]!.score.completed).toBe(true);
  });

  it('rejects a `now` the planning note could not render', async () => {
    const s = alarmScenario({ now: 'next Friday' });
    await expect(runScenario(s, engineFor(s))).rejects.toThrow(/is not a date/);
  });
});

describe('runScenario — confirmations', () => {
  it('feeds a refusal to the confirm callback and records the attempt', async () => {
    const s = alarmScenario({
      turns: [
        {
          user: 'set an alarm for 7am',
          confirmations: [false],
          expect: {
            calls: [{ name: 'set_alarm', args: { hour: 7 } }],
            answer: { mustNotContain: ['already set'] },
          },
        },
      ],
      expectWorld: { alarms: [] },
      script: [
        { text: '{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 0}}' },
        { text: '{"respond": true}' },
        { text: 'No problem — I did not set it. What time would you like?' },
      ],
    });
    const run = await runScenario(s, engineFor(s));
    expect(run.turns[0]!.calls[0]).toMatchObject({ name: 'set_alarm', status: 'denied' });
    expect(run.world.alarms).toEqual([]);
    expect(run.turns[0]!.score.completed).toBe(true);
  });

  it('approves by default, so only the refusal cases need spelling out', async () => {
    const run = await runScenario(alarmScenario(), engineFor(alarmScenario()));
    expect(run.turns[0]!.calls[0]!.status).toBe('done');
  });
});

describe('runScenario — what counts as a call', () => {
  it('does not count a suppressed repeat as a second call', async () => {
    // The loop refuses the repeat before it reaches the tool, so the phone made
    // one call. Counting decisions instead of attempts would score the fix as
    // the bug it fixed.
    // Three script entries, not four: the suppressed repeat ENDS planning, so
    // the loop never asks for a `{"respond": true}` and the answer turn is the
    // next thing off the script.
    const s = alarmScenario({
      script: [
        { text: '{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 0}}' },
        { text: '{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 0}}' },
        { text: 'Done — your alarm is set for 7:00 AM.' },
      ],
    });
    const run = await runScenario(s, engineFor(s));
    expect(run.turns[0]!.calls).toHaveLength(1);
    expect(run.turns[0]!.score.completed).toBe(true);
  });

  it('does not count a hallucinated tool name as a call', async () => {
    const s = alarmScenario({
      turns: [{ user: 'delete my 7am alarm', expect: { calls: [] } }],
      expectWorld: { alarms: [] },
      script: [
        { text: '{"tool": "delete_alarm", "arguments": {}}' },
        { text: '{"respond": true}' },
        { text: 'I cannot delete alarms.' },
      ],
    });
    // `allowUnproducible` because the point of this test is the loop's defensive
    // unknown-tool branch, and a working grammar makes that branch unreachable —
    // it fires in production only when the grammar ISN'T being applied. Scripting
    // a name outside the enum is the only way to reach it, so the fixture engine
    // has to be told to stand down.
    const engine = scriptedEngine(s.script, { scenarioId: s.id, allowUnproducible: true });
    expect((await runScenario(s, engine)).turns[0]!.score.completed).toBe(true);
  });

  it('reports a bad-argument call as an errored attempt', async () => {
    const s = alarmScenario({
      turns: [{ user: 'set an alarm for 7am', expect: { calls: [{ name: 'set_alarm' }] } }],
      expectWorld: { alarms: [] },
      script: [
        { text: '{"tool": "set_alarm", "arguments": {"hour": "seven"}}' },
        { text: '{"respond": true}' },
        { text: 'Sorry, that did not work.' },
      ],
    });
    const run = await runScenario(s, engineFor(s));
    expect(run.turns[0]!.calls[0]).toMatchObject({ name: 'set_alarm', status: 'error' });
  });

  it('restricts the registry to scenario.tools and names an unknown one', async () => {
    const s = alarmScenario({ tools: ['set_alarm', 'no_such_tool'] });
    await expect(runScenario(s, engineFor(s))).rejects.toThrow(/no such tool no_such_tool/);
  });
});

describe('scoreAll', () => {
  it('aggregates every turn in the corpus', async () => {
    const bad = alarmScenario({
      id: 'alarm-wrong-hour',
      script: [
        { text: '{"tool": "set_alarm", "arguments": {"hour": 19, "minute": 0}}' },
        { text: '{"respond": true}' },
        { text: 'Done — your alarm is set for 7:00 AM.' },
      ],
    });
    const report = await scoreAll([alarmScenario(), bad]);
    expect(report).toMatchObject({
      scenarios: 2,
      turns: 2,
      completed: 1,
      toolCorrect: 2,
      argsCorrect: 1,
      answerCorrect: 2,
      meanSteps: 2,
      drifted: 0,
    });
  });

  it('records a scenario whose script ran short instead of taking the run down', async () => {
    const short = alarmScenario({ id: 'alarm-short-script', script: [{ text: '{"respond": true}' }] });
    const report = await scoreAll([short, alarmScenario()]);
    expect(report.turns).toBe(2);
    expect(report.completed).toBe(1);
    expect(report.perTurn[0]!.failures[0]).toMatch(/alarm-short-script.*ran out of responses/s);
  });

  it('carries drift up into the report', async () => {
    const s = alarmScenario();
    const recorded = await record(s);
    const stale = TrajectorySchema.parse({
      ...recorded,
      generations: recorded.generations.map((g) => ({ ...g, promptHash: 'deadbeef' })),
    });
    const report = await scoreAll([s], () => replayEngine(stale, { scenarioId: s.id }));
    expect(report.drifted).toBe(3);
    expect(report.completed).toBe(1);
  });
});

// --- helpers ---------------------------------------------------------------

/** Wrap a fixture engine so the test can see the prompts the loop built. The
 *  counters stay live getters — spreading the engine would freeze them at 0. */
function spyOn(engine: FixtureEngine, seen: AgentMessage[][]): FixtureEngine {
  return {
    load: engine.load.bind(engine),
    stop: engine.stop.bind(engine),
    unload: engine.unload.bind(engine),
    generate: (messages, onToken, opts) => {
      seen.push(structuredClone(messages));
      return engine.generate(messages, onToken, opts);
    },
    get generations() {
      return engine.generations;
    },
    get drifted() {
      return engine.drifted;
    },
  };
}

/** Run a scenario once and keep what the engine saw and said, as a Trajectory —
 *  a stand-in for the on-device recorder, so replay is tested end to end here. */
async function record(scenario: Scenario): Promise<Trajectory> {
  const seen: AgentMessage[][] = [];
  const engine = scriptedEngine(scenario.script, { scenarioId: scenario.id });
  const texts: string[] = [];
  const capture: FixtureEngine = {
    load: engine.load.bind(engine),
    stop: engine.stop.bind(engine),
    unload: engine.unload.bind(engine),
    generate: async (messages, onToken, opts) => {
      seen.push(structuredClone(messages));
      const res = await engine.generate(messages, onToken, opts);
      texts.push(res.text);
      return res;
    },
    get generations() {
      return engine.generations;
    },
    get drifted() {
      return engine.drifted;
    },
  };
  await runScenario(scenario, capture);
  return TrajectorySchema.parse({
    v: 1,
    id: scenario.id,
    at: 0,
    modelId: 'fixture',
    request: scenario.turns[0]!.user,
    generations: seen.map((messages, index) => ({
      index,
      phase: index === seen.length - 1 ? 'answer' : 'plan',
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      promptHash: hashMessages(messages.map((m) => ({ role: m.role, content: m.content }))),
      text: texts[index] ?? '',
      ms: 1,
    })),
    toolCalls: [],
    answer: texts[texts.length - 1] ?? '',
    timings: { totalMs: 0, planMs: 0, toolMs: 0, answerMs: 0 },
  });
}
