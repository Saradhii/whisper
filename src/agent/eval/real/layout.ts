// Prompt surgery, applied on the way to the real model.
//
// ACCURACY ONLY — see the banner in ./model.ts.
//
// ============================ DIRECTION ============================
// Every transform here starts from the SHIPPED prompt and produces a
// COUNTERFACTUAL. The shipped prompt is now configuration C: the date table
// lives in `turnReference()`, next to the decision point, and `systemPrompt()`
// takes no `Date` at all.
//
// That inverts what this module used to do. When A1 was shipped, the baseline
// had the table in the system prefix and the transforms moved it OUT; now the
// baseline has it in the note and `toA1Layout` moves it IN. Getting a direction
// backwards would not fail — it would quietly measure a layout nobody runs, and
// report it as the product. So the direction is asserted, not assumed:
// `layout.test.ts` pins `current` as the literal identity, pins the legacy note
// against `legacyPlanNote()` itself, and pins the A1 prefix against the real
// pre-C `systemPrompt()` shape. If the baseline moves again those tests go red
// immediately rather than the harness going quietly wrong.
// ===================================================================
//
// Two jobs:
//   ablations — deliberately remove a section believed to be load bearing, to
//               prove this harness can detect its loss. A gate that has never
//               been shown to fail is not a gate.
//   layouts   — render the same turn under a prompt arrangement the app used to
//               have, so "did moving the date table cost accuracy?" is a diff
//               between two runs rather than an opinion.
//
// All of it is string surgery on the messages the loop already built, and NOT an
// edit to `prompt.ts`: an experiment must be a flag on one run, never a diff
// someone can forget to revert. The cost is that these landmarks go stale when
// the prompt is reworded, so a miss THROWS — a no-op transform would report
// "moving the date table changed nothing", the most misleading result available.
import type { AgentMessage } from '@/src/engines/types';

// --- landmarks, all copied from the SHIPPED src/agent/prompt.ts -------------
/** The date-table seam inside `turnReference()`, INCLUDING its leading space.
 *  Each seam there carries its own leading space by convention; consuming the
 *  space with the seam is what lets a transform remove it without leaving a
 *  double space behind — which would be a silent KV-cache miss, not an error. */
const REF_DATES = ' Dates (copy from this list, never work one out): ';
/** Opens `turnReference()` and `legacyPlanNote()`. */
const REF_HEAD = '[Reference, not a request';
/** Opens the (conditional) relative-time sentence from `relativeTimes()`. */
const RELATIVE = 'Use ONLY if I say';
/** Separates the reference bracket from the echoed request. */
const ASKED = '\nWhat I actually asked you: ';
/** The sentence `planInstruction()` always ends with. */
const PROTOCOL = 'Reply with exactly one JSON object:';
/** First line of `systemPrompt()`; A1 put `Today's date is …` right after it. */
const SYS_LINE1 = "You are Whisper, a helpful assistant running fully on the user's phone.\n";
/** Where A1's date block sat: immediately before the protocol paragraph. */
const SYS_ANCHOR = 'You do real things on this phone by calling tools.';
/** A1's heading for the table, on its own line. */
const A1_HEADING = 'Dates (copy from this list, never work one out):';

/** The date rule as SHIPPED (C), pointing at the note. */
const RULE_SHIPPED =
  '- Never work out a date yourself: copy it from the date list in the note\n' +
  '  below the conversation, and never copy one out of these examples. Hours\n' +
  '  are on a 24-hour clock, so 1pm is 13 and 6pm is 18.';
/** The same rule as A1 worded it, pointing at the top of the system message.
 *  Swapped along with the table: under A1 the pointer and the table moved
 *  together, and moving only one would be a third configuration nobody ran. */
const RULE_A1 =
  '- Never work out a date yourself: copy it from the date list near the top\n' +
  '  of this message, and never copy one out of these examples. Hours are on a\n' +
  '  24-hour clock, so 1pm is 13 and 6pm is 18.';

function fail(what: string, marker: string): never {
  throw new Error(
    `prompt surgery could not find ${JSON.stringify(marker)} while applying "${what}". ` +
      `src/agent/prompt.ts has been reworded — update the landmarks in ` +
      `src/agent/eval/real/layout.ts. This throws rather than skipping because a ` +
      `transform that quietly did nothing would report an experiment as "no change".`,
  );
}

const isSystem = (m: AgentMessage) => m.content.includes(SYS_ANCHOR);
const isRef = (m: AgentMessage) => m.content.startsWith(REF_HEAD);

/**
 * Put `Today's date is <D>.` back on line 2 of the system prefix.
 *
 * BOTH counterfactuals need this, and forgetting it in one of them is not a
 * theoretical risk — it happened. The first version of the rebased `legacy`
 * transform dropped this line, and the arm scored 9/15 on `dates` instead of
 * the 8/15 it had scored when measured directly, because the planner still had
 * today's date from somewhere. Configuration C deleted the line (that is what
 * makes its prefix date-independent), so a counterfactual for any EARLIER
 * layout has to restore it: pre-A1 and A1 both carried it.
 */
function withTodayLine(system: string, date: string, what: string): string {
  if (!system.startsWith(SYS_LINE1)) fail(what, SYS_LINE1);
  return `${SYS_LINE1}Today's date is ${date}.\n${system.slice(SYS_LINE1.length)}`;
}

/**
 * Split a reference block into the bracket without its date table, the table
 * itself, and the calendar date the clock line carries.
 *
 * The table runs from the end of the seam to whichever comes first: the
 * relative-time sentence (which has its own leading space, so the table ends one
 * character before it) or the closing bracket.
 */
function takeDates(ref: string, what: string): { without: string; table: string; date: string } {
  const at = ref.indexOf(REF_DATES);
  if (at < 0) fail(what, REF_DATES);
  const from = at + REF_DATES.length;
  const close = ref.indexOf(']', from);
  if (close < 0) fail(what, 'the ] closing the reference block');
  const relAt = ref.indexOf(RELATIVE, from);
  // ` Use ONLY…` — back up over the space that belongs to the relative seam.
  const to = relAt >= 0 && relAt < close ? relAt - 1 : close;
  const date = /\d{4}-\d{2}-\d{2}/.exec(ref);
  if (!date) fail(what, 'a YYYY-MM-DD date in the reference clock line');
  return {
    without: ref.slice(0, at) + ref.slice(to),
    table: ref.slice(from, to),
    date: date[0],
  };
}

// ---------------------------------------------------------------------------
// Ablations
// ---------------------------------------------------------------------------

export type Ablation =
  /** Ship exactly what `prompt.ts` renders. */
  | 'none'
  /** Remove the seven-day date table from the reference block, where the
   *  shipped prompt now keeps it. The wall clock, today's date and the
   *  relative times all remain, so a drop isolates the TABLE. */
  | 'dates'
  /** Remove the date table AND the relative-time anchors — the full "no lookup
   *  table, do the arithmetic yourself" condition the anchors exist to
   *  prevent. */
  | 'anchors';

export const ABLATIONS: Ablation[] = ['none', 'dates', 'anchors'];

/**
 * Cut the fenced relative-time sentence out of a reference block.
 *
 * Returns the content unchanged when the block is absent, which is the COMMON
 * case: `turnReference()` renders it only when `mentionsTime(request)` is true.
 * A missing relative block is therefore normal and must not throw — unlike a
 * missing date table, which would mean a landmark had gone stale.
 */
function stripRelativeTimes(content: string): string {
  const start = content.indexOf(RELATIVE);
  if (start < 0) return content;
  const end = content.indexOf(']', start);
  if (end < 0) fail('anchors', 'the ] closing the reference block');
  // Back up over the relative seam's own leading space.
  return content.slice(0, start - 1) + content.slice(end);
}

/**
 * Apply an ablation to one message, or return null if it does not apply here.
 *
 * Null means "not this message" — the system prompt, a tool result, the user's
 * own turn. It never means "landmark missing"; that throws.
 */
export function ablate(content: string, mode: Ablation): string | null {
  if (mode === 'none') return null;
  if (!content.startsWith(REF_HEAD)) return null;
  const { without } = takeDates(content, mode);
  return mode === 'dates' ? without : stripRelativeTimes(without);
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

export type Layout =
  /** Configuration C, as shipped: date table in `turnReference()`, append-only
   *  structure, date-independent system prefix. The IDENTITY transform. */
  | 'current'
  /**
   * The A1 counterfactual: the date table hoisted into the system prefix.
   *
   * This is the arrangement the real-model A/B rejected — the planner stopped
   * resolving named weekdays, because the table was no longer the last thing
   * read before the decision. Kept so that result stays reproducible, and so a
   * future prompt change can be checked against it rather than against memory.
   */
  | 'a1'
  /**
   * The pre-A1 counterfactual: one fat note carrying clock + dates + relative
   * times + spent calls + request + protocol, re-rendered after EVERYTHING on
   * every planning step.
   *
   * Only the note differs from the shipped layout now: C's system prefix
   * already carries no date table and already points the date rule at "the note
   * below the conversation", which is exactly what pre-A1 said. So this
   * transform touches the messages and not the prefix.
   */
  | 'legacy';

export const LAYOUTS: Layout[] = ['current', 'a1', 'legacy'];

/**
 * Move the date table INTO the system prefix, reproducing A1.
 *
 * A1's prefix opened:
 *     You are Whisper, …
 *     Today's date is <D>.
 *     (blank)
 *     Dates (copy from this list, never work one out):
 *     <anchors>
 *     (blank)
 *     You do real things on this phone …
 * and its date rule pointed "near the top of this message". Both move together.
 */
export function toA1Layout(messages: AgentMessage[]): AgentMessage[] {
  const refIndex = messages.findIndex(isRef);
  if (refIndex < 0) fail('a1', REF_HEAD);
  const { without, table, date } = takeDates(messages[refIndex]!.content, 'a1');

  const sysIndex = messages.findIndex(isSystem);
  if (sysIndex < 0) fail('a1', SYS_ANCHOR);
  const base = messages[sysIndex]!.content;
  if (!base.includes(RULE_SHIPPED)) fail('a1', RULE_SHIPPED);
  const system = withTodayLine(base, date, 'a1')
    .replace(`\n${SYS_ANCHOR}`, `\n${A1_HEADING}\n${table}\n\n${SYS_ANCHOR}`)
    .replace(RULE_SHIPPED, RULE_A1);

  return messages.map((m, i) => {
    if (i === sysIndex) return { ...m, content: system };
    if (i === refIndex) return { ...m, content: without };
    return m;
  });
}

/**
 * Rebuild the pre-A1 single note and move it to the end.
 *
 * Reconstructed from the current messages rather than by calling
 * `legacyPlanNote()`, because the loop hands the engine rendered text, not
 * `now` / the spent-call list / the request as values. Every piece exists
 * verbatim in the shipped prompt; this puts them back in the old arrangement.
 *
 * The system prefix needs exactly one edit: `Today's date is <D>.` restored to
 * line 2. Pre-A1 carried it and C removed it. Everything else already matches —
 * C's prefix has no date table, and its date rule already points at "the date
 * list in the note below the conversation", which is what pre-A1 said too. (The
 * A1 arm is the one that also has to move the table in and re-point the rule.)
 *
 * One deliberate fidelity limit: `legacyPlanNote()` renders the relative times
 * UNCONDITIONALLY, while `turnReference()` renders them only when the request
 * names a time. Reconstructing them for a turn that has none would need `now`,
 * which is not available here. So the conditional behaviour is held CONSTANT
 * across all arms instead — which is the right experimental choice anyway,
 * since it is a separate landed change and not the variable under test. The
 * test pins this transform against `legacyPlanNote()` on a time-mentioning
 * request, where the two are byte-identical.
 */
export function toLegacyLayout(messages: AgentMessage[]): AgentMessage[] {
  const refIndex = messages.findIndex(isRef);
  if (refIndex < 0) fail('legacy', REF_HEAD);
  const ref = messages[refIndex]!.content;

  const instrIndex = messages.findIndex((m) => m.content.includes(PROTOCOL));
  if (instrIndex < 0) fail('legacy', PROTOCOL);
  const instr = messages[instrIndex]!.content;

  const sysIndex = messages.findIndex(isSystem);
  if (sysIndex < 0) fail('legacy', SYS_ANCHOR);

  const { without, table, date } = takeDates(ref, 'legacy');

  // Split the reference block into its bracket and the echoed request.
  const askedAt = without.indexOf(ASKED);
  const bracket = askedAt < 0 ? without : without.slice(0, askedAt);
  const asked = askedAt < 0 ? '' : `${without.slice(askedAt + 1)}\n`;

  // Split the instruction into the spent-calls line and the protocol sentence.
  const protoAt = instr.indexOf(PROTOCOL);
  const spent = instr.slice(0, protoAt);
  const protocol = instr.slice(protoAt);

  // Legacy wrote the table as a bare `Dates: …`, with no "copy from this list"
  // heading, immediately after the clock sentence.
  const close = bracket.indexOf(']');
  if (close < 0) fail('legacy', 'the ] closing the reference block');
  const relAt = bracket.indexOf(RELATIVE);
  const withTable =
    relAt >= 0 && relAt < close
      ? `${bracket.slice(0, relAt)}Dates: ${table} ${bracket.slice(relAt)}`
      : `${bracket.slice(0, close)} Dates: ${table}${bracket.slice(close)}`;

  const note: AgentMessage = {
    role: 'user',
    content: `${withTable}\n${spent}${asked}${protocol}`,
  };

  // Match the system message by identity, not by index: the two removals above
  // shift every index after them, and an off-by-one here would edit the wrong
  // message silently.
  const system = messages[sysIndex]!;
  const middle = messages
    .filter((_, i) => i !== refIndex && i !== instrIndex)
    .map((m) => (m === system ? { ...m, content: withTodayLine(m.content, date, 'legacy') } : m));
  return [...middle, note];
}

/**
 * Dispatch, and the one place the identity is guaranteed.
 *
 * `current` returns the SAME array reference, so "the baseline arm is the
 * shipped prompt" is true by construction rather than by a transform that
 * happens to cancel out. The answer phase has no reference block and no
 * planning instruction — it ends with `answerNote()` — and under C its prompt
 * is already identical in every arm, because the date table was never in the
 * prefix to begin with. So it is returned untouched too, and the arms differ
 * only where they are meant to: the planning prompt.
 */
export function applyLayout(messages: AgentMessage[], layout: Layout): AgentMessage[] {
  if (layout === 'current') return messages;
  const planning = messages.some(isRef) && messages.some((m) => m.content.includes(PROTOCOL));
  if (!planning) return messages;
  return layout === 'a1' ? toA1Layout(messages) : toLegacyLayout(messages);
}
