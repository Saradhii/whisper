import path from 'path';
import { defineConfig } from 'vitest/config';

// Tests cover the pure modules (agent loop, boundary normalizers, parsers) —
// anything importing react-native/expo stays out and is exercised on-device.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: { include: ['src/**/*.test.ts'] },
});
