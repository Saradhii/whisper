// The real tool registry, built for tests without touching Expo.
//
// WHY THIS EXISTS RATHER THAN A BUILDER IN EACH TEST FILE.
// This seven-line recipe was copied byte-identically into prompt.test.ts,
// dstDates.test.ts and appendOnly.test.ts, and re-typed for every ad-hoc probe
// on top of that. Its failure mode is silent: get the schema wrong and you do
// not get an error, you get a plausible number. A probe that built the catalog
// from `z.object({})` measured the system message ~950 characters short of the
// real one — the right order of magnitude, and smaller in exactly the direction
// a token-trimming pass hopes to see, so it read as a finding rather than a
// mistake. The missing characters were every argument description in the
// catalog. Prefer these exports to hand-rolling; that is the whole point.
import { TOOL_DEFS } from '@/src/agent/toolDefs';
import { paramsToJsonSchema, type AnyTool } from '@/src/agent/types';
import { z } from 'zod';

/**
 * Every declared tool, exactly as the app registers it, minus the executors.
 *
 * `requiresConfirmation` and `mutates` are carried through DELIBERATELY, and
 * that is the part worth reading. Every hand-rolled copy this replaces dropped
 * them, which was harmless for prompt rendering — `toolCatalog` and
 * `renderExamples` read name, description and jsonSchema and nothing else — and
 * a trap for anything else. `loop.ts` reads both: line 386 gates the
 * confirmation card on `requiresConfirmation`, and line 400 sets `acted` from
 * `mutates`, which chooses the branch `answerNote` takes.
 *
 * So a fixture without them is not a slightly incomplete tool list, it is a
 * WORLD in which no tool can require confirmation and nothing can ever count as
 * having acted: the confirmation card never renders, every turn takes the
 * read framing, and the denial branch — the one answerNote documents as
 * outranking everything else, written because a user tapped Deny and was told
 * "I already scheduled the reminder" — becomes unreachable. Nothing errors and
 * the tests pass. The omission is laid directly under the most safety-critical
 * path in the loop, which is exactly why it would not be found later.
 *
 * `run` and `label` are stubs because no test needs them; if one does, it wants
 * the real `TOOLS` and an Expo environment, not this.
 */
export const realTools: AnyTool[] = Object.entries(TOOL_DEFS).map(([name, d]) => ({
  name,
  description: d.description,
  jsonSchema: paramsToJsonSchema(d.params),
  requiresConfirmation: d.requiresConfirmation,
  mutates: d.mutates,
  label: () => name,
  run: async () => '',
}));

/**
 * The same registry with every argument schema emptied — names and descriptions
 * intact, no arguments at all.
 *
 * Exported so that someone who genuinely wants a minimal catalog (measuring
 * what the argument descriptions cost, say) takes this instead of building it
 * by hand and mistaking it for the real thing. The gap between the two is 954
 * characters and that number is the durable one: it is the catalog's argument
 * descriptions and nothing else, so it survives prompt edits that move the
 * absolute sizes around — it was already unchanged across the pass that took
 * the date table out of `systemPrompt` (6775 vs 5821 after, 7026 vs 6072
 * before, 954 both times). tools.test.ts pins it. Never use this as a stand-in
 * for `realTools`.
 */
export const emptySchemaTools: AnyTool[] = Object.entries(TOOL_DEFS).map(([name, d]) => ({
  name,
  description: d.description,
  jsonSchema: paramsToJsonSchema(z.object({})),
  requiresConfirmation: d.requiresConfirmation,
  mutates: d.mutates,
  label: () => name,
  run: async () => '',
}));
