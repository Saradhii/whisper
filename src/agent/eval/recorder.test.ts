import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as Recorder from './recorder';
import { TrajectorySchema, hashMessages, type Trajectory } from './types';

let emitted: Trajectory[] = [];

beforeEach(() => {
  emitted = [];
  Recorder.setEnabled(false);
  Recorder.abandon();
  Recorder.setSink((t) => emitted.push(t));
  Recorder.setModelId('qwen3-1.7b-q4km');
});

afterEach(() => {
  Recorder.setEnabled(false);
  Recorder.setSink(null);
});

const PLAN_PROMPT = [
  { role: 'system', content: 'You are Whisper.' },
  { role: 'user', content: 'set an alarm for 7am' },
];

/** One complete turn: plan → tool → answer, the shape runAgent produces. */
function recordATurn(): void {
  Recorder.startTurn('set an alarm for 7am');
  Recorder.generation(
    'plan',
    PLAN_PROMPT,
    { grammar: 'root ::= toolcall', temperature: 0, maxTokens: 256 },
    '{"tool":"set_alarm","arguments":{"hour":7,"minute":0}}',
    120,
  );
  Recorder.toolCall('set_alarm', { hour: 7, minute: 0 }, 'done', 'Alarm set for 07:00.', 30);
  Recorder.generation(
    'answer',
    [...PLAN_PROMPT, { role: 'assistant', content: 'Result of set_alarm: ok' }],
    { maxTokens: 320 },
    'Done — alarm set for 7am.',
    240,
  );
  Recorder.finishTurn('Done — alarm set for 7am.');
}

describe('trajectory recorder', () => {
  it('records nothing while disabled', () => {
    recordATurn();
    expect(emitted).toHaveLength(0);
  });

  it('emits nothing when a turn was never started', () => {
    Recorder.setEnabled(true);
    // The loop calls generation()/toolCall() unconditionally; without a live
    // turn they must be inert rather than inventing one out of a fragment.
    Recorder.generation('plan', PLAN_PROMPT, {}, 'x', 1);
    expect(Recorder.finishTurn('hi')).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it('round-trips a recorded turn through TrajectorySchema', () => {
    Recorder.setEnabled(true);
    recordATurn();

    expect(emitted).toHaveLength(1);
    const trajectory = TrajectorySchema.parse(JSON.parse(JSON.stringify(emitted[0])));

    expect(trajectory.v).toBe(1);
    expect(trajectory.modelId).toBe('qwen3-1.7b-q4km');
    expect(trajectory.request).toBe('set an alarm for 7am');
    expect(trajectory.answer).toBe('Done — alarm set for 7am.');
    expect(trajectory.generations.map((g) => g.phase)).toEqual(['plan', 'answer']);
    expect(trajectory.generations.map((g) => g.index)).toEqual([0, 1]);
    expect(trajectory.generations[0]!.grammar).toBe('root ::= toolcall');
    expect(trajectory.generations[0]!.temperature).toBe(0);
    expect(trajectory.toolCalls).toEqual([
      { name: 'set_alarm', args: { hour: 7, minute: 0 }, status: 'done', result: 'Alarm set for 07:00.', ms: 30 },
    ]);
  });

  it('hashes the prompt with the shared hash so replay can detect drift', () => {
    Recorder.setEnabled(true);
    recordATurn();
    expect(emitted[0]!.generations[0]!.promptHash).toBe(hashMessages(PLAN_PROMPT));
  });

  it('splits wall clock by phase', () => {
    Recorder.setEnabled(true);
    recordATurn();
    const { timings } = emitted[0]!;
    expect(timings.planMs).toBe(120);
    expect(timings.toolMs).toBe(30);
    expect(timings.answerMs).toBe(240);
    expect(timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('copies the message list, so later mutation cannot rewrite history', () => {
    Recorder.setEnabled(true);
    const live = [...PLAN_PROMPT];
    Recorder.startTurn('set an alarm for 7am');
    Recorder.generation('plan', live, {}, '{}', 1);
    live.push({ role: 'user', content: 'Result of set_alarm: ok' }); // the loop does this
    Recorder.finishTurn('done');
    expect(emitted[0]!.generations[0]!.messages).toHaveLength(2);
  });

  it('drops the turn in progress when recording is switched off mid-turn', () => {
    Recorder.setEnabled(true);
    Recorder.startTurn('something private');
    Recorder.setEnabled(false);
    Recorder.setEnabled(true);
    expect(Recorder.finishTurn('answer')).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it('drops an abandoned (cancelled) turn', () => {
    Recorder.setEnabled(true);
    Recorder.startTurn('set an alarm');
    Recorder.abandon();
    expect(Recorder.finishTurn('answer')).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it('serializes to one JSONL line and reads back', () => {
    Recorder.setEnabled(true);
    recordATurn();
    const line = Recorder.toJsonl(emitted[0]!);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(Recorder.fromJsonl(line)).toEqual([emitted[0]]);
  });

  it('skips torn lines rather than losing the whole file', () => {
    Recorder.setEnabled(true);
    recordATurn();
    const good = Recorder.toJsonl(emitted[0]!);
    // A process kill mid-write leaves exactly this: a valid prefix and a stump.
    expect(Recorder.fromJsonl(`${good}{"v":1,"id":"tr`)).toHaveLength(1);
  });
});

describe('corpus bound', () => {
  const file = (name: string, kb: number) => ({ name, bytes: kb * 1024 });

  it('keeps everything while inside both limits', () => {
    expect(Recorder.overflow([file('traj-1.jsonl', 10), file('traj-2.jsonl', 10)])).toEqual([]);
  });

  it('rolls the oldest off when the file count is exceeded', () => {
    const files = Array.from({ length: 15 }, (_, i) => file(`traj-${1000 + i}.jsonl`, 1));
    expect(Recorder.overflow(files)).toEqual([
      'traj-1000.jsonl',
      'traj-1001.jsonl',
      'traj-1002.jsonl',
    ]);
  });

  it('rolls the oldest off when the byte total is exceeded', () => {
    const limits = { maxFiles: 100, maxTotalBytes: 25 * 1024, maxFileBytes: 10 * 1024 };
    const files = [file('traj-1.jsonl', 10), file('traj-2.jsonl', 10), file('traj-3.jsonl', 10)];
    expect(Recorder.overflow(files, limits)).toEqual(['traj-1.jsonl']);
  });

  it('never evicts the newest file, even alone over the byte cap', () => {
    const limits = { maxFiles: 1, maxTotalBytes: 1024, maxFileBytes: 1024 };
    expect(Recorder.overflow([file('traj-9.jsonl', 500)], limits)).toEqual([]);
  });

  it('orders by name, not by the order the directory listing came back in', () => {
    const limits = { maxFiles: 2, maxTotalBytes: 1024 * 1024, maxFileBytes: 1024 };
    const shuffled = [file('traj-3.jsonl', 1), file('traj-1.jsonl', 1), file('traj-2.jsonl', 1)];
    expect(Recorder.overflow(shuffled, limits)).toEqual(['traj-1.jsonl']);
  });
});
