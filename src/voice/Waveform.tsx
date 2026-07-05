// Live recording waveform for the input row: a scrolling row of bars whose
// heights track the mic's RMS amplitude (sampled from the recorder). Purely
// presentational — polls currentAmplitude() on an interval while `active`.
// State is one shared array (not one hook per bar) to respect rules-of-hooks.
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import { colors } from '@/src/theme';
import { currentAmplitude } from './recorder';

const BAR_COUNT = 28;
const TICK_MS = 70;

function Bar({ levels, index }: { levels: SharedValue<number[]>; index: number }) {
  const style = useAnimatedStyle(() => {
    const v = levels.value[index] ?? 0;
    return { height: 4 + v * 26, opacity: 0.4 + v * 0.6 };
  });
  return <Animated.View style={[styles.bar, style]} />;
}

export default function Waveform({ active }: { active: boolean }) {
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
        <Bar key={i} levels={levels} index={i} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: colors.primary,
  },
});
