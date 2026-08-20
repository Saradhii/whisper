// The replay runner: drive `runAgent` over a scenario and score what it did.
//
// The whole point of Phase 0 is that "did this prompt change help?" stops being
// a question someone answers by flashing a build and reading a chat bubble. So
// this module owns the three things that make a run comparable between commits:
//
//   * the clock is frozen from the scenario, never `new Date()`. `planNote()`
//     renders a seven-day date table off `now` and every date assertion in the
//     corpus is relative to it, so a live clock would make the corpus pass today
//     and fail tomorrow for reasons that have nothing to do with the agent.
//   * the world is a fresh deep copy per run, so scenario 40 cannot see the
//     alarm scenario 3 set.
//   * tool correctness and ARGUMENT correctness are scored separately. This
//     project's recurring failure is the right tool with the wrong arguments;
//     a combined pass rate is exactly the number that hides it.
//
// Pure module (no Expo, no react-native) so `npx vitest run src/agent` scores a
// full corpus in Node with no device and no weights.
import { runAgent, type AgentEvent } from '@/src/agent/loop';
import { parseDecision } from '@/src/agent/grammar';
import type { AnyTool } from '@/src/agent/types';
import type { ChatMessage } from '@/src/engines/types';

import { scriptedEngine, type FixtureEngine } from './engine';
import { buildFakeTools } from './tools';
import type { Scenario, ScenarioTurn, ScoreReport, TurnScore, World } from './types';

type ExpectedAnswer = ScenarioTurn['expect']['answer'];

/** A tool call the loop actually attempted, with the arguments the model sent. */
export type ActualCall = {
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'denied' | 'error';
};

export type TurnRun = {
  user: string;
  events: AgentEvent[];
  calls: ActualCall[];
  /** Everything the user would have seen, token events concatenated. */
  answer: string;
  score: TurnScore;
};

export type ScenarioRun = {
  scenario: Scenario;
  /** The world as it stands after the last turn — what `expectWorld` is against. */
  world: World;
  turns: TurnRun[];
  generations: number;
  drifted: number;
};

export type RunOptions = {
  /** Swap the registry, e.g. to inject one misbehaving tool. Defaults to the
   *  full 18 fakes bound to this run's world copy. */
  buildTools?: (world: World, now: Date) => AnyTool[];
};

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export async function runScenario(
  scenario: Scenario,
  engine: FixtureEngine,
  opts: RunOptions = {},
): Promise<ScenarioRun> {
  const now = new Date(scenario.now);
  if (isNaN(+now)) {
    throw new Error(
      `[${scenario.id}] now="${scenario.now}" is not a date. Use local ISO with no ` +
        `timezone suffix (2026-08-12T09:15) — a "Z" would shift every date in the ` +
        `planning note by the machine's UTC offset.`,
    );
  }

  // structuredClone, not a shallow spread: the tools push into world.alarms and
  // world.opened, and a shared array would leak an alarm from one scenario into
  // the next one's `expectWorld`.
  const world: World = structuredClone(scenario.world);
  const all = (opts.buildTools ?? buildFakeTools)(world, now);
  const tools = selectTools(all, scenario);

  const history: ChatMessage[] = [];
  const turns: TurnRun[] = [];

  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i]!;
    history.push({ role: 'user', content: turn.user });

    const events: AgentEvent[] = [];
    // Confirmations are consumed in the order the cards appear. Running out
    // approves, because most scenarios exercise the happy path and spelling out
    // `[true]` on every one of them is noise that hides the `[false]` cases.
    const answers = [...turn.confirmations];
    const started = Date.now();
    await runAgent(
      engine,
      tools,
      history,
      {
        onEvent: (e) => events.push(e),
        confirm: async () => (answers.length ? answers.shift()! : true),
      },
      now,
    );
    const totalMs = Date.now() - started;

    const answer = events
      .filter((e) => e.type === 'token')
      .map((e) => (e.type === 'token' ? e.token : ''))
      .join('');
    history.push({ role: 'assistant', content: answer });

    const calls = callsFrom(events);
    turns.push({
      user: turn.user,
      events,
      calls,
      answer,
      score: scoreTurn(scenario.id, i, turn, calls, answer, events, totalMs),
    });
  }

  // The final-state check, and the reason a scenario declares a world at all:
  // it is what catches "I've set your alarm for 7" when no alarm exists. It is
  // scenario-scoped, so it lands on the last turn's score — the alternative is a
  // score row with no turn attached, which no aggregate knows what to do with.
  //
  // A trap worth knowing about when writing scenarios: OMITTING `expectWorld`
  // asserts nothing, but writing `expectWorld: {}` asserts the whole DEFAULT
  // world (no alarms, no events, brightness 0.5, …). `WorldSchema.partial()`
  // only lifts the outer keys — every field underneath still carries its
  // `.default()`, and zod fills them in whenever the object is actually parsed.
  // Leave the key out to mean "don't care".
  const worldFailures: string[] = [];
  diff(scenario.expectWorld, world, 'world', worldFailures);
  const last = turns[turns.length - 1];
  if (last && worldFailures.length) {
    last.score.failures.push(...worldFailures);
    last.score.completed = false;
  }

  return { scenario, world, turns, generations: engine.generations, drifted: engine.drifted };
}

/**
 * Score a corpus. `makeEngine` defaults to replaying each scenario's own script;
 * pass a different factory to score the same corpus against a recorded
 * trajectory or a real engine.
 *
 * A scenario that throws — most often a script too short for the turn the loop
 * actually ran — is recorded as a failed row rather than taking the process
 * down. One broken scenario must not cost you the other 59 results.
 */
export async function scoreAll(
  scenarios: Scenario[],
  makeEngine: (s: Scenario) => FixtureEngine = (s) =>
    scriptedEngine(s.script, { scenarioId: s.id }),
  opts: RunOptions = {},
): Promise<ScoreReport> {
  const perTurn: TurnScore[] = [];
  let drifted = 0;

  for (const scenario of scenarios) {
    const engine = makeEngine(scenario);
    try {
      const run = await runScenario(scenario, engine, opts);
      perTurn.push(...run.turns.map((t) => t.score));
      drifted += run.drifted;
    } catch (e) {
      drifted += engine.drifted;
      perTurn.push({
        scenarioId: scenario.id,
        turnIndex: 0,
        completed: false,
        toolCorrect: false,
        argsCorrect: false,
        answerCorrect: false,
        steps: engine.generations,
        totalMs: 0,
        failures: [e instanceof Error ? e.message : String(e)],
      });
    }
  }

  const n = perTurn.length || 1;
  const count = (pick: (t: TurnScore) => boolean) => perTurn.filter(pick).length;
  return {
    scenarios: scenarios.length,
    turns: perTurn.length,
    completed: count((t) => t.completed),
    toolCorrect: count((t) => t.toolCorrect),
    argsCorrect: count((t) => t.argsCorrect),
    answerCorrect: count((t) => t.answerCorrect),
    meanSteps: perTurn.reduce((a, t) => a + t.steps, 0) / n,
    meanMs: perTurn.reduce((a, t) => a + t.totalMs, 0) / n,
    drifted,
    perTurn,
  };
}

/** Restrict the registry to `scenario.tools`, which is how Phase 1's selective
 *  tool disclosure gets measured before it is built. */
function selectTools(all: AnyTool[], scenario: Scenario): AnyTool[] {
  if (!scenario.tools.length) return all;
  const known = new Set(all.map((t) => t.name));
  const unknown = scenario.tools.filter((n) => !known.has(n));
  if (unknown.length) {
    throw new Error(`[${scenario.id}] tools: no such tool ${unknown.join(', ')}`);
  }
  return all.filter((t) => scenario.tools.includes(t.name));
}

// ---------------------------------------------------------------------------
// Reading the event stream
// ---------------------------------------------------------------------------

/**
 * Recover the calls the loop actually ATTEMPTED, with their arguments.
 *
 * `AgentEvent` splits what we need across two event types: `plan` carries the
 * raw decision (so the arguments) and `tool` carries the outcome. Pairing them
 * is what distinguishes an attempt from a decision that never reached a tool —
 * a suppressed repeat and an invented tool name both emit a plan event and no
 * tool event, and neither is a call the phone made. Counting decisions instead
 * would score the loop's repeat suppression as two calendar reads.
 *
 * A denied confirmation IS an attempt and is kept, with status 'denied': a
 * scenario asserting that the agent tried to set the alarm the user then refused
 * has to be able to see it.
 */
export function callsFrom(events: AgentEvent[]): ActualCall[] {
  const calls: ActualCall[] = [];
  let pending: { name: string; args: Record<string, unknown> } | null = null;
  let current = -1;
  for (const e of events) {
    if (e.type === 'plan') {
      const d = parseDecision(e.text);
      pending = d.kind === 'tool' ? { name: d.name, args: d.arguments } : null;
      current = -1;
      continue;
    }
    if (e.type !== 'tool') continue;
    if (pending) {
      current = calls.push({ ...pending, status: e.status }) - 1;
      pending = null;
    } else if (current >= 0) {
      // running → done/error for the same decision: the LAST status is the
      // outcome, so a bad-argument call reads as 'error' and not as 'running'.
      calls[current]!.status = e.status;
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreTurn(
  scenarioId: string,
  turnIndex: number,
  turn: ScenarioTurn,
  calls: ActualCall[],
  answer: string,
  events: AgentEvent[],
  totalMs: number,
): TurnScore {
  const failures: string[] = [];
  const expected = turn.expect.calls;

  let toolCorrect = true;
  let argsCorrect = true;

  for (let i = 0; i < expected.length; i++) {
    const want = expected[i]!;
    const got = calls[i];
    if (!got) {
      failures.push(`call ${i}: expected ${want.name}, but the agent made no such call`);
      toolCorrect = false;
      continue;
    }
    if (got.name !== want.name) {
      failures.push(`call ${i}: expected ${want.name}, got ${got.name}`);
      toolCorrect = false;
      // The arguments of a different tool are not a meaningful comparison, so
      // the argument score is left alone rather than double-counting the miss.
      continue;
    }
    const before = failures.length;
    diff(want.args, got.args, `call ${i} ${want.name}`, failures);
    if (failures.length > before) argsCorrect = false;
  }

  if (!turn.expect.allowExtraCalls && calls.length > expected.length) {
    for (const extra of calls.slice(expected.length)) {
      // The regression this catches by name: "thanks, that's all" answered with
      // a web search, because the old recover phase forced a tool where none
      // belonged. An expectation of `calls: []` is an assertion, not a default.
      failures.push(`unexpected extra call: ${extra.name}(${JSON.stringify(extra.args)})`);
    }
    toolCorrect = false;
  }

  const answerFailures = scoreAnswer(turn.expect.answer, answer);
  failures.push(...answerFailures);

  return {
    scenarioId,
    turnIndex,
    completed: failures.length === 0,
    toolCorrect,
    argsCorrect,
    answerCorrect: answerFailures.length === 0,
    steps: events.filter((e) => e.type === 'plan').length,
    totalMs,
    failures,
  };
}

/**
 * `mustNotContain` is the load-bearing half. The regressions this project has
 * actually shipped are the model claiming a denied action happened and a failed
 * read reported as an empty one — both of which are fluent, plausible answers
 * that any similarity score would wave through. A forbidden string is the only
 * assertion that catches them without a judge model.
 */
function scoreAnswer(expect: ExpectedAnswer, answer: string): string[] {
  const failures: string[] = [];
  const hit = (needle: string) =>
    expect.regex
      ? new RegExp(needle, 'i').test(answer)
      : answer.toLowerCase().includes(needle.toLowerCase());
  for (const needle of expect.mustContain) {
    if (!hit(needle)) failures.push(`answer must contain ${JSON.stringify(needle)}: ${quote(answer)}`);
  }
  for (const needle of expect.mustNotContain) {
    if (hit(needle)) failures.push(`answer must NOT contain ${JSON.stringify(needle)}: ${quote(answer)}`);
  }
  return failures;
}

const quote = (s: string) => JSON.stringify(s.length > 200 ? `${s.slice(0, 200)}…` : s);

/**
 * Partial deep match: every key the scenario DECLARED must match, and nothing
 * else is looked at.
 *
 * This is what keeps a 60-scenario corpus alive across a tool signature change —
 * adding an optional `location` to create_calendar_event must not invalidate
 * fifty expectations that never mentioned it.
 *
 * Arrays are the deliberate exception: length is checked. `alarms: [{hour: 7}]`
 * has to fail when the world holds TWO 7:00 alarms, because "one set_alarm
 * produced two alarms" is the bug that motivated the loop's repeat suppression
 * and a subset match would score it as a pass.
 */
export function diff(expected: unknown, actual: unknown, path: string, out: string[]): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push(`${path}: expected an array, got ${describe(actual)}`);
      return;
    }
    if (expected.length !== actual.length) {
      out.push(`${path}: expected ${expected.length} item(s), got ${actual.length}`);
      return;
    }
    expected.forEach((e, i) => diff(e, actual[i], `${path}[${i}]`, out));
    return;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      out.push(`${path}: expected an object, got ${describe(actual)}`);
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (value === undefined) continue; // a key the scenario left unset
      if (!(key in actual)) {
        out.push(`${path}.${key}: missing, expected ${describe(value)}`);
        continue;
      }
      diff(value, actual[key], `${path}.${key}`, out);
    }
    return;
  }
  if (!Object.is(expected, actual)) {
    out.push(`${path}: expected ${describe(expected)}, got ${describe(actual)}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(JSON.stringify(v) ?? v);
}
