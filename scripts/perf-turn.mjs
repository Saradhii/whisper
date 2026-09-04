#!/usr/bin/env node
// Automated on-device turn measurement.
//
// Drives the app through real turns over a deep link and reports, per
// generation, how many prompt tokens were actually re-evaluated — the number
// both prompt tracks are optimizing — plus wall-clock, with median and spread
// across N repeats. Replaces ~2.5 minutes of manual tapping per sample.
//
//   node scripts/perf-turn.mjs --msg "hi" --runs 5
//
// Requires: the app installed as a DEBUGGABLE build, and a Metro dev server
// serving THIS checkout (see --port). No gradle rebuild is needed — the dev
// client pulls its JS from Metro, so a JS-only change is measured by pointing
// the device at your own Metro and relaunching.
//
// WHERE THE NUMBERS COME FROM
//   tokens : logcat `RNLlama loadPrompt:221`, which llama.rn logs for free on
//            every generation: `n_past` (served from KV cache) against
//            `num_prompt_tokens` (total). reeval = num_prompt_tokens - n_past.
//            Chosen over the app's own trace because it is native, needs no
//            instrumentation, and cannot be skewed by JS scheduling.
//   wall   : PERFH turn_start/turn_end markers emitted by src/dev/perfHarness.ts,
//            which awaits the same promise the UI does, so it ends when the turn
//            genuinely ends rather than when the spinner hides.
//
// CAVEAT on n_past: llama.rn pushes a sampled token into `embd` without
// decoding it, so a generation that ended on a stop string or the n_predict
// limit leaves embd.size == n_past + 1. "N cached" means N or N-1. Both are
// reported.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    // A flag with no value (or followed by another flag) is a boolean.
    args[key] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
}

const MSG = String(args.msg ?? 'hi');
const RUNS = Number(args.runs ?? 5);
const PORT = Number(args.port ?? 8082);
const PKG = String(args.pkg ?? 'com.whisper.app');
const LABEL = String(args.label ?? 'run');
const OUT = String(args.out ?? `/tmp/perf-${LABEL}.json`);
const SERIAL = args.serial ? ['-s', String(args.serial)] : [];
const MODE = String(args.mode ?? 'drain');
const SETTLE_MS = Number(args.settle ?? 3) * 1000;
// Ops that build their own contexts (npredict/parity/ubatch) run for many
// minutes; a turn is a couple of minutes at worst.
const OP_TIMEOUT_MS = Number(args.timeout ?? 900_000);

const DEV_URL = `whisper://expo-development-client/?url=${encodeURIComponent(`http://10.0.2.2:${PORT}`)}`;

const adb = (...a) =>
  execFileSync('adb', [...SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });

/**
 * Fire a deep link.
 *
 * The URL is single-quoted for the DEVICE-side shell: `adb shell` runs its
 * argument through sh on the phone, where a bare `&` in a query string
 * backgrounds the command and silently truncates every parameter after the
 * first. That failure is invisible — the app just receives a shorter URL.
 */
const link = (query) => adb('shell', `am start -a android.intent.action.VIEW -d '${query}' ${PKG}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- log capture -------------------------------------------------------------
// Filtered to the two tags that matter, so the ring buffer cannot overflow with
// llama.rn's full prompt-token dump (loadPrompt:116 prints hundreds of ids per
// generation and would otherwise evict the lines we need).
let logPath;
let logProc;
function startLog(path) {
  logPath = path;
  mkdirSync(dirname(path), { recursive: true });
  adb('logcat', '-c');
  const out = createWriteStream(path);
  logProc = spawn(
    'adb',
    [...SERIAL, 'logcat', '-v', 'epoch', 'RNLlama:I', 'ReactNativeJS:I', '*:S'],
    {
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  logProc.stdout.pipe(out);
}
const stopLog = () => logProc?.kill();
const readLog = () => {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
};

/** PERFH events seen so far, in order. */
function events() {
  return readLog()
    .split('\n')
    .filter((l) => l.includes('PERFH {'))
    .map((l) => {
      try {
        return JSON.parse(l.slice(l.indexOf('PERFH {') + 6));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// One log file spans the whole session, so every wait must ignore events from
// earlier runs — otherwise run 2 instantly "sees" run 1's harness_ready and
// races ahead of a device that has not finished launching.
let evCursor = 0;
const resetCursor = () => {
  evCursor = events().length;
};

/** Block until a PERFH event matching `pred` appears, or throw on timeout. */
async function awaitEvent(pred, what, timeoutMs = OP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events().slice(evCursor).find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/** Run one harness op and wait for its op_done. */
async function op(params, what, timeoutMs = OP_TIMEOUT_MS) {
  const before = events().filter((e) => e.ev === 'op_done').length;
  link(`whisper://?perf=1&${params}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (events().filter((e) => e.ev === 'op_done').length > before) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

// --- parsing -----------------------------------------------------------------
// Split in two: one pattern for the counters, one for the leading epoch stamp.
// Combining them would put `\d+` next to `.*`, which backtracks badly on the
// long lines llama.rn emits.
const GEN_RE =
  /loadPrompt:221 \[DEBUG\] Input processed: n_past=(\d+), embd\.size=(\d+), num_prompt_tokens=(\d+)/;
const TS_RE = /^\s*([\d.]+)\s/;

/**
 * Generations that occurred between two markers.
 *
 * Attribution is by POSITION in the single merged log stream, not by comparing
 * a JS epoch against a logcat epoch — both markers and native lines land in the
 * same file in order, so no clock alignment is needed or assumed.
 */
function generationsBetween(startIdx, endIdx) {
  const lines = readLog().split('\n');
  const gens = [];
  for (let i = startIdx; i < endIdx && i < lines.length; i++) {
    const m = GEN_RE.exec(lines[i]);
    if (!m) continue;
    const [, nPast, embd, total] = m;
    gens.push({
      ts: Number(TS_RE.exec(lines[i])?.[1] ?? 0),
      cached: Number(nPast),
      embd: Number(embd),
      promptTokens: Number(total),
      reeval: Number(total) - Number(nPast),
    });
  }
  return gens;
}

/** Index of the log line carrying a given PERFH event. */
function lineIndexOf(ev) {
  const lines = readLog().split('\n');
  return lines.findIndex((l) => l.includes(`"at":${ev.at}`) && l.includes(`"ev":"${ev.ev}"`));
}

// --- stats -------------------------------------------------------------------
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const summarize = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const med = median(s);
  return {
    n: s.length,
    median: Math.round(med * 10) / 10,
    min: s[0],
    max: s[s.length - 1],
    // Spread as a share of the median: this is the number that decides whether
    // a claimed win is real. A 15% improvement is only believable if this is
    // comfortably below it.
    spreadPct: med ? Math.round(((s[s.length - 1] - s[0]) / med) * 1000) / 10 : 0,
  };
};

// --- one launch = one cold turn + one warm turn -------------------------------
async function oneLaunch(runIdx) {
  resetCursor();
  adb('shell', `am force-stop ${PKG}`);
  // Wipe saved conversations. The app restores the last conversation on launch,
  // so without this each run starts with more history than the last and "cold"
  // silently drifts upward run over run. op=new below would still empty the
  // screen, but deleting the files keeps the device state identical per run.
  try {
    adb('shell', `run-as ${PKG} sh -c 'rm -rf files/chats'`);
  } catch {
    // Non-debuggable build, or no chats yet — op=new still forces an empty turn.
  }
  await sleep(1500);
  link(DEV_URL);

  // The harness announces itself once the chat screen mounts with our bundle.
  await awaitEvent((e) => e.ev === 'harness_ready', 'harness_ready', 600_000);

  // Force a KNOWN state rather than hoping. The two modes are NOT the same
  // experiment and their cold numbers are not comparable:
  //
  //   drain  (default) waits for the model to load AND for the chunked prewarm
  //          to finish evaluating the whole system prefix. Deterministic.
  //   settle waits only for the model, then sleeps a fixed --settle seconds, so
  //          the send lands while the prewarm is still running and aborts it
  //          mid-slice. This reproduces the previous session's protocol, and
  //          therefore its published 13.8s cold / 5.0s warm baseline.
  //
  // The difference between them IS the prewarm race: in settle mode a cold
  // turn's cost depends on which slice was in flight when the user sent, which
  // is the dominant source of the run-to-run spread this harness exists to
  // remove.
  if (MODE === 'settle') {
    await op('op=waitready', 'ready');
    await sleep(SETTLE_MS);
  } else {
    await op('op=drain', 'drain');
  }
  // ...and a fresh conversation, or the cold turn re-prefills whatever history
  // the app restored from disk.
  await op('op=new', 'new conversation');

  const out = { run: runIdx, turns: {} };
  for (const kind of ['cold', 'warm']) {
    const tag = `${kind}${runIdx}`;
    link(`whisper://?perf=1&op=send&tag=${tag}&msg=${encodeURIComponent(MSG)}`);
    const start = await awaitEvent((e) => e.ev === 'turn_start' && e.tag === tag, `${tag} start`);
    const end = await awaitEvent((e) => e.ev === 'turn_end' && e.tag === tag, `${tag} end`);
    const gens = generationsBetween(lineIndexOf(start), lineIndexOf(end) + 1);
    out.turns[kind] = {
      wallMs: end.ms,
      generations: gens,
      totalReeval: gens.reduce((a, g) => a + g.reeval, 0),
      genCount: gens.length,
    };
    process.stderr.write(
      `  ${kind}: ${(end.ms / 1000).toFixed(1)}s, ${gens.length} gen, ` +
        `${gens.reduce((a, g) => a + g.reeval, 0)} tok re-evaluated\n`,
    );
  }
  return out;
}

// --- main --------------------------------------------------------------------
async function main() {
  startLog(`/tmp/perf-${LABEL}-logcat.txt`);
  process.on('exit', stopLog);

  // A raw op (bench matrices etc.) — drive it and dump whatever it logged.
  if (args.op) {
    resetCursor();
    adb('shell', `am force-stop ${PKG}`);
    await sleep(1500);
    link(DEV_URL);
    await awaitEvent((e) => e.ev === 'harness_ready', 'harness_ready', 600_000);
    await op(`op=${args.op}${args.params ? `&${args.params}` : ''}`, String(args.op));
    const evs = events().filter((e) => !['op_start', 'op_done', 'harness_ready'].includes(e.ev));
    writeFileSync(OUT, JSON.stringify({ label: LABEL, op: args.op, events: evs }, null, 2));
    console.log(JSON.stringify(evs, null, 2));
    console.error(`\nwrote ${OUT}`);
    stopLog();
    return;
  }

  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    process.stderr.write(`run ${i + 1}/${RUNS}\n`);
    try {
      runs.push(await oneLaunch(i));
    } catch (e) {
      process.stderr.write(`  FAILED: ${e.message}\n`);
      runs.push({ run: i, error: String(e.message) });
    }
  }

  const ok = runs.filter((r) => r.turns);
  const summary = {};
  for (const kind of ['cold', 'warm']) {
    const ts = ok.map((r) => r.turns[kind]).filter(Boolean);
    summary[kind] = {
      wallSec: summarize(ts.map((t) => t.wallMs / 1000)),
      reevalTokens: summarize(ts.map((t) => t.totalReeval)),
      generations: summarize(ts.map((t) => t.genCount)),
    };
  }

  const report = {
    label: LABEL,
    msg: MSG,
    runs: RUNS,
    mode: MODE,
    settleSec: MODE === 'settle' ? SETTLE_MS / 1000 : null,
    // State claims are only true at an instant, and this repo's main moves
    // several times an evening — so stamp every result set with the commit it
    // was measured at.
    head: (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        return 'unknown';
      }
    })(),
    at: new Date().toISOString(),
    summary,
    detail: runs,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));

  const row = (name, s) =>
    s
      ? `${name.padEnd(18)} ${String(s.median).padStart(8)} ${String(s.min).padStart(8)} ${String(s.max).padStart(8)} ${String(s.spreadPct + '%').padStart(8)}`
      : `${name.padEnd(18)} (none)`;
  console.log(`\n${LABEL} — msg=${JSON.stringify(MSG)}, ${ok.length}/${RUNS} runs ok\n`);
  console.log(
    `${''.padEnd(18)} ${'median'.padStart(8)} ${'min'.padStart(8)} ${'max'.padStart(8)} ${'spread'.padStart(8)}`,
  );
  for (const kind of ['cold', 'warm']) {
    console.log(row(`${kind} wall (s)`, summary[kind].wallSec));
    console.log(row(`${kind} re-eval tok`, summary[kind].reevalTokens));
    console.log(row(`${kind} generations`, summary[kind].generations));
  }
  console.log(`\nJSON: ${OUT}`);
  stopLog();
}

main().catch((e) => {
  console.error(e);
  stopLog();
  process.exit(1);
});
