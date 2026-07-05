// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = defineConfig([
  expoConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // `any` disables checking exactly where bugs congregate (native/model
      // boundaries). Foreign data must be parsed via zod instead — see
      // src/engines/toolcalls.ts for the pattern.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    ignores: ['android/**', 'ios/**', 'node_modules/**', '.expo/**', 'expo-env.d.ts'],
  },
]);
