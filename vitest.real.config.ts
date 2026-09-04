import path from 'path';
import { defineConfig } from 'vitest/config';

// The real-model eval suite. Deliberately NOT part of `npm run check`: it needs
// a 1.1 GB GGUF on disk and a native llama.cpp runner installed OUTSIDE the
// repo, neither of which CI or a fresh checkout has. It skips with instructions
// when they are missing — see src/agent/eval/real/model.ts.
//
// ACCURACY ONLY. Nothing this suite prints is a latency measurement.
//
// Run it with `npm run eval:real`.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: {
    include: ['src/**/*.real.test.ts'],
    // One model, one context, one sequence, loaded once and reused across every
    // scenario — so the suite must not be sharded across worker processes, each
    // of which would load its own 1.1 GB copy.
    fileParallelism: false,
    // A full corpus run against a real 1.7B planner is minutes, and
    // WHISPER_EVAL_REPEATS multiplies it. The per-test timeout in the file is
    // the real bound; this only stops vitest killing it first.
    testTimeout: 7_200_000,
    hookTimeout: 600_000,
  },
});
