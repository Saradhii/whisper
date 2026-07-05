// App palette: light theme. Primary is the brand red (matching the icon and
// live mode); the violet we shipped earlier stays on as a secondary accent, so
// the UI reads as a red-forward mix rather than pure red. Single source of
// truth for every screen.
export const colors = {
  bg: '#ffffff',
  surface: '#faf4f4', // faint warm surface
  surfaceAlt: '#f4f3fa', // cool (violet-tinted) surface for accent areas
  border: '#f0e2e2',
  borderStrong: '#ef524e', // red accent border (accordions, active states)
  text: '#1c1622',
  textSecondary: '#726a72',
  textFaint: '#a89ea6',
  primary: '#e5322b', // brand red
  primaryDeep: '#c81e1e',
  onPrimary: '#ffffff',
  accent: '#7c5cfc', // secondary violet accent
  accentDeep: '#6d28d9',
  danger: '#c81e1e',
  warn: '#b45309',
};
