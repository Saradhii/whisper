// Theme plumbing: resolves the active palette from the user's preference plus
// the OS setting, and hands components a memoized StyleSheet for it.
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import * as Settings from '@/src/settings/store';

import { darkColors, lightColors, type Colors } from './palette';

export type Scheme = 'light' | 'dark';
/** What the user picked in Settings; 'system' follows the OS. */
export type Appearance = 'light' | 'dark' | 'system';

type ThemeValue = { colors: Colors; scheme: Scheme };

// Defaulting to light rather than undefined keeps a component usable outside
// the provider (tests, Storybook-style previews) instead of crashing.
const ThemeContext = createContext<ThemeValue>({ colors: lightColors, scheme: 'light' });

export function ThemeProvider({ children }: { children: ReactNode }) {
  useSyncExternalStore(Settings.subscribe, Settings.getVersion);
  const preference = Settings.get().appearance;
  // null while the OS scheme is still unknown — treat as light.
  const osScheme = useColorScheme();

  const scheme: Scheme = preference === 'system' ? (osScheme ?? 'light') : preference;
  const value = useMemo<ThemeValue>(
    () => ({ scheme, colors: scheme === 'dark' ? darkColors : lightColors }),
    [scheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}

// One StyleSheet per (palette, factory) pair for the whole app, not per mounted
// component: chat renders a bubble per message and each would otherwise build
// its own copy of the same sheet.
const sheetCache = new WeakMap<Colors, Map<object, unknown>>();

/**
 * Build a component's styles from the active palette.
 *
 * `factory` must be defined at module scope so its identity is stable —
 * an inline arrow would miss the cache on every render.
 */
export function useThemedStyles<T>(factory: (colors: Colors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => {
    let perPalette = sheetCache.get(colors);
    if (!perPalette) {
      perPalette = new Map();
      sheetCache.set(colors, perPalette);
    }
    if (!perPalette.has(factory)) perPalette.set(factory, factory(colors));
    return perPalette.get(factory) as T;
  }, [colors, factory]);
}
