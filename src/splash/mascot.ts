// The Whisper mascot — the pinwheel from the launcher icon — as vector
// geometry, so the splash can draw it razor-sharp at any density and animate
// its parts (the body turns, the eyes open and blink) instead of fading in a
// bitmap.
//
// Everything here is MEASURED from assets/adaptive-foreground.png rather than
// redrawn by eye; the splash is the first thing on screen after the user taps
// that icon, and a mark that is merely similar reads as a different brand.
// Coordinates are the icon's own 1024-unit artboard, re-centred on (0, 0),
// y down. Callers scale with a transform.
//
// Pure module: no React, no Skia, no Expo — so the geometry is unit-tested in
// Node (mascot.test.ts).

const f = (n: number) => (Math.round(n * 100) / 100).toString();
const pt = (p: readonly [number, number]) => `${f(p[0])} ${f(p[1])}`;
type Pt = [number, number];

const rot = ([x, y]: Pt, deg: number): Pt => {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};

// ---------------------------------------------------------------------------
// Body: eight identical arms. Each arm is one straight edge and one circular
// arc, and the two fitted primitives below describe every arm (rotate by 45°).
//
//   straight edge — lies on the line x − y = EDGE_OFFSET·√2 (a 45° diagonal)
//   arc           — centre ARC_C, radius ARC_R
//
// They meet at an inner "notch"; the arc ends where it crosses the NEXT arm's
// straight edge (the vertical x = EDGE_OFFSET), which is the outer tip — a
// near-perfect right angle, which is why the mark looks like a pinwheel and
// not a star.
// ---------------------------------------------------------------------------
const EDGE_OFFSET = 184.49;
const ARC_C: Pt = [181.64, 88.28];
const ARC_R = 357.71;
// The icon's corners are very slightly eased, not sharp. Distance from each
// vertex at which the edge leaves for the corner curve.
const TIP_EASE = 8.5;
const NOTCH_EASE = 4.5;

const TIP: Pt = [EDGE_OFFSET, ARC_C[1] - Math.sqrt(ARC_R ** 2 - (EDGE_OFFSET - ARC_C[0]) ** 2)];

/** Radius of the circle through the eight tips: the mark's visual extent. */
export const MASCOT_RADIUS = Math.hypot(TIP[0], TIP[1]);

// Notch: line (x, x − k) ∩ circle, taking the root nearer the centre line.
const NOTCH: Pt = (() => {
  const k = EDGE_OFFSET * Math.SQRT2;
  const b = -(ARC_C[0] + ARC_C[1] + k);
  const c = (ARC_C[0] ** 2 + (ARC_C[1] + k) ** 2 - ARC_R ** 2) / 2;
  const x = (-b - Math.sqrt(b * b - 4 * c)) / 2;
  return [x, x - k];
})();

const onArc = (a: number): Pt => [ARC_C[0] + ARC_R * Math.cos(a), ARC_C[1] + ARC_R * Math.sin(a)];
const arcAngle = (p: Pt) => Math.atan2(p[1] - ARC_C[1], p[0] - ARC_C[0]);

function buildBody(): string {
  // One arm, from just past its own tip to just past the next one.
  const prevTip = rot(TIP, -45);
  const len = Math.hypot(NOTCH[0] - prevTip[0], NOTCH[1] - prevTip[1]);
  const u: Pt = [(NOTCH[0] - prevTip[0]) / len, (NOTCH[1] - prevTip[1]) / len];
  const start: Pt = [prevTip[0] + u[0] * TIP_EASE, prevTip[1] + u[1] * TIP_EASE];
  const lineEnd: Pt = [NOTCH[0] - u[0] * NOTCH_EASE, NOTCH[1] - u[1] * NOTCH_EASE];

  const a0 = arcAngle(NOTCH) + NOTCH_EASE / ARC_R;
  const a1 = arcAngle(TIP) - TIP_EASE / ARC_R;
  // The arc spans ~24°, so a single cubic is exact to well under 0.01 units.
  const k = (4 / 3) * Math.tan((a1 - a0) / 4) * ARC_R;
  const p0 = onArc(a0);
  const p3 = onArc(a1);
  const c1: Pt = [p0[0] - k * Math.sin(a0), p0[1] + k * Math.cos(a0)];
  const c2: Pt = [p3[0] + k * Math.sin(a1), p3[1] - k * Math.cos(a1)];

  let d = `M${pt(start)}`;
  for (let i = 0; i < 8; i++) {
    const r = (p: Pt) => rot(p, i * 45);
    d +=
      `L${pt(r(lineEnd))}` +
      `Q${pt(r(NOTCH))} ${pt(r(p0))}` +
      `C${pt(r(c1))} ${pt(r(c2))} ${pt(r(p3))}` +
      `Q${pt(r(TIP))} ${pt(rot(start, (i + 1) * 45))}`;
  }
  return `${d}Z`;
}

/** The pinwheel silhouette, as an SVG path (M/L/Q/C only). */
export const BODY_PATH = buildBody();

// ---------------------------------------------------------------------------
// Eyes: two identical tilted ellipses, each with a wedge bitten out of the
// left side — the glance that gives the mark its character. Defined in the
// eye's own frame (major axis vertical, origin at the ellipse centre) so a
// blink is a plain scaleY about the origin.
// ---------------------------------------------------------------------------
const EYE_RX = 40.4;
const EYE_RY = 59;
const WEDGE_APEX: Pt = [10.4, 1.3];
/** Directions of the wedge's two edges, degrees from +x (y down). */
const WEDGE_UPPER_DEG = 180 + 10.6;
const WEDGE_LOWER_DEG = 180 - 25.6;

export const EYE_TILT_RAD = (-13.5 * Math.PI) / 180;
export const EYE_COLOR = '#fcfaff';
/** Ellipse centres on the artboard. */
export const EYE_CENTERS: readonly Pt[] = [
  [-13.44, -49.15],
  [90.58, -73.85],
];

function buildEye(): string {
  // Where a ray from the wedge apex leaves the ellipse, as an ellipse angle.
  const exit = (deg: number) => {
    const dx = Math.cos((deg * Math.PI) / 180) / EYE_RX;
    const dy = Math.sin((deg * Math.PI) / 180) / EYE_RY;
    const ox = WEDGE_APEX[0] / EYE_RX;
    const oy = WEDGE_APEX[1] / EYE_RY;
    const a = dx * dx + dy * dy;
    const b = 2 * (ox * dx + oy * dy);
    const c = ox * ox + oy * oy - 1;
    const t = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
    return Math.atan2(oy + t * dy, ox + t * dx);
  };
  const from = exit(WEDGE_UPPER_DEG); // upper-left, ≈ −170°
  let to = exit(WEDGE_LOWER_DEG); // lower-left, ≈ +150°
  if (to < from) to += 2 * Math.PI;

  const at = (a: number): Pt => [EYE_RX * Math.cos(a), EYE_RY * Math.sin(a)];
  const tan = (a: number): Pt => [-EYE_RX * Math.sin(a), EYE_RY * Math.cos(a)];
  // Clockwise the long way round, in four cubics (each under 90°).
  const steps = 4;
  const step = (to - from) / steps;
  const k = (4 / 3) * Math.tan(step / 4);
  let d = `M${pt(WEDGE_APEX)}L${pt(at(from))}`;
  for (let i = 0; i < steps; i++) {
    const a0 = from + i * step;
    const a1 = a0 + step;
    const [p0, p3, t0, t3] = [at(a0), at(a1), tan(a0), tan(a1)];
    d +=
      `C${pt([p0[0] + k * t0[0], p0[1] + k * t0[1]])} ` +
      `${pt([p3[0] - k * t3[0], p3[1] - k * t3[1]])} ${pt(p3)}`;
  }
  return `${d}Z`;
}

/** One eye, in its own untilted frame. Place with EYE_CENTERS + EYE_TILT_RAD. */
export const EYE_PATH = buildEye();

// ---------------------------------------------------------------------------
// Fill. The icon's colour is a soft four-way mesh (coral → pink → violet →
// blue → teal), which no single linear/sweep gradient reproduces. It is
// modelled as a 5×5 grid of colours blended with normalized Gaussian weights
// and least-squares fitted to the icon: RMS error 3.1/255, so the splash mark
// and the launcher icon are the same colour, not cousins.
//
// The corner entries look garish in isolation; they sit outside the
// silhouette and only steer the blend near the tips.
// ---------------------------------------------------------------------------
export const FILL_GRID = 5;
/** Grid spans [−FILL_EXTENT, +FILL_EXTENT] on both axes. */
export const FILL_EXTENT = 300;
export const FILL_SIGMA = 75;

// Row-major, top-left first.
// prettier-ignore
const FILL_HEX = [
  '#ff003a', '#b46ef9', '#8b8bf6', '#6781fa', '#0055e8',
  '#fe7ea9', '#f297ff', '#b1a7fa', '#92a3fb', '#00aeff',
  '#f29189', '#ffa4ca', '#db85f7', '#2bd4f7', '#31bbe1',
  '#f99073', '#fe9aef', '#b6c3ff', '#31ddde', '#3cb9be',
  '#ff00ff', '#82a4ff', '#7c9fff', '#5dbdcf', '#00af45',
];

/** Flat 0–1 RGB triples, in the layout the shader's `uColors` expects. */
export const FILL_COLORS: number[] = FILL_HEX.flatMap((hex) => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
]);

const CELLS = FILL_GRID * FILL_GRID;
const fl = (n: number) => n.toFixed(1);

/** SkSL for the fill; `position` is in artboard units (the caller's transform
 *  scales the paint along with the path). */
export const FILL_SKSL = `
uniform float uColors[${CELLS * 3}];

half4 main(float2 position) {
  float3 acc = float3(0.0);
  float total = 0.0;
  for (int i = 0; i < ${CELLS}; i++) {
    float col = mod(float(i), ${fl(FILL_GRID)});
    float row = floor(float(i) / ${fl(FILL_GRID)});
    float2 node = float2(col, row) * ${fl((2 * FILL_EXTENT) / (FILL_GRID - 1))} - ${fl(FILL_EXTENT)};
    float2 d = position - node;
    float w = exp(-dot(d, d) / ${fl(2 * FILL_SIGMA * FILL_SIGMA)});
    acc += w * float3(uColors[i * 3], uColors[i * 3 + 1], uColors[i * 3 + 2]);
    total += w;
  }
  return half4(half3(acc / max(total, 0.000001)), 1.0);
}
`;

/** Used only if the shader fails to compile: the icon's dominant diagonal. */
export const FILL_FALLBACK = ['#f8939c', '#c79cf6', '#3fc3f2'] as const;
