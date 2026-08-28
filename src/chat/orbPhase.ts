// What the chat screen is waiting FOR, and which of expo-thinking-orbs' six
// animations says so. Kept pure and separate from the component for two
// reasons: the mapping is worth testing without a renderer, and two different
// surfaces read it — the footer bubble and the running tool chip — which must
// never disagree about what the turn is doing.
import type { OrbState } from 'expo-thinking-orbs';

import { TOOL_DEFS } from '@/src/agent/toolDefs';

/** What the turn is doing during a wait the user can see. */
export type ThinkingPhase =
  /** Prefilling — the model has the prompt and has produced nothing yet. */
  | { kind: 'thinking' }
  /** A tool is executing. `name` is the tool key from the agent event. */
  | { kind: 'tool'; name: string }
  /** A tool returned; the model is prefilling its reply about the result. */
  | { kind: 'composing' };

/** How a phase is drawn: one of the six shipped animations, and the verb. */
export type OrbLook = { state: OrbState; label: string };

// Module-level constants rather than literals built per call: these are passed
// as props, and a fresh object every render would defeat the memo on the
// components that take them.
const THINKING: OrbLook = { state: 'solving', label: 'Thinking' };
const COMPOSING: OrbLook = { state: 'composing', label: 'Writing' };
const READING: OrbLook = { state: 'searching', label: 'Searching' };
const ACTING: OrbLook = { state: 'working', label: 'Working' };

/**
 * Pick the animation for a phase.
 *
 * A tool's look is derived from the registry's own `mutates` flag rather than a
 * second list of tool names kept here — reading tools sweep (`searching`),
 * writing tools drive (`working`). A per-tool table would be one more place to
 * forget when a tool is added, and it would fail silently: the orb would just
 * animate wrongly, which nothing tests and no one reports.
 *
 * An unknown name reads as a search. It is the safer default of the two — a
 * tool this file has never heard of has not been established to change
 * anything, and `working` would claim it did.
 */
export function orbLook(phase: ThinkingPhase): OrbLook {
  if (phase.kind === 'thinking') return THINKING;
  if (phase.kind === 'composing') return COMPOSING;
  const def = TOOL_DEFS[phase.name as keyof typeof TOOL_DEFS] as { mutates?: boolean } | undefined;
  return def?.mutates ? ACTING : READING;
}
