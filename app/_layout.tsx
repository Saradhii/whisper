import { DancingScript_700Bold } from '@expo-google-fonts/dancing-script';
import { Poppins_600SemiBold, useFonts } from '@expo-google-fonts/poppins';
import * as Notifications from 'expo-notifications';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import * as Trace from '@/src/agent/trace';
import { installEngineLifecycle } from '@/src/engines/lifecycle';
import * as Settings from '@/src/settings/store';
import AnimatedSplash from '@/src/splash/AnimatedSplash';
import { ThemeProvider, useTheme, useThemedStyles, type Colors } from '@/src/theme';

// Hold the native splash (solid white, cold-start only by OS design) until
// fonts are ready, then hand off to the animated overlay with the same first
// frame — the app mounts and starts loading the model underneath it.
SplashScreen.preventAutoHideAsync().catch(() => {});

// Without a handler, scheduled reminders are silently suppressed while the
// app is foregrounded (SDK 52+ default) — a "remind me in 2 minutes" that the
// user watches never appear reads as the assistant lying.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Last-resort error boundary: a render throw (e.g. markdown parsing a
// pathological model reply) becomes a recoverable screen, not a white screen.
// Styles arrive as a prop because a class component can't call useTheme.
class ErrorBoundary extends Component<
  { children: ReactNode; styles: BoundaryStyles },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { styles } = this.props;
    if (this.state.error) {
      return (
        <View style={styles.root}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.detail}>{this.state.error.message}</Text>
          <Pressable style={styles.btn} onPress={() => this.setState({ error: null })}>
            <Text style={styles.btnText}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

type BoundaryStyles = ReturnType<typeof createBoundaryStyles>;

const createBoundaryStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      gap: 12,
      backgroundColor: colors.bg,
    },
    title: { color: colors.text, fontSize: 17, fontWeight: '700' },
    detail: { color: colors.textSecondary, fontSize: 13, textAlign: 'center' },
    btn: {
      backgroundColor: colors.primary,
      borderRadius: 18,
      paddingHorizontal: 20,
      paddingVertical: 12,
      marginTop: 8,
    },
    btnText: { color: colors.onPrimary, fontWeight: '600' },
  });

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Poppins_600SemiBold, DancingScript_700Bold });
  const [splashDone, setSplashDone] = useState(false);
  const showSplash = !splashDone && fontsLoaded;

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

  // Free the model's native memory when the app backgrounds (and restore it on
  // return) so the multi-GB footprint doesn't get the process killed.
  useEffect(() => {
    installEngineLifecycle();
  }, []);

  // Loaded at the root, not per screen: the chosen appearance has to be known
  // before the first frame or the app flashes light and then repaints.
  useEffect(() => {
    void Settings.init();
  }, []);

  // Agent tracing is cross-cutting config, so it's wired at the composition
  // root rather than inside either store — that keeps trace.ts a pure module
  // (no Expo imports) and therefore unit-testable in Node.
  useSyncExternalStore(Settings.subscribe, Settings.getVersion);
  const devTrace = Settings.get().devTrace;
  useEffect(() => {
    Trace.setEnabled(devTrace);
  }, [devTrace]);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <KeyboardProvider>
          <ThemedRoot showSplash={showSplash} onSplashDone={() => setSplashDone(true)} />
        </KeyboardProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

// Split out so it can read the theme that RootLayout provides.
function ThemedRoot({
  showSplash,
  onSplashDone,
}: {
  showSplash: boolean;
  onSplashDone: () => void;
}) {
  const { colors, scheme } = useTheme();
  const boundaryStyles = useThemedStyles(createBoundaryStyles);

  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <ErrorBoundary styles={boundaryStyles}>
        <Stack
          screenOptions={{
            headerShown: false,
            // Without this the navigator's own background stays white and
            // flashes between screens on dark.
            contentStyle: { backgroundColor: colors.bg },
          }}
        />
      </ErrorBoundary>
      {showSplash ? <AnimatedSplash onDone={onSplashDone} /> : null}
    </>
  );
}
