// The live-mode voice orb. A thin adapter over expo-thinking-orbs'
// <ThinkingOrb> — the same dot-cloud the chat screen shows while it thinks,
// writes, or runs a tool (src/chat/ChatOrb.tsx) — so live mode and chat read
// as one assistant working, not two products. It owns the app's phase
// vocabulary and the violet palette rule, so the library is coupled to
// exactly this one file and swapping it again is a one-file change.
//
// Why adapt rather than use <ThinkingOrb> directly in live.tsx: the library's
// state union is six animations named for what an agent does, and none is
// 'connecting' or 'error'. Ours is five and is what the captions are keyed on.
// Mapping at this boundary keeps the conversation loop written in the app's
// own words.
//
// This replaced the library's <VoiceOrb> shell. The shell was a different
// object from the chat orb — a smooth sphere that swelled with the mic — and
// the two side by side read as unrelated. The six animations still follow
// the microphone through `bands`, so nothing was lost that the user could see.
import { ThinkingOrb, type OrbState } from 'expo-thinking-orbs';
import type { SharedValue } from 'react-native-reanimated';

import { useTheme } from '@/src/theme';

export type OrbPhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

// Which of the six animations says what the session is doing. Two looks, both
// borrowed from the chat screen (orbPhase.ts) so the same work looks the same
// on both screens:
//
//   'composing' — the dense banded ribbon chat shows while Writing. It is the
//                 conversation itself: the user talking (listening) and the
//                 assistant talking back (speaking). Dense enough to follow
//                 the mic visibly; the sparser designs barely register a voice.
//   'searching' — the dotted globe with a scan sweep, chat's tool-call loader.
//                 It is the assistant off doing something: loading models
//                 (connecting) and working out a reply (thinking). Frozen on
//                 error, which `paused` below does.
//
// The two alternate as the turn passes back and forth, so the switch itself
// says "your turn / my turn" before the caption does.
const TO_STATE: Record<OrbPhase, OrbState> = {
  connecting: 'searching',
  listening: 'composing',
  thinking: 'searching',
  speaking: 'composing',
  error: 'searching',
};

/** Spoken by screen readers. The library's own labels name the animation
 *  ('Solving…'), which is the wrong word here — the caption under the orb is
 *  the sighted user's label, and this is the same sentence in five words. */
const LABELS: Record<OrbPhase, string> = {
  connecting: 'Connecting…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  error: 'Live conversation stopped',
};

/**
 * Map the recorder's amplitude onto the orb's input range.
 *
 * `currentAmplitude()` is already `min(1, rms * 4)` — the linearly-scaled RMS.
 * Raising it to 0.7 spends the orb's range on speech instead of on the quiet
 * half of the scale; feed it raw otherwise and the dots barely move at
 * conversational volume. Attack/release smoothing already happens on the UI
 * thread inside the orb, so nothing is smoothed here.
 */
export const orbLevel = (amp: number): number => (amp > 0 ? amp ** 0.7 : 0);

const SIZE = 260;

/** The 64-dot design scaled to 260 spreads its dots faster than it grows
 *  them, and at this size the cloud reads as too fine for the sphere it
 *  describes (the library documents exactly this). Thicken the dots back;
 *  positions and count are untouched. */
const DOT_SCALE = 1.35;

export default function LiveOrb({
  phase,
  level,
}: {
  phase: OrbPhase;
  level: SharedValue<number>;
}) {
  const { colors, scheme } = useTheme();
  const failed = phase === 'error';
  return (
    <ThinkingOrb
      state={TO_STATE[phase]}
      paused={failed}
      // The mic drives the swell (low) and the travelling ripple (mid). There
      // is no band split on this path — one amplitude feeds both — which is
      // enough for the orb to visibly follow the user's voice. `high` is left
      // unset: it stands for sibilance and darkens the ink, and a whole-signal
      // RMS is not that — feeding it would darken the orb on every vowel.
      bands={{ low: level, mid: level }}
      size={SIZE}
      dotScale={DOT_SCALE}
      // Explicit, not 'auto': 'auto' reads the OS scheme, which is the wrong
      // answer for a user who pinned light or dark in Settings — the orb would
      // ink itself for a background the app is not drawing. Same as ChatOrb.
      theme={scheme}
      // The orb is the voice surface, so it stays in the violet family and only
      // the ramp moves — see the palette note in src/theme/palette.ts. Two
      // endpoints make the ink drift along the gradient on the orb's own clock.
      // The chat orb is deliberately untinted for the same rule.
      color={failed ? colors.danger : colors.accent}
      colorTo={failed ? colors.danger : colors.accentDeep}
      accessibilityLabel={LABELS[phase]}
    />
  );
}
