# Vendored: border-beam-native

Animated border beam, rendered with Skia + Reanimated. Wraps the composer card
in `src/chat/Composer.tsx`.

**Upstream:** https://github.com/Jakubantalik/Libraries
`packages/border-beam/ports/react-native/border-beam-native/src`
**Pinned commit:** `3862ffa345217443b63696a8c331a0664eea4b04`
**License:** MIT (Jakub Antalik) — see the upstream `LICENSE`.

## Why this is vendored rather than a dependency

There is no package to depend on. The port is unpublished and the author's own
install instructions are "copy `packages/border-beam/ports/react-native/
border-beam-native` from the repo" — copying it *is* the supported path. Its two
peer deps, `@shopify/react-native-skia` and `react-native-reanimated`, were
already in this app (both arrive with `expo-thinking-orbs`), so nothing new was
installed for it.

## Known upstream risk

The README marks the port **beta, iOS-verified only** and Android **untested**.
Android is this app's production target, so treat it as unproven until it has
run on a real device. The author's flagged risk areas: `pulse-outside` renders
its halo outside the component's bounds at `zIndex: -1` (ancestor `overflow`
handling differs on Android), colour management can shift saturated colours
(sRGB vs wide gamut), and blur may differ. We use `size="md"` — the rotate
family, which stays inside its own bounds — so only the last two apply.

Also worth knowing before tuning: the web demo's `pulse-outside` card is *not*
stock output. It applies `WEB_DEMO_PULSE_PRESET` (1.05× glow, 1.71× layer
opacity). Untuned beams are deliberately softer than the site.

## Local edits

The port compiles under its own tsconfig but not under ours: this app sets
`noUncheckedIndexedAccess`, which upstream does not. Every change below is that
one difference — a `!` or a destructuring default on an index read the
surrounding code already proves is in range. **No logic, geometry, colour or
shader source was altered.** The Skia `uniforms` type errors that appeared at
first were downstream of the same cause (a `(number | undefined)[]` is not a
valid uniform) and disappeared with the fixes, so they were never a
Skia-2.x-vs-1.x incompatibility.

| File | Change |
|---|---|
| `colorMatrix.ts` | `!` on the two fixed 3×3 matrix multiplies |
| `blobShader.ts` | `!` on `stops[0]`, and on `stops[1..2]` inside their own `length` guards |
| `spec.ts` | `!` on the four spec lookups and on regex groups 1–3 of a matched colour |
| `RotateBeam.tsx` | defaults in `flattenStops`' destructure; `!` on the two theme-keyed stop tables |
| `LineBeam.tsx` | `!` on the palette/bloom/highlight lookups and `softStop` pairs; defaults in the highlight destructure |
| `PulseBeam.tsx` | `!` on `ringMap[i]`, `palette[e.ci]`, `innerSizes[i]`, `section[theme]`, `huePeriod[size]`, `oscillators[i]` |
| `lineDriver.ts` | `!` and destructuring defaults in `sampleKeyframes` |

Lint is turned off for this directory in `eslint.config.js`, with the reasoning
in a comment there.

## Re-syncing

```sh
SHA=<new commit>
B="https://raw.githubusercontent.com/Jakubantalik/Libraries/$SHA/packages/border-beam/ports/react-native/border-beam-native/src"
for f in BorderBeam.tsx RotateBeam.tsx LineBeam.tsx PulseBeam.tsx rotateShader.ts \
         blobShader.ts colorMatrix.ts lineDriver.ts pulseDriver.ts spec.ts \
         tuning.ts types.ts index.ts beam-spec.json; do
  curl -sfL "$B/$f" -o "src/ui/beam/$f"
done
npm run typecheck   # then re-apply the table above at whatever lines it reports
```

Update the pinned commit here when you do.
