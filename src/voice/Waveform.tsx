// Live recording waveform for the input row: a scrolling row of bars whose
// heights track the mic's RMS amplitude (sampled from the recorder). Purely
// presentational — polls currentAmplitude() on an interval while `active`.
// State is one shared array (not one hook per bar) to respect rules-of-hooks.
import { useEffect } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import { useThemedStyles, type Colors } from '@/src/theme';
import { currentAmplitude } from './recorder';

const BAR_COUNT = 28;
const TICK_MS = 70;

// The bar style is passed in rather than looked up per bar: 28 of these mount
// at once and they all share one style.
function Bar({
  levels,
  index,
  style: barStyle,
}: {
  levels: SharedValue<number[]>;
  index: number;
  style: ViewStyle;
}) {
  const style = useAnimatedStyle(() => {
    const v = levels.value[index] ?? 0;
    return { height: 4 + v * 26, opacity: 0.4 + v * 0.6 };
  });
  return <Animated.View style={[barStyle, style]} />;
}

export default function Waveform({ active }: { active: boolean }) {
  const styles = useThemedStyles(createStyles);
  const levels = useSharedValue<number[]>(new Array(BAR_COUNT).fill(0));

  useEffect(() => {
    if (!active) {
      levels.value = new Array(BAR_COUNT).fill(0);
      return;
    }
    const id = setInterval(() => {
      // Scroll left by one and append the newest amplitude sample.
      const next = levels.value.slice(1);
      next.push(currentAmplitude());
      levels.value = next;
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active, levels]);

  return (
    <View style={styles.row}>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <Bar key={i} levels={levels} index={i} style={styles.bar} />
      ))}
    </View>
  );
}

const createStyles = (colors: Colors) =>
  StyleSheet.create({
    row: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-evenly',
      height: 44,
      paddingHorizontal: 8,
    },
    bar: {
      width: 3,
      borderRadius: 2,
      // Violet, not red: the waveform is part of the voice surface.
      backgroundColor: colors.accent,
    },
  });
