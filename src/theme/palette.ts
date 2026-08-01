// The two palettes. Every color in the app comes from here — no component
// should carry a literal hex, so that adding or retuning a theme is a change
// in one file.
//
// The red/violet split is semantic, not decorative:
//   primary (red)   — things you tap to commit: Send, CTAs, the active model,
//                     destructive confirmations. Also the brand mark.
//   accent (violet) — the voice surface only: the live-mode entry point, the
//                     orb, the waveform. Nothing else uses violet, so violet
//                     on screen always means "this is about talking".
//   neutral greys   — chrome icons: menu, settings, models, chevrons, delete.
// Anything that doesn't fit one of those three is a bug in the design, not a
// reason for a fourth hue.
//
// One refinement: back links stay primary even though they're navigation, not a
// commit — a grey text link reads as disabled, and every platform tints back
// navigation with the brand color. The neutral rule is for icons, not text.

export type Colors = {
  bg: string;
  surface: string;
  /** Recessed block inside a surface: code fences, quotes. */
  surfaceSunken: string;
  border: string;
  /** Emphasized border for active/selected cards. */
  borderStrong: string;
  text: string;
  textSecondary: string;
  textFaint: string;
  /** Chrome icons — navigation, disclosure, anything not action or voice. */
  icon: string;

  primary: string;
  primaryDeep: string;
  /** Tinted background for red-family chips and section headers. */
  primarySoft: string;
  onPrimary: string;

  accent: string;
  accentDeep: string;
  /** Lightest violet in the ramp — the orb's speaking state. */
  accentSoft: string;

  success: string;
  successBg: string;
  danger: string;
  dangerBg: string;
  warn: string;

  /** Modal/drawer backdrop. */
  scrim: string;
  /** Drop shadow color (shadows must invert or they vanish on dark). */
  shadow: string;
};

export const lightColors: Colors = {
  bg: '#ffffff',
  surface: '#faf4f4',
  surfaceSunken: '#f4eeee',
  border: '#f0e2e2',
  borderStrong: '#ef524e',
  text: '#1c1622',
  textSecondary: '#726a72',
  textFaint: '#a89ea6',
  icon: '#726a72',

  primary: '#e5322b',
  primaryDeep: '#c81e1e',
  primarySoft: '#fdf0ef',
  onPrimary: '#ffffff',

  accent: '#7c5cfc',
  accentDeep: '#6d28d9',
  accentSoft: '#a78bfa',

  success: '#2e9e5b',
  successBg: '#e7f6ec',
  danger: '#c81e1e',
  dangerBg: '#fdeceb',
  warn: '#b45309',

  scrim: 'rgba(20,12,18,0.35)',
  shadow: '#000000',
};

// Warm-neutral dark rather than pure black: the brand red sits badly on #000,
// and OLED-black surfaces make the red bloom. Reds and violets are lightened
// because the light-theme values fail contrast against a dark background.
export const darkColors: Colors = {
  bg: '#141119',
  surface: '#1e1a24',
  surfaceSunken: '#262130',
  border: '#2f2937',
  borderStrong: '#ff6b62',
  text: '#f4f1f6',
  textSecondary: '#a79fae',
  textFaint: '#736b7c',
  icon: '#a79fae',

  primary: '#ff5f56',
  primaryDeep: '#ff8079',
  primarySoft: '#2d1c1e',
  onPrimary: '#1a1016',

  accent: '#9b82ff',
  accentDeep: '#b8a4ff',
  accentSoft: '#cbbcff',

  success: '#4ec97f',
  successBg: '#15301f',
  danger: '#ff6b62',
  dangerBg: '#361d1d',
  warn: '#e3a63f',

  scrim: 'rgba(0,0,0,0.6)',
  shadow: '#000000',
};
