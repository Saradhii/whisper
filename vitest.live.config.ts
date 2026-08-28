import path from 'path';
import { defineConfig } from 'vitest/config';

// The live suite: tests that make real network calls. Deliberately NOT part of
// `npm run check` — they need a connection, they are slow, and a third party
// being down must never fail a local build or a commit.
//
// Run it when a web tool misbehaves, and on a schedule if this ever gets CI.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: { include: ['src/**/*.live.test.ts'], testTimeout: 30_000 },
});
