// The eval harness contract. Three pieces are built against this file and
// nothing else: the replay runner (fixture engine + fake tools), the on-device
// trajectory recorder, and the scenario corpus. It exists so those three can be
// written independently without inventing three incompatible formats.
//
// Pure module — zod and TypeScript only, no Expo, no react-native — because the
// whole point is that the agent loop runs end-to-end in Node with no device.
//
// Two modes share these types:
//   replay — canned completions stand in for the model, so a harness change is
//            scored deterministically in CI with no weights on disk.
//   live   — a real engine answers, so we measure what the model actually does.
// Scenarios describe expectations identically in both; only the engine differs.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// The fake world
// ---------------------------------------------------------------------------

/**
 * Every piece of device state the 18 tools in `toolDefs.ts` can read or write.
 *
 * This is the substitute for a phone. A scenario declares the world it starts
 * in, the runner binds the tool registry to a mutable copy, and the scenario's
 * `expect.world` asserts against the copy afterwards — the final-state check
 * that catches "the model said it set the alarm" when no alarm exists.
 *
 * Everything is optional so a scenario only declares what it cares about;
 * `emptyWorld()` fills the rest.
 */
export const WorldSchema = z.object({
  contacts: z
    .array(
      z.object({
        name: z.string(),
        phone: z.string().optional(),
        email: z.string().optional(),
      }),
    )
    .default([]),
  calendarEvents: z
    .array(
      z.object({
        title: z.string(),
        /** Local ISO, no timezone suffix: 2026-08-12T13:00 */
        start: z.string(),
        durationMinutes: z.number().int().default(60),
        location: z.string().optional(),
      }),
    )
    .default([]),
  alarms: z
    .array(z.object({ hour: z.number().int(), minute: z.number().int(), label: z.string().optional() }))
    .default([]),
  reminders: z
    .array(z.object({ message: z.string(), at: z.string() }))
    .default([]),
  /** Filenames only — `mediaMatches()` is what's under test, not real files. */
  media: z
    .array(z.object({ filename: z.string(), type: z.enum(['photo', 'video', 'audio']), at: z.string() }))
    .default([]),
  clipboard: z.string().default(''),
  battery: z.object({ level: z.number().min(0).max(1), charging: z.boolean() }).default({
    level: 0.72,
    charging: false,
  }),
  brightness: z.number().min(0).max(1).default(0.5),
  location: z
    .object({ latitude: z.number(), longitude: z.number(), address: z.string().optional() })
    .nullable()
    .default(null),
  /** Canned web results keyed by query substring; a miss returns "no results". */
  webResults: z.record(z.string(), z.string()).default({}),
  /** Canned page text keyed by URL. */
  webPages: z.record(z.string(), z.string()).default({}),

  // --- side effects that only OPEN something (composer, dialer, maps, url) ---
  // These tools mutate nothing on a real phone either; they hand off to another
  // app. Recording the handoff is how we assert it happened.
  opened: z
    .array(
      z.object({
        kind: z.enum(['dialer', 'sms', 'email', 'maps', 'url']),
        detail: z.string(),
      }),
    )
    .default([]),

  /**
   * Tool names that should THROW when called, mapped to the error message.
   * Drives the failure branches — a permission denial, a calendar read that
   * threw — which are the paths `answerNote()` has the most rules about and
   * which no device test reliably reproduces.
   */
  failing: z.record(z.string(), z.string()).default({}),
});

export type World = z.infer<typeof WorldSchema>;

export function emptyWorld(patch: Partial<World> = {}): World {
  return WorldSchema.parse(patch);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * One expected tool call. `args` is a PARTIAL deep match: a scenario asserts the
 * arguments it cares about (hour, minute, date) and ignores the rest, so adding
 * an optional parameter to a tool doesn't invalidate the corpus.
 */
export const ExpectedCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});

export type ExpectedCall = z.infer<typeof ExpectedCallSchema>;

/**
 * How the user's turn should be answered.
 *
 * `mustNotContain` earns its place: the regressions this project has actually
 * shipped were the model claiming a denied action happened, and a failed read
 * reported as an empty one. Those are asserted as forbidden strings, not as
 * fuzzy quality scores.
 */
export const ExpectedAnswerSchema = z.object({
  mustContain: z.array(z.string()).default([]),
  mustNotContain: z.array(z.string()).default([]),
  /** Case-insensitive substring matching (the default) vs. regex. */
  regex: z.boolean().default(false),
});

export const ScenarioTurnSchema = z.object({
  user: z.string(),
  /** Confirmation cards: what the user taps for each `requiresConfirmation`
   *  tool, in order. Defaults to approving everything. `false` exercises the
   *  refusal branch, which outranks every other rule in `answerNote()`. */
  confirmations: z.array(z.boolean()).default([]),
  expect: z
    .object({
      /** Ordered. `[]` asserts NO tool ran — the "most turns need no tool"
       *  property, which is what regressed when the old recover phase turned
       *  "thanks, that's all" into a web search. */
      calls: z.array(ExpectedCallSchema).default([]),
      /** Allow calls beyond those listed (default: no — extra calls fail). */
      allowExtraCalls: z.boolean().default(false),
      answer: ExpectedAnswerSchema.default({ mustContain: [], mustNotContain: [], regex: false }),
    })
    .default({ calls: [], allowExtraCalls: false, answer: { mustContain: [], mustNotContain: [], regex: false } }),
});

export type ScenarioTurn = z.infer<typeof ScenarioTurnSchema>;

/**
 * A canned model completion for replay mode.
 *
 * `when` is matched against the fully-rendered prompt the loop would send. It
 * exists because a purely positional script breaks the moment the harness adds
 * or removes a generation — which is exactly the kind of change this harness is
 * built to evaluate. Prefer `when`; fall back to order for simple cases.
 */
export const ScriptedResponseSchema = z.object({
  when: z.string().optional(),
  /** Treat `when` as a regex rather than a substring. */
  regex: z.boolean().default(false),
  /** Raw text the fake engine returns — decision JSON, or the final answer. */
  text: z.string(),
});

export type ScriptedResponse = z.infer<typeof ScriptedResponseSchema>;

export const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Which tool group this exercises — used to group the score table. */
  tags: z.array(z.string()).default([]),
  /**
   * Frozen wall clock, local ISO with no timezone suffix (2026-08-12T09:15).
   * Non-negotiable: `planNote()` renders a seven-day date table off `now`, and
   * every date assertion in the corpus is relative to it. A scenario that used
   * the real clock would pass today and fail tomorrow.
   */
  now: z.string(),
  /** Tool names available this run. Empty = the full registry. Restricting the
   *  set is how selective-disclosure work (Phase 1) gets measured. */
  tools: z.array(z.string()).default([]),
  world: WorldSchema.default(emptyWorld()),
  turns: z.array(ScenarioTurnSchema).min(1),
  /** Asserted against the world AFTER all turns. Partial deep match, same rule
   *  as `ExpectedCall.args`. */
  expectWorld: WorldSchema.partial().default({}),
  /** Replay-mode script. Omit for a live-only scenario. */
  script: z.array(ScriptedResponseSchema).default([]),
});

export type Scenario = z.infer<typeof ScenarioSchema>;

// ---------------------------------------------------------------------------
// Recorded trajectories (device → disk → replay)
// ---------------------------------------------------------------------------

/**
 * One generation as it actually happened on a device: what went in, what came
 * out, how long it took. A file of these replays into the fixture engine, and
 * doubles as the training corpus for the tool-calling LoRA (see
 * docs/model-strategy.md) — which is why the full prompt is kept, not a hash.
 */
export const RecordedGenerationSchema = z.object({
  /** 0-based index within the turn. */
  index: z.number().int(),
  phase: z.enum(['plan', 'answer']),
  /** Every message sent to the engine, in order. */
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  /** Stable hash of `messages`, so replay can warn when a harness change has
   *  made the recording stale rather than silently scoring against a prompt the
   *  model never saw. */
  promptHash: z.string(),
  grammar: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  /** Raw completion text. */
  text: z.string(),
  ms: z.number(),
});

export const RecordedToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: z.enum(['done', 'denied', 'error']),
  result: z.string(),
  ms: z.number(),
});

export const TrajectorySchema = z.object({
  /** Schema version. Every persisted format in this app needs one; this is the
   *  first that has it from day one. */
  v: z.literal(1),
  id: z.string(),
  /** ms epoch when the turn started. */
  at: z.number(),
  modelId: z.string(),
  /** The user's message that opened the turn. */
  request: z.string(),
  generations: z.array(RecordedGenerationSchema),
  toolCalls: z.array(RecordedToolCallSchema),
  /** Final text shown to the user. */
  answer: z.string(),
  /** Per-phase wall clock, for the Phase 2 time-to-first-audio budget. */
  timings: z.object({
    totalMs: z.number(),
    planMs: z.number(),
    toolMs: z.number(),
    answerMs: z.number(),
  }),
});

export type Trajectory = z.infer<typeof TrajectorySchema>;
export type RecordedGeneration = z.infer<typeof RecordedGenerationSchema>;

/**
 * Stable hash over a message list. Shared by the recorder (writing) and the
 * replay runner (drift detection), so it MUST live here and MUST NOT change
 * without bumping `TrajectorySchema.v` — recordings made under a different hash
 * would silently stop matching.
 */
export function hashMessages(messages: { role: string; content: string }[]): string {
  const text = messages.map((m) => `${m.role} ${m.content}`).join('');
  // FNV-1a, 32-bit. Not cryptographic — this only needs to detect drift.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/**
 * The metrics the 2026 agent-eval literature converges on, minus the ones that
 * need a judge model. Argument correctness is scored separately from tool
 * correctness on purpose: this project's recurring failure has been the RIGHT
 * tool with the WRONG arguments ("6pm today" → 16:00, "Friday at 1pm" → Monday
 * noon), and a combined score hides exactly that.
 */
export type TurnScore = {
  scenarioId: string;
  turnIndex: number;
  /** Every assertion passed. */
  completed: boolean;
  /** Expected tools called, in order, no unexpected ones. */
  toolCorrect: boolean;
  /** Every asserted argument matched on every expected call. */
  argsCorrect: boolean;
  /** Answer satisfied mustContain / mustNotContain. */
  answerCorrect: boolean;
  /** Planning generations spent. Lower is better; a rise means the loop is
   *  churning even when the final answer is right. */
  steps: number;
  totalMs: number;
  /** Human-readable assertion failures, for the score table. */
  failures: string[];
};

export type ScoreReport = {
  scenarios: number;
  turns: number;
  completed: number;
  toolCorrect: number;
  argsCorrect: number;
  answerCorrect: number;
  meanSteps: number;
  meanMs: number;
  /** Recordings whose promptHash no longer matches — stale, needs re-recording. */
  drifted: number;
  perTurn: TurnScore[];
};
