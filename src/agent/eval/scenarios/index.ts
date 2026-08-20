// The scenario corpus: the automated successor to the manual device pass in
// `docs/agent-tool-test-sheet.md`, and the thing Phase 0's score table is
// computed over.
//
// Grouped by tool area because the score table is grouped that way — a run that
// is 95% overall and 40% on dates is a very different report from one that is
// 95% everywhere, and only the grouping shows it.
//
// Parsing happens HERE, once, at import: a scenario that does not satisfy
// `ScenarioSchema` names itself and stops the run rather than reaching the
// runner as a half-valid object and being scored as a model failure.
import { ScenarioSchema, type Scenario } from '@/src/agent/eval/types';

import { CALENDAR_SCENARIOS } from './calendar';
import { CONTACT_SCENARIOS } from './contacts';
import { CONVERSATION_SCENARIOS } from './conversation';
import type { ScenarioInput } from './define';
import { DEVICE_SCENARIOS } from './device';
import { FAILURE_SCENARIOS } from './failure';
import { MEDIA_SCENARIOS } from './media';
import { MULTISTEP_SCENARIOS } from './multistep';
import { WEB_SCENARIOS } from './web';

export {
  CALENDAR_SCENARIOS,
  CONTACT_SCENARIOS,
  CONVERSATION_SCENARIOS,
  DEVICE_SCENARIOS,
  FAILURE_SCENARIOS,
  MEDIA_SCENARIOS,
  MULTISTEP_SCENARIOS,
  WEB_SCENARIOS,
};

/** Every scenario as authored, before defaults are applied. Exported for the
 *  corpus's own test, which reports each failure with the id attached. */
export const ALL_SCENARIO_INPUTS: ScenarioInput[] = [
  ...CALENDAR_SCENARIOS,
  ...CONTACT_SCENARIOS,
  ...DEVICE_SCENARIOS,
  ...WEB_SCENARIOS,
  ...MEDIA_SCENARIOS,
  ...CONVERSATION_SCENARIOS,
  ...FAILURE_SCENARIOS,
  ...MULTISTEP_SCENARIOS,
];

export const ALL_SCENARIOS: Scenario[] = ALL_SCENARIO_INPUTS.map((input, i) => {
  const parsed = ScenarioSchema.safeParse(input);
  if (!parsed.success) {
    const where = typeof input.id === 'string' ? input.id : `#${i}`;
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'scenario'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Scenario "${where}" is malformed — ${issues}`);
  }
  return parsed.data;
});

/** Scenarios with no `script`: they need a real engine, because the thing under
 *  test is what a model DECIDES, and a canned decision would only assert the
 *  script back at itself. Skipped by a replay run, scored by a live one. */
export const LIVE_ONLY_SCENARIOS: Scenario[] = ALL_SCENARIOS.filter((s) => !s.script.length);
