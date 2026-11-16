import { describe, expect, it } from 'vitest';

import {
  BODY_PATH,
  EYE_PATH,
  FILL_COLORS,
  FILL_GRID,
  FILL_SKSL,
  MASCOT_RADIUS,
} from './mascot';

const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
const points = (d: string) => {
  const n = numbers(d);
  return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i]!, n[2 * i + 1]!] as const);
};

describe('mascot geometry', () => {
  it('emits only finite coordinates and the commands Skia is given', () => {
    for (const d of [BODY_PATH, EYE_PATH]) {
      expect(d).toMatch(/^M[-\d. ]+([LQC][-\d. ]+)+Z$/);
      expect(numbers(d).every(Number.isFinite)).toBe(true);
    }
  });

  it('keeps the body inside the tip circle, and reaches it', () => {
    const radii = points(BODY_PATH).map(([x, y]) => Math.hypot(x, y));
    expect(Math.max(...radii)).toBeLessThanOrEqual(MASCOT_RADIUS + 0.01);
    // Eight Q control points sit exactly on the tips.
    expect(radii.filter((r) => Math.abs(r - MASCOT_RADIUS) < 0.02)).toHaveLength(8);
  });

  it('is eight-fold symmetric — a 45° turn maps the outline onto itself', () => {
    const pts = points(BODY_PATH);
    const c = Math.SQRT1_2;
    for (const [x, y] of pts) {
      const rx = x * c - y * c;
      const ry = x * c + y * c;
      expect(pts.some(([px, py]) => Math.hypot(px - rx, py - ry) < 0.03)).toBe(true);
    }
  });

  it('keeps each eye inside its 40.4 × 59 ellipse', () => {
    for (const [x, y] of points(EYE_PATH)) {
      // Control points of an ~80° arc sit up to ~12% outside the curve they shape.
      expect((x / 40.4) ** 2 + (y / 59) ** 2).toBeLessThan(1.3);
    }
  });
});

describe('mascot fill', () => {
  it('has one normalized RGB triple per grid cell, matching the shader', () => {
    expect(FILL_COLORS).toHaveLength(FILL_GRID * FILL_GRID * 3);
    expect(FILL_COLORS.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(FILL_SKSL).toContain(`uniform float uColors[${FILL_COLORS.length}]`);
  });
});
