import path from 'path';
import { defineConfig } from 'vitest/config';

// Tests cover the pure modules (agent loop, boundary normalizers, parsers) —
// anything importing react-native/expo stays out and is exercised on-device.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  // *.live.test.ts makes real network calls and is run on demand via
  // `npm run test:live` — a third party being down must not fail a build.
  // *.real.test.ts loads a 1.1 GB GGUF and a native llama.cpp runner from
  // outside the repo, and is run on demand via `npm run eval:real` — a machine
  // that has never downloaded the weights must not fail a build either.
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.live.test.ts', '**/*.real.test.ts'],
  },
});
