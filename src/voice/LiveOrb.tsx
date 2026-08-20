// The live-mode voice orb. A thin adapter over expo-thinking-orbs' <VoiceOrb>:
// it owns the app's phase vocabulary and the violet palette rule, so the
// library is coupled to exactly this one file and swapping it again is a
// one-file change.
//
// Why adapt rather than use <VoiceOrb> directly in live.tsx: the library's
// state union is LiveKit's AgentState — nine members, and no 'error'. Ours is
// five and is what the captions are keyed on. Mapping at this boundary keeps
// the conversation loop written in the app's own words.
import { VoiceOrb, type VoiceOrbState } from 'expo-thinking-orbs';
import type { SharedValue } from 'react-native-reanimated';

import { useTheme } from '@/src/theme';

export type OrbPhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

// Four of the five are already the same string in both unions; only 'error'
// needs a decision. 'failed' freezes the shell on its current frame, which is
// the right read for a dead session — 'disconnected', the other candidate,
// keeps hunting for a signal it is never going to get.
const TO_VOICE_STATE: Record<OrbPhase, VoiceOrbState> = {
  connecting: 'connecting',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  error: 'failed',
};

/**
 * Map the recorder's amplitude onto the orb's input range.
 *
 * `currentAmplitude()` is already `min(1, rms * 4)` — the linearly-scaled RMS.
 * The library's own PCM path additionally raises that to 0.7 before the orb
 * sees it, which is what spends the orb's range on speech instead of on the
 * quiet half of the scale. Feed it raw otherwise and the shell barely moves at
 * conversational volume. Attack/release smoothing already happens on the UI
 * thread inside the orb, so nothing is smoothed here.
 */
export const orbLevel = (amp: number): number => (amp > 0 ? amp ** 0.7 : 0);

const SIZE = 260;

export default function LiveOrb({
  phase,
  level,
}: {
  phase: OrbPhase;
  level: SharedValue<number>;
}) {
  const { colors } = useTheme();
  const failed = phase === 'error';
  return (
    <VoiceOrb
      state={TO_VOICE_STATE[phase]}
      inputAmplitude={level}
      // outputAmplitude is deliberately unset. Kokoro plays through an
      // expo-audio player created imperatively inside TtsService, which has no
      // metering wired up, so there is no honest output level to pass. The
      // speaking behaviour still animates: amplitude only scales how deep the
      // gesture goes, never whether it happens.
      size={SIZE}
      // The orb is the voice surface, so it stays in the violet family and only
      // the ramp moves — see the palette note in src/theme/palette.ts. Two
      // endpoints make the ink drift along the gradient on the orb's own clock.
      color={failed ? colors.danger : colors.accent}
      colorTo={failed ? colors.danger : colors.accentDeep}
    />
  );
}
