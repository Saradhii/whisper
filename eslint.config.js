// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const regexp = require('eslint-plugin-regexp');

module.exports = defineConfig([
  expoConfig,
  // Regex defects are their own bug class and they fail silently: a bad pattern
  // is still valid JavaScript, still returns a plausible-looking result, and
  // still passes a test that only counts the rows it produced. The recommended
  // set is what caught the quadratic tag-stripper in agent/parse.ts and the
  // quadratic sentence splitter in voice/tts — both on paths that parse
  // attacker- or model-supplied text on the JS thread.
  //
  // It does NOT catch every regex bug, and it is worth knowing where the line
  // is: the DuckDuckGo snippet regex had a capture group that could never
  // match on any input, and this plugin reports nothing on it even with
  // `flat/all` enabled. Syntactically the pattern is fine; only its result was
  // wrong. Lint bounds the cost of a regex — a test on a saved fixture is the
  // only thing that checks what one returns.
  regexp.configs['flat/recommended'],
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // `any` disables checking exactly where bugs congregate (native/model
      // boundaries). Foreign data must be parsed via zod instead — see
      // src/engines/toolcalls.ts for the pattern.
      '@typescript-eslint/no-explicit-any': 'error',
      // Not in regexp's recommended set, and it is the rule that caught the
      // quadratic `<[^>]+>` tag stripper — the one reachable from any page the
      // model fetches. `no-super-linear-backtracking` (which IS recommended)
      // only sees patterns that blow up while backtracking a match; this one
      // sees patterns that blow up by RETRYING from every position, which is
      // how the tag stripper failed. Both matter when the input is hostile.
      'regexp/no-super-linear-move': 'error',
    },
  },
  // src/ui/beam is vendored third-party source, not ours — a copy of the
  // unpublished border-beam-native package (see src/ui/beam/VENDOR.md for the
  // pinned commit and the full list of local edits). It is node_modules by
  // another name: we hold it to compiling under our strict tsconfig, but not to
  // our lint rules, because every rule we enforce on it is a diff we have to
  // re-apply by hand on the next upstream sync. The three below are upstream's
  // own patterns, all benign in this component's usage:
  //   set-state-in-effect  — the active→mounted fade gate, which runs once
  //   rules-of-hooks       — PulseBeam's makeLayer() calls useDerivedValue
  //                          unconditionally, three times, in a fixed order
  //   no-unused-vars       — dead helpers kept for parity with the web source
  // If we ever start editing this directory as our own code, delete this block
  // rather than growing it.
  {
    files: ['src/ui/beam/**'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/rules-of-hooks': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    ignores: ['android/**', 'ios/**', 'node_modules/**', '.expo/**', 'expo-env.d.ts'],
  },
]);
