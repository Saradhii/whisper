// Prefill benchmark, part 2 of 2: replay the tracks dumped by
// src/dev/prefillTracks.bench.ts against the app's real GGUF and time what each
// turn must evaluate before its first token. CPU only, 4 threads, batch 512.
//
//   npm run bench:prefill
//
// Needs the same two out-of-repo inputs as `npm run eval:real` (see
// src/agent/eval/real/model.ts): the GGUF at WHISPER_EVAL_MODEL and a
// node-llama-cpp install at WHISPER_EVAL_RUNNER.
//
// Token counts transfer to a phone exactly. Seconds are for THIS machine: a
// phone's prefill rate differs, and so may the old/new ratio.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const CACHE = path.join(os.homedir(), '.cache', 'whisper-eval');
const MODEL = process.env.WHISPER_EVAL_MODEL ?? path.join(CACHE, 'qwen3-1.7b-q4km.gguf');
const RUNNER = process.env.WHISPER_EVAL_RUNNER ?? path.join(CACHE, 'runner', 'node_modules');
const TRACKS =
  process.env.WHISPER_BENCH_TRACKS ?? path.join(os.tmpdir(), 'whisper-prefill-tracks.json');

const { getLlama } = await import(
  pathToFileURL(path.join(RUNNER, 'node-llama-cpp', 'dist', 'index.js')).href
);
const tracks = JSON.parse(fs.readFileSync(TRACKS, 'utf8'));
const REPEATS = Number(process.env.REPEATS ?? 3);
const only = process.env.ONLY ? Number(process.env.ONLY) : null;

const llama = await getLlama({ gpu: false, logLevel: 'error' });
const model = await llama.loadModel({ modelPath: MODEL });
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function runTrack(nCtx, steps) {
  const context = await model.createContext({ contextSize: nCtx, sequences: 1, threads: 4, batchSize: 512 });
  const seq = context.getSequence();
  const rows = [];
  for (const step of steps) {
    const tokens = model.tokenize(step.prompt, true);
    await seq.adaptStateToTokens(tokens, false);
    const cached = seq.nextTokenIndex;
    const rest = tokens.slice(cached);
    const t0 = performance.now();
    // Prefill, then sample ONE token: this is time-to-first-token.
    for await (const _ of seq.evaluate(rest, { temperature: 0 })) break;
    const ms = performance.now() - t0;
    if (step.measured) rows.push({ evaluated: rest.length, cached, ms });
  }
  await context.dispose();
  return rows;
}

const results = [];
for (const [i, sc] of tracks.entries()) {
  if (only !== null && only !== i) continue;
  const agg = {};
  for (const arm of ['old', 'neu']) {
    const reps = [];
    for (let r = 0; r < REPEATS; r++) {
      const rows = await runTrack(sc.nCtx, sc[arm]);
      reps.push({
        tokens: rows.reduce((a, x) => a + x.evaluated, 0) / rows.length,
        ms: rows.reduce((a, x) => a + x.ms, 0) / rows.length,
        turns: rows.length,
      });
    }
    agg[arm] = {
      tokens: Math.round(reps[0].tokens),
      ms: Math.round(median(reps.map((x) => x.ms))),
      min: Math.round(Math.min(...reps.map((x) => x.ms))),
      max: Math.round(Math.max(...reps.map((x) => x.ms))),
      turns: reps[0].turns,
    };
  }
  const line = { name: sc.name, ...agg };
  results.push(line);
  console.log('RESULT ' + JSON.stringify(line));
}

// Cost of restoring a checkpoint: prefix-only (old cold start) vs prefix +
// 15-turn conversation (new cold start).
if (only === null) {
  for (const [label, prompt] of [['prefix only', tracks[1].old[0].prompt], ['prefix + 15-turn chat', tracks[1].neu[0].prompt]]) {
    const context = await model.createContext({ contextSize: 8192, sequences: 1, threads: 4, batchSize: 512 });
    const seq = context.getSequence();
    const tokens = model.tokenize(prompt, true);
    await seq.evaluateWithoutGeneratingNewTokens(tokens);
    const file = path.join(os.tmpdir(), 'bench-state.bin');
    let t0 = performance.now();
    const { fileSize } = await seq.saveStateToFile(file);
    const saveMs = performance.now() - t0;
    await context.dispose();
    const c2 = await model.createContext({ contextSize: 8192, sequences: 1, threads: 4, batchSize: 512 });
    const s2 = c2.getSequence();
    t0 = performance.now();
    await s2.loadStateFromFile(file, { acceptRisk: true });
    const loadMs = performance.now() - t0;
    console.log('STATE ' + JSON.stringify({ label, tokens: tokens.length, mb: +(fileSize / 2 ** 20).toFixed(1), saveMs: Math.round(saveMs), loadMs: Math.round(loadMs) }));
    await c2.dispose();
    fs.rmSync(file, { force: true });
  }
}
console.log('\n| Scenario | Old tokens | Old ms | New tokens | New ms | Speedup |');
console.log('|---|---|---|---|---|---|');
for (const r of results) {
  console.log(
    `| ${r.name} | ${r.old.tokens} | ${r.old.ms} | ${r.neu.tokens} | ${r.neu.ms} | ${(r.old.ms / r.neu.ms).toFixed(1)}x |`,
  );
}
await model.dispose();
process.exit(0);
