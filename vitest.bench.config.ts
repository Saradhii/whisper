import path from 'path';
import { defineConfig } from 'vitest/config';

// Dumps the prompt tracks for the prefill benchmark (`npm run bench:prefill`).
// Not a test suite and not part of `npm run check`.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: { include: ['src/**/*.bench.ts'] },
});
