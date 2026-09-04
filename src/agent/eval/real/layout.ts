// Prompt surgery, applied on the way to the real model.
//
// ACCURACY ONLY — see the banner in ./model.ts.
//
// Two jobs, both of which exist because the thing under test is what a REAL
// planner decides when the prompt is arranged differently:
//
//   ablations — deliberately remove a section that is believed to be load
//               bearing, to prove this harness can detect its loss. A gate that
//               has never been shown to fail is not a gate.
//   layouts   — render the SAME turn under the pre-A1 prompt arrangement, so
//               "did moving the date table into the system prefix cost date
//               accuracy?" becomes a diff between two runs instead of an
//               opinion.
//
// Everything here is string surgery on the messages the loop already built, and
// NOT an edit to `prompt.ts`. That is deliberate: an experiment must be a flag
// on one run, never a diff someone can forget to revert. The cost is that these
// landmarks can go stale when the prompt is reworded, so every one of them is
// asserted against the real rendered prompt in `layout.test.ts`, and a miss
// throws instead of silently doing nothing — a no-op ablation would report
// "removing the date table changed nothing", the most misleading result this
// harness could produce.
import type { AgentMessage } from '@/src/engines/types';

// --- landmarks, all copied from src/agent/prompt.ts ------------------------
/** Heads the date table inside `systemPrompt()`. */
const SYS_DATES = 'Dates (copy from this list, never work one out):\n';
/** Opens `turnReference()` / `legacyPlanNote()`. */
const REF_HEAD = '[Reference, not a request';
/** Opens the fenced relative-time sentence in `relativeTimes()`. */
const RELATIVE = 'Use ONLY if I say';
/** Separates the reference bracket from the echoed request in `turnReference()`. */
const ASKED = '\nWhat I actually asked you: ';
/** The one sentence `planInstruction()` always ends with. */
const PROTOCOL = 'Reply with exactly one JSON object:';

function fail(what: string, marker: string): never {
  throw new Error(
    `prompt surgery could not find ${JSON.stringify(marker)} while applying "${what}". ` +
      `src/agent/prompt.ts has been reworded — update the landmarks in ` +
      `src/agent/eval/real/layout.ts. This throws rather than skipping because a ` +
      `transform that quietly did nothing would report an experiment as "no change".`,
  );
}

// ---------------------------------------------------------------------------
// Ablations
// ---------------------------------------------------------------------------

export type Ablation =
  /** Ship exactly what `prompt.ts` renders. */
  | 'none'
  /** Remove the seven-day date table from the system prefix. Isolates the
   *  TABLE; the wall clock, today's date and the relative times all remain. */
  | 'dates'
  /** Remove the date table AND the relative-time anchors — the full "no lookup
   *  table, do the arithmetic yourself" condition that the anchors exist to
   *  prevent. */
  | 'anchors';

export const ABLATIONS: Ablation[] = ['none', 'dates', 'anchors'];

/** Cut the date table out of the system message. */
function stripDateTable(content: string): string {
  const start = content.indexOf(SYS_DATES);
  if (start < 0) fail('dates', SYS_DATES);
  // The table is one line; the block ends at the blank line after it.
  const end = content.indexOf('\n\n', start + SYS_DATES.length);
  if (end < 0) fail('dates', 'the blank line after the date table');
  return content.slice(0, start) + content.slice(end + 2);
}

/**
 * Cut the fenced relative-time sentence out of the reference block.
 *
 * Returns the content unchanged when the block is absent, which is now the
 * COMMON case: `turnReference()` renders the relative times only when
 * `mentionsTime(request)` says the user named one. A missing block here is
 * therefore normal and must not throw — unlike a missing date table, which
 * would mean the landmark had gone stale.
 */
function stripRelativeTimes(content: string): string {
  const start = content.indexOf(RELATIVE);
  if (start < 0) return content;
  const end = content.indexOf(']', start);
  if (end < 0) fail('anchors', 'the ] closing the reference block');
  return content.slice(0, start) + content.slice(end);
}

/**
 * Apply an ablation to one message, or return null if it does not apply here.
 *
 * Null means "not this message" — the system prompt, a tool result, the user's
 * own turn. It never means "landmark missing"; that throws.
 */
export function ablate(content: string, mode: Ablation): string | null {
  if (mode === 'none') return null;
  const isSystem = content.includes(SYS_DATES);
  const isRef = content.startsWith(REF_HEAD);
  if (isSystem) return stripDateTable(content);
  if (isRef && mode === 'anchors') return stripRelativeTimes(content);
  return null;
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

export type Layout =
  /** The shipped, append-only arrangement: date table in the system prefix, a
   *  reference block placed once after the history, a one-sentence instruction
   *  last. */
  | 'current'
  /** The pre-A1 arrangement: no date table in the system prefix, and one fat
   *  note carrying clock + dates + relative times + spent calls + request +
   *  protocol, re-rendered after EVERYTHING on every planning step. */
  | 'legacy'
  /**
   * Configuration C: A1's append-only STRUCTURE, with the date table moved back
   * next to the decision point.
   *
   * A1 bundled two independent changes — (a) make the turn append-only, so only
   * a short `planInstruction` is displaced per step, and (b) move the date table
   * out of the per-turn note into the system prefix. The A/B against `legacy`
   * indicts (b) and says nothing about (a); this layout separates them, keeping
   * (a) and undoing (b). It is the only arm in which the system prefix is
   * DATE-INDEPENDENT, which is what lets a prefix KV snapshot outlive midnight.
   */
  | 'table-in-note';

export const LAYOUTS: Layout[] = ['current', 'legacy', 'table-in-note'];

/**
 * Re-render a planning prompt in the pre-A1 layout.
 *
 * Reconstructed from the current messages rather than by calling
 * `legacyPlanNote()`, because the loop does not hand the engine `now`, the
 * spent-call list or the request as values — only as rendered text. Every piece
 * of the legacy note exists verbatim in the current prompt; this moves them
 * back into the arrangement they had before, which is precisely the variable
 * under test. `layout.test.ts` pins the result against the real
 * `legacyPlanNote()` output so the two cannot drift.
 *
 * Three changes, matching the three things A1 did:
 *   1. the date table comes out of the system prefix…
 *   2. …and goes back into the per-turn note, ahead of the relative times;
 *   3. the note moves from "once, after the history" to "last, after the
 *      decisions and results", and absorbs the trailing instruction — so a
 *      multi-step turn re-renders the whole thing per step, as it used to.
 */
export function toLegacyLayout(messages: AgentMessage[]): AgentMessage[] {
  const sysIndex = messages.findIndex((m) => m.content.includes(SYS_DATES));
  if (sysIndex < 0) fail('legacy', SYS_DATES);
  const system = messages[sysIndex]!;

  // Pull the table out of the system prefix, keeping its text to re-home.
  const tableStart = system.content.indexOf(SYS_DATES) + SYS_DATES.length;
  const tableEnd = system.content.indexOf('\n\n', tableStart);
  if (tableEnd < 0) fail('legacy', 'the blank line after the date table');
  const table = system.content.slice(tableStart, tableEnd).trim();

  const refIndex = messages.findIndex((m) => m.content.startsWith(REF_HEAD));
  if (refIndex < 0) fail('legacy', REF_HEAD);
  const ref = messages[refIndex]!.content;

  const instrIndex = messages.findIndex((m) => m.content.includes(PROTOCOL));
  if (instrIndex < 0) fail('legacy', PROTOCOL);
  const instr = messages[instrIndex]!.content;

  // Split the reference block into its bracket and the echoed request.
  const askedAt = ref.indexOf(ASKED);
  const bracket = askedAt < 0 ? ref : ref.slice(0, askedAt);
  const asked = askedAt < 0 ? '' : `${ref.slice(askedAt + 1)}\n`;

  // Split the instruction into the spent-calls line and the protocol sentence.
  const protoAt = instr.indexOf(PROTOCOL);
  const spent = instr.slice(0, protoAt);
  const protocol = instr.slice(protoAt);

  const withTable = spliceTable(bracket, table, 'legacy');

  const note: AgentMessage = {
    role: 'user',
    content: `${withTable}\n${spent}${asked}${protocol}`,
  };

  const strippedSystem: AgentMessage = { ...system, content: stripDateTable(system.content) };

  // Everything except the system message, the reference block and the trailing
  // instruction, in order — then the rebuilt note last.
  const middle = messages.filter(
    (_, i) => i !== sysIndex && i !== refIndex && i !== instrIndex,
  );
  return [strippedSystem, ...middle, note];
}

/**
 * Put the date table inside a reference bracket, where `legacyPlanNote()` puts
 * it: `[… DATE. Dates: <table> <relative times>]`.
 *
 * The relative-time sentence is now CONDITIONAL — `turnReference()` renders it
 * only when `mentionsTime(request)` is true — so most turns have no `Use ONLY
 * if I say …` to anchor against and the table goes just before the closing
 * bracket instead. Both arms of the A/B use this same helper, which is what
 * keeps the conditional-relative-times change held CONSTANT across the
 * comparison instead of leaking into it as a second variable.
 */
function spliceTable(bracket: string, table: string, what: string): string {
  const close = bracket.indexOf(']');
  if (close < 0) fail(what, 'the ] closing the reference block');
  const relAt = bracket.indexOf(RELATIVE);
  return relAt >= 0 && relAt < close
    ? `${bracket.slice(0, relAt)}Dates: ${table} ${bracket.slice(relAt)}`
    : `${bracket.slice(0, close)} Dates: ${table}${bracket.slice(close)}`;
}

/** Pull the date table out of the system prefix, returning both halves. */
function takeDateTable(content: string): { system: string; table: string } {
  const start = content.indexOf(SYS_DATES);
  if (start < 0) fail('table-in-note', SYS_DATES);
  const tableStart = start + SYS_DATES.length;
  const end = content.indexOf('\n\n', tableStart);
  if (end < 0) fail('table-in-note', 'the blank line after the date table');
  return {
    system: content.slice(0, start) + content.slice(end + 2),
    table: content.slice(tableStart, end).trim(),
  };
}

/**
 * Configuration C: keep A1's message ORDER, move only the date table.
 *
 * The table is spliced into the reference bracket immediately before the
 * relative-time sentence when there is one, and immediately before the closing
 * bracket when there is not — which is exactly where `legacyPlanNote()` puts
 * it, so C and `legacy` present the dates to the model identically and differ
 * only in where the note sits and what else is re-rendered around it. That is
 * the whole point: it isolates change (b) from change (a).
 */
export function toTableInNote(messages: AgentMessage[]): AgentMessage[] {
  const sysIndex = messages.findIndex((m) => m.content.includes(SYS_DATES));
  if (sysIndex < 0) fail('table-in-note', SYS_DATES);
  const { system, table } = takeDateTable(messages[sysIndex]!.content);

  const refIndex = messages.findIndex((m) => m.content.startsWith(REF_HEAD));
  if (refIndex < 0) fail('table-in-note', REF_HEAD);
  const ref = messages[refIndex]!.content;

  const splice = spliceTable(ref, table, 'table-in-note');

  return messages.map((m, i) => {
    if (i === sysIndex) return { ...m, content: system };
    if (i === refIndex) return { ...m, content: splice };
    return m;
  });
}

/**
 * The answer phase has no reference block and no planning instruction — it ends
 * with `answerNote()` — so only the system half of the layout change applies.
 * Detected by absence rather than by phase, because the engine sees messages,
 * not phases.
 */
export function applyLayout(messages: AgentMessage[], layout: Layout): AgentMessage[] {
  if (layout === 'current') return messages;
  const planning =
    messages.some((m) => m.content.startsWith(REF_HEAD)) &&
    messages.some((m) => m.content.includes(PROTOCOL));
  if (!planning) {
    // Both non-current arms take the table out of the prefix, and neither has a
    // note to put it back into on the answer phase. Stripping it keeps the
    // prefix byte-identical across the three arms' answer generations, so an
    // answer-side difference cannot be an artefact of the prefix differing.
    return messages.map((m) =>
      m.content.includes(SYS_DATES) ? { ...m, content: stripDateTable(m.content) } : m,
    );
  }
  return layout === 'legacy' ? toLegacyLayout(messages) : toTableInNote(messages);
}
