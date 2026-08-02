// Generate every app-icon raster from one vector source.
//
// Run: node scripts/make-icons.mjs
//
// The mark is defined once, here, as SVG geometry; the four PNGs Expo needs are
// just different framings of it. Editing the icon means editing this file and
// re-running — there is no binary to hand-edit and no "which PNG is the real
// one" question. Headless Chrome does the rasterising, so gradients, blur and
// the gloss highlight render exactly as a browser would draw them (no sharp or
// librsvg needed, and none is installed).
//
// Outputs:
//   assets/icon.png                 1024, opaque square — iOS masks it itself
//   assets/adaptive-foreground.png  1024, transparent, mark inside the safe zone
//   assets/adaptive-background.png  1024, the gradient ground alone
//   assets/adaptive-monochrome.png  1024, flat silhouette for Android 13 themed icons
//
// Android composites foreground over background and then applies the launcher's
// own mask, which is why the mark must NOT have rounded corners baked in and
// must stay inside the safe zone — the outer ~34% can be cropped away.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIZE = 1024;

// --- brand -----------------------------------------------------------------
// Whisper's own palette (src/theme/palette.ts): primary red is the brand mark,
// violet is the voice accent. The reference icon that inspired this was blue;
// borrowing its treatment — extruded 3D mark, segmented colour, gradient ground,
// light flare — while keeping our colours is the whole point.
const RED = '#e5322b';
const RED_DEEP = '#c81e1e';
const VIOLET = '#7c5cfc';
const VIOLET_DEEP = '#6d28d9';
const INK = '#1c0d1a';

/**
 * The W, drawn as a single stroked polyline with round joins and caps.
 *
 * Stroking rather than outlining is deliberate: it gives the chunky rounded
 * terminals of the reference for free, and the geometry stays four points that
 * are easy to nudge. Two chevrons also read as a waveform, which is the right
 * association for a voice assistant.
 */
const W_PATH = 'M 112 172 L 190 352 L 256 244 L 322 352 L 400 172';
const W_WIDTH = 58;

/** Depth of the extruded side wall, in viewBox units. */
const EXTRUDE = 26;

/** The mark, extruded and lit. `scale` fits it to the framing we need. */
function mark({ scale = 1, mono = false }) {
  // The side wall is the same path stamped repeatedly downward; stacking beats
  // a real 3D projection here and stays crisp at any raster size.
  const wall = Array.from({ length: EXTRUDE }, (_, i) => {
    const t = i / EXTRUDE;
    return `<path d="${W_PATH}" transform="translate(0 ${EXTRUDE - i})"
      stroke="url(#wall)" stroke-width="${W_WIDTH}" stroke-linecap="round"
      stroke-linejoin="round" fill="none" opacity="${0.55 + t * 0.45}"/>`;
  }).join('\n');

  if (mono) {
    return `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
      <path d="${W_PATH}" stroke="#fff" stroke-width="${W_WIDTH}"
        stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </g>`;
  }

  return `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <g filter="url(#drop)">
      ${wall}
      <path d="${W_PATH}" stroke="url(#face)" stroke-width="${W_WIDTH}"
        stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <!-- Gloss: a narrow stroke riding the top edge, fading out downward.
           A wide blurred one just fogs the middle of the letter. -->
      <path d="${W_PATH}" transform="translate(0 -11)" stroke="url(#gloss)"
        stroke-width="${W_WIDTH * 0.2}" stroke-linecap="round"
        stroke-linejoin="round" fill="none" filter="url(#soft)"/>
    </g>
  </g>`;
}

const DEFS = `
  <linearGradient id="face" x1="80" y1="150" x2="430" y2="370" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#ff7a3d"/>
    <stop offset="0.38" stop-color="${RED}"/>
    <stop offset="0.72" stop-color="#e0338c"/>
    <stop offset="1" stop-color="${VIOLET}"/>
  </linearGradient>
  <linearGradient id="wall" x1="80" y1="150" x2="430" y2="370" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#a8321a"/>
    <stop offset="0.5" stop-color="${RED_DEEP}"/>
    <stop offset="1" stop-color="${VIOLET_DEEP}"/>
  </linearGradient>
  <linearGradient id="ground" x1="0" y1="0" x2="0" y2="512" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#3d1147"/>
    <stop offset="0.5" stop-color="#25102c"/>
    <stop offset="1" stop-color="${INK}"/>
  </linearGradient>
  <radialGradient id="flare" cx="256" cy="500" r="330" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#ff4d3d" stop-opacity="0.62"/>
    <stop offset="0.6" stop-color="${RED}" stop-opacity="0.16"/>
    <stop offset="1" stop-color="${RED}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="topLight" cx="150" cy="60" r="300" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${VIOLET}" stop-opacity="0.34"/>
    <stop offset="1" stop-color="${VIOLET}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="gloss" x1="0" y1="150" x2="0" y2="330" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#fff" stop-opacity="0.85"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0.05"/>
  </linearGradient>
  <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur stdDeviation="2.5"/>
  </filter>
  <filter id="drop" x="-30%" y="-30%" width="160%" height="180%">
    <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#000" flood-opacity="0.45"/>
  </filter>`;

const svg = (body, opaque) => `<svg xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 512 512" width="${SIZE}" height="${SIZE}">
  <defs>${DEFS}</defs>
  ${opaque ? '' : '<!-- transparent -->'}
  ${body}
</svg>`;

const ground = `
  <rect width="512" height="512" fill="url(#ground)"/>
  <rect width="512" height="512" fill="url(#flare)"/>
  <rect width="512" height="512" fill="url(#topLight)"/>`;

// iOS rounds the icon itself, so this stays a full-bleed square. The mark sits
// a little larger here than on Android because nothing will crop it.
const LAYERS = {
  'icon.png': svg(`${ground}${mark({ scale: 0.9 })}`, true),
  // The safe zone is a circle of 66% of the canvas (676px here), and anything
  // outside it can be cropped. At 0.72 the mark's bounding box measures
  // 500x381, a 628px diagonal — inside that circle with room to spare, while
  // still filling the launcher tile instead of floating in the middle of it.
  'adaptive-foreground.png': svg(mark({ scale: 0.72 }), false),
  'adaptive-background.png': svg(ground, true),
  'adaptive-monochrome.png': svg(mark({ scale: 0.72, mono: true }), false),
};

const tmp = mkdtempSync(join(tmpdir(), 'whisper-icons-'));
try {
  for (const [name, source] of Object.entries(LAYERS)) {
    const html = join(tmp, `${name}.html`);
    const shot = join(tmp, name);
    // margin:0 and a fixed-size body, or Chrome adds the default 8px gutter and
    // every layer lands misaligned against the others.
    writeFileSync(
      html,
      `<html><head><style>html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;background:transparent}svg{display:block}</style></head><body>${source}</body></html>`,
    );
    execFileSync(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000', // real transparency, not white
      `--window-size=${SIZE},${SIZE}`,
      `--screenshot=${shot}`,
      `file://${html}`,
    ], { stdio: 'ignore' });
    copyFileSync(shot, join(ROOT, 'assets', name));
    console.log(`wrote assets/${name}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
