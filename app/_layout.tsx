import { DancingScript_700Bold } from '@expo-google-fonts/dancing-script';
import { Poppins_600SemiBold, useFonts } from '@expo-google-fonts/poppins';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import AnimatedSplash from '@/src/splash/AnimatedSplash';

// Hold the native splash (solid white, cold-start only by OS design) until
// fonts are ready, then hand off to the animated overlay with the same first
// frame — the app mounts and starts loading the model underneath it.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Poppins_600SemiBold, DancingScript_700Bold });
  const [splashDone, setSplashDone] = useState(false);
  const showSplash = !splashDone && fontsLoaded;

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }} />
        {showSplash ? <AnimatedSplash onDone={() => setSplashDone(true)} /> : null}
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
