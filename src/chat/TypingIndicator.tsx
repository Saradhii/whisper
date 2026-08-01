// Three-dot "thinking" bubble shown while the model is prefilling the prompt
// (before the first token streams). On CPU with tool schemas this wait is
// several seconds, so this reassures the user the request is being processed.
import { useEffect } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useThemedStyles, type Colors } from '@/src/theme';

function Dot({ delay, style: dotStyle }: { delay: number; style: ViewStyle }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 400, easing: Easing.inOut(Easing.quad) }),
          withTiming(0, { duration: 400, easing: Easing.inOut(Easing.quad) }),
        ),
        -1,
      ),
    );
  }, [t, delay]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.3 + 0.7 * t.value,
    transform: [{ translateY: -3 * t.value }],
  }));
  return <Animated.View style={[dotStyle, style]} />;
}

export default function TypingIndicator() {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.bubble}>
      <Dot delay={0} style={styles.dot} />
      <Dot delay={150} style={styles.dot} />
      <Dot delay={300} style={styles.dot} />
    </View>
  );
}

const createStyles = (colors: Colors) =>
  StyleSheet.create({
    bubble: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: colors.surface,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.textFaint },
  });
