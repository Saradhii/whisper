// The chat screen's thinking orb — a thin adapter over expo-thinking-orbs'
// <ThinkingOrb>, mirroring src/voice/LiveOrb.tsx. The library is imported here
// and nowhere else in chat, and the phase→animation decision lives in
// orbPhase.ts, so replacing either is a one-file change.
//
// Deliberately UNTINTED. src/theme/palette.ts reserves violet for the voice
// surface — "violet on screen always means this is about talking" — and a
// waiting chat turn is not that. Omitting `color` takes the library's faithful
// grayscale ramp, which is the same neutral ink the three dots this replaces
// were drawn in, so the rule survives.
import { ThinkingOrb } from 'expo-thinking-orbs';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useTheme, useThemedStyles, type Colors } from '@/src/theme';

import { orbLook, type ThinkingPhase } from './orbPhase';

/** Above the library's DESIGN_CUTOFF (36), so the 64-dot design is used and
 *  scaled down — the 20-dot one reads as coarse at bubble scale. */
const BUBBLE_ORB = 40;

/** Inline scale, matching the 17px Ionicon a settled chip shows in its place
 *  so the row does not change height when the tool finishes. */
export const CHIP_ORB = 18;

/**
 * The orb on its own, for callers that supply their own surround.
 *
 * `theme` is passed explicitly rather than left on its 'auto' default: 'auto'
 * reads the OS scheme, which is the wrong answer for a user who pinned light or
 * dark in Settings — the orb would ink itself for a background the app is not
 * drawing.
 */
export function ChatOrb({ phase, size }: { phase: ThinkingPhase; size: number }) {
  const { scheme } = useTheme();
  const { state, label } = orbLook(phase);
  return (
    <ThinkingOrb state={state} size={size} theme={scheme} accessibilityLabel={`${label}…`} />
  );
}

/** The label breathes rather than sitting dead next to a moving orb. Kept
 *  shallow (0.55→1) and slow: a second competing rhythm at full contrast reads
 *  as two things loading, not one thing working. */
function BreathingLabel({ text }: { text: string }) {
  const styles = useThemedStyles(createStyles);
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 900, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
    );
  }, [t]);
  const style = useAnimatedStyle(() => ({ opacity: 0.55 + 0.45 * t.value }));
  return <Animated.Text style={[styles.label, style]}>{text}</Animated.Text>;
}

/**
 * The waiting row shown under the transcript while the model is prefilling.
 *
 * Replaces the three bouncing dots. The dots said only "something is
 * happening"; on CPU the wait is several seconds and the interesting question
 * is *what* — planning, or writing up what a tool just returned — which the
 * phase now answers in both the animation and the word.
 */
export function ThinkingBubble({ phase }: { phase: ThinkingPhase }) {
  const styles = useThemedStyles(createStyles);
  const { label } = orbLook(phase);
  return (
    <View style={styles.bubble} accessibilityRole="progressbar" accessibilityLabel={`${label}…`}>
      {/* The orb carries its own accessibilityLabel, which would be read out a
          second time after the row's. Hide it from the tree; the row speaks. */}
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <ChatOrb phase={phase} size={BUBBLE_ORB} />
      </View>
      <BreathingLabel text={`${label}…`} />
    </View>
  );
}

const createStyles = (colors: Colors) =>
  StyleSheet.create({
    bubble: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: colors.surface,
      borderRadius: 22,
      paddingLeft: 6,
      paddingRight: 18,
      paddingVertical: 4,
    },
    label: { color: colors.textSecondary, fontSize: 15, fontWeight: '500' },
  });
