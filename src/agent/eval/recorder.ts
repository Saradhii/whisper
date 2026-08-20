// Trajectory recorder: one `Trajectory` per agent turn, in the shape the replay
// runner eats.
//
// The failure this exists for is a process failure, not a code one. Every
// prompt, grammar and example change in this project has been validated by hand
// on an emulator, one request at a time — so the GBNF quoting fix that made
// tool calls parse at all went in blind, and "6pm today" landing at 16:00 was
// found by a human retyping the same sentence. A turn captured here replays
// through the fixture engine in Node, which is the only way a harness change
// gets scored instead of eyeballed. The full message list is kept rather than a
// hash because the same file doubles as the tool-calling LoRA corpus (see
// docs/model-strategy.md).
//
// Same discipline as trace.ts, and for a stronger reason: this holds the raw
// text of the user's requests — every message sent to the model, verbatim — and
// unlike the trace it is written to disk. So it is OFF by default and a genuine
// no-op when off. Nothing is allocated, nothing is copied, nothing is retained
// between turns until someone deliberately switches it on.
//
// Pure module. The sink is injected (the Expo file binding lives in
// recorderStore.ts) so the whole recording path runs under vitest in Node, the
// way historyBudget.ts and prompt.ts do.
import { z } from 'zod';

import {
  RecordedToolCallSchema,
  TrajectorySchema,
  hashMessages,
  type RecordedGeneration,
  type Trajectory,
} from './types';

type RecordedToolCall = z.infer<typeof RecordedToolCallSchema>;

/** Where a finished turn goes. Sync and fire-and-forget: the agent loop must
 *  never wait on, or fail because of, corpus capture. */
export type TrajectorySink = (trajectory: Trajectory) => void;

/** The subset of `GenerateOptions` that changes what the model produces, and so
 *  has to be replayed. `disableThinking` is deliberately not here: it is
 *  constant for every generation the loop makes. */
export type GenerationOptions = {
  grammar?: string;
  temperature?: number;
  maxTokens?: number;
};

type Message = { role: string; content: string };

/** A turn in progress. Never survives `finishTurn`/`abandon`. */
type LiveTurn = {
  id: string;
  at: number;
  request: string;
  generations: RecordedGeneration[];
  toolCalls: RecordedToolCall[];
  planMs: number;
  toolMs: number;
  answerMs: number;
};

let enabled = false;
let sink: TrajectorySink | null = null;
let modelId = 'unknown';
let seq = 0;
let live: LiveTurn | null = null;

/**
 * Recording is off by default; the Developer setting drives this. Turning it
 * off mid-turn drops whatever has been captured so far — a user who switches
 * this off has withdrawn consent for the request they are in the middle of,
 * not just for the next one.
 */
export function setEnabled(value: boolean): void {
  enabled = value;
  if (!enabled) live = null;
}

export function isEnabled(): boolean {
  return enabled;
}

/** Bind the persistence edge. `null` detaches it (nothing reaches disk). */
export function setSink(next: TrajectorySink | null): void {
  sink = next;
}

/** Which model produced the completions. Injected from the composition root so
 *  this module stays free of the model store (and therefore of Expo). */
export function setModelId(id: string): void {
  modelId = id || 'unknown';
}

/** Begin a turn. No-op, and allocation-free, while recording is off. */
export function startTurn(request: string): void {
  if (!enabled) {
    live = null;
    return;
  }
  live = {
    id: `j${Date.now().toString(36)}${(++seq).toString(36)}`,
    at: Date.now(),
    request,
    generations: [],
    toolCalls: [],
    planMs: 0,
    toolMs: 0,
    answerMs: 0,
  };
}

/** Record one completion. `messages` is copied: the loop mutates its array as
 *  the turn proceeds, and a recording that aliased it would end up describing
 *  the prompt of the LAST generation for every generation. */
export function generation(
  phase: 'plan' | 'answer',
  messages: readonly Message[],
  options: GenerationOptions,
  text: string,
  ms: number,
): void {
  if (!enabled || !live) return;
  const copied = messages.map((m) => ({ role: m.role, content: m.content }));
  live.generations.push({
    index: live.generations.length,
    phase,
    messages: copied,
    promptHash: hashMessages(copied),
    ...(options.grammar !== undefined ? { grammar: options.grammar } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    text,
    ms,
  });
  if (phase === 'plan') live.planMs += ms;
  else live.answerMs += ms;
}

/**
 * Record one executed tool call — the arguments AFTER the tool's zod parse
 * rejected or accepted them, which is the pair the corpus is actually about:
 * this project's recurring regression is the right tool with the wrong
 * arguments, and a score that cannot see the arguments cannot catch it.
 *
 * Only real attempts reach here. A suppressed repeat or an unknown tool name
 * never touched the tool and has no status in `RecordedToolCallSchema`.
 */
export function toolCall(
  name: string,
  args: Record<string, unknown>,
  status: RecordedToolCall['status'],
  result: string,
  ms: number,
): void {
  if (!enabled || !live) return;
  live.toolCalls.push({ name, args, status, result, ms });
  live.toolMs += ms;
}

/** Drop the turn in progress without emitting it. Used when the user cancels:
 *  a turn that never answered is not a trajectory, and scoring it as one would
 *  count a cancellation as a failure the harness could chase forever. */
export function abandon(): void {
  live = null;
}

/**
 * Close the turn and hand it to the sink. Returns the trajectory (for tests and
 * callers that want it), or null when nothing was being recorded.
 *
 * Validated here because this is the only place that writes. A line that does
 * not satisfy `TrajectorySchema` is worse than a missing one — the replay
 * runner reads a whole file, and one malformed record would take the rest of
 * the corpus with it. Dropping the odd turn is the cheap failure.
 */
export function finishTurn(answer: string): Trajectory | null {
  const turn = live;
  live = null;
  if (!enabled || !turn) return null;

  const parsed = TrajectorySchema.safeParse({
    v: 1,
    id: turn.id,
    at: turn.at,
    modelId,
    request: turn.request,
    generations: turn.generations,
    toolCalls: turn.toolCalls,
    answer,
    timings: {
      totalMs: Date.now() - turn.at,
      planMs: turn.planMs,
      toolMs: turn.toolMs,
      answerMs: turn.answerMs,
    },
  });
  if (!parsed.success) return null;
  sink?.(parsed.data);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// JSONL + bounds (pure, so the persistence edge holds no policy)
// ---------------------------------------------------------------------------

/** One trajectory as one line. JSONL and not a JSON array so a file being
 *  appended to is always readable, and a truncated tail costs one turn. */
export function toJsonl(trajectory: Trajectory): string {
  return `${JSON.stringify(trajectory)}\n`;
}

/** Read a corpus file back, skipping lines that don't parse — a file that was
 *  cut mid-write by a process kill must still replay everything before the cut. */
export function fromJsonl(text: string): Trajectory[] {
  const out: Trajectory[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = TrajectorySchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // not JSON — a torn line, skip it
    }
  }
  return out;
}

export type CorpusFile = { name: string; bytes: number };

export type CorpusLimits = {
  maxFiles: number;
  maxTotalBytes: number;
  /** Roll to a new file past this, so no single file grows unbounded within a
   *  long session and so the roll-off granularity stays useful. */
  maxFileBytes: number;
};

/**
 * The cap on what recording may leave on the phone. Deliberately small: a
 * trajectory carries every prompt in full, so ~20 KB a turn is normal, and a
 * corpus this size is still hundreds of turns — far more than anyone records
 * before pulling it off. The point of the bound is that a user who forgets the
 * toggle is on cannot end up with a growing file of everything they ever said.
 */
export const CORPUS_LIMITS: CorpusLimits = {
  maxFiles: 12,
  maxTotalBytes: 4 * 1024 * 1024,
  maxFileBytes: 256 * 1024,
};

/**
 * Which files have to go for the corpus to fit its bounds, oldest first.
 *
 * Names are `traj-<epoch>.jsonl`, so lexicographic order is chronological;
 * sorting here rather than trusting the caller keeps the policy in the pure
 * module where it is tested. The newest file is never named: it is the one
 * being appended to, and evicting it would delete the recording the user just
 * made in order to satisfy a limit it alone cannot breach.
 */
export function overflow(files: CorpusFile[], limits: CorpusLimits = CORPUS_LIMITS): string[] {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let count = ordered.length;
  let bytes = ordered.reduce((sum, f) => sum + f.bytes, 0);
  const doomed: string[] = [];
  for (const file of ordered) {
    if (count <= 1) break;
    if (count <= limits.maxFiles && bytes <= limits.maxTotalBytes) break;
    doomed.push(file.name);
    count--;
    bytes -= file.bytes;
  }
  return doomed;
}
