// PERF HARNESS — development-only instrumentation.
//
// Why this exists: verifying a prompt change end-to-end used to cost a human
// ~2.5 minutes of manual tapping per sample, with enough run-to-run spread that
// a real 15% win was indistinguishable from noise. This lets a shell script
// drive one real turn and read structured timings back.
//
// It is wired in behind a single `if (__DEV__)` call site in app/index.tsx, so
// a release build never reaches any of it. NOTHING here changes how a turn is
// planned, prompted, or generated — it only observes, and (for the bench ops)
// builds its OWN throwaway llama contexts that the app never touches.
//
// Everything is driven by deep links, which is far more robust than
// `adb shell input text` + blind taps: no keyboard, no coordinates, no focus
// races, and the op can await the turn it started instead of polling pixels.
//
//   adb shell am start -a android.intent.action.VIEW -d 'whisper://?perf=1&op=send&msg=hi'
//
// The path is deliberately EMPTY. `whisper://perf?...` would be an unmatched
// expo-router route, which unmounts this screen onto a 404 and takes sendText's
// closure with it; the root path resolves to the chat screen we are already on,
// so the navigation is a no-op and `perf=1` is just an ignored query param.
//
// Results are emitted as one-line JSON on `console.log`, prefixed PERFH, which
// reaches both the Metro terminal and (via ReactNativeJS) logcat.
import * as Linking from 'expo-linking';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import {
  initLlama,
  type LlamaContext,
  type RNLlamaOAICompatibleMessage,
} from 'llama.rn';

import { agentPrefix } from '@/src/agent/prompt';
import { TOOLS } from '@/src/agent/tools';
import * as ChatStore from '@/src/chat/store';
import { engineFor, unloadAll } from '@/src/engines';
import * as ModelManager from '@/src/models/ModelManager';

/** What the host script needs from the running screen. Refreshed every render. */
export type PerfApi = {
  sendText: (text: string) => Promise<void>;
  ready: boolean;
  busy: boolean;
};

const TAG = 'PERFH';

function log(payload: Record<string, unknown>): void {
  // One line, one JSON object — the host greps for the prefix and JSON.parse()s
  // the remainder, so this must never be pretty-printed or split.
  console.log(`${TAG} ${JSON.stringify({ at: Date.now(), ...payload })}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll a predicate until it holds, or give up. Returns whether it held. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(250);
  }
  return pred();
}

/**
 * Context params identical to LlamaEngine.initContext's Android-CPU branch.
 *
 * Deliberately duplicated rather than imported: LlamaEngine builds these inline
 * inside a private function, and exporting them would be a production change to
 * serve a dev tool. The values are asserted back from the live context in every
 * bench result (`nBatch`/`nUBatch`/`flashAttn`/`nThreads`), so drift shows up in
 * the output rather than silently biasing it.
 */
function benchContextParams(modelPath: string, nCtx: number) {
  return {
    model: modelPath,
    n_ctx: nCtx,
    n_gpu_layers: 0,
    use_mmap: true,
    use_mlock: false,
    no_extra_bufts: true,
    ctx_shift: true,
    n_threads: 4,
    cache_type_k: 'q8_0' as const,
    cache_type_v: 'q8_0' as const,
    flash_attn_type: 'on' as const,
  };
}

/** Resolve the active model's on-disk path, or throw with a readable reason. */
function activeModel(): { path: string; nCtx: number; id: string } {
  const spec = ModelManager.getActive();
  if (!spec) throw new Error('no active model');
  const files = ModelManager.filePaths(spec);
  return { path: files.model, nCtx: spec.nCtx, id: spec.id };
}

/**
 * Build a throwaway context for measurement.
 *
 * The app's own context is released first. Two resident copies of a 1.7B Q4_K_M
 * would be ~2.2 GB of weights on a 6 GB AVD that is already carrying a KV cache
 * and a compute buffer, and an OOM mid-sweep would cost the whole run.
 */
async function withFreshContext<T>(
  overrides: Record<string, unknown>,
  fn: (ctx: LlamaContext) => Promise<T>,
): Promise<T> {
  const { path, nCtx } = activeModel();
  await unloadAll();
  const ctx = await initLlama({
    ...benchContextParams(path, nCtx),
    ...overrides,
  } as Parameters<typeof initLlama>[0]);
  try {
    return await fn(ctx);
  } finally {
    await ctx.release();
  }
}

/**
 * bench() leaves the context unusable for completions and it does so SILENTLY.
 *
 * rn-completion.cpp calls `llama_memory_clear()` before every run and after the
 * loop, but never clears `completion->embd`. The next completion() therefore
 * computes a large positive n_past against an empty KV cache, issues a no-op
 * seq_rm, and decodes from that position with nothing behind it — no exception,
 * no warning, just wrong output. clearCache() (rn-llama.cpp) is the one that
 * clears memory AND embd AND n_past. The same defect affects embedding() and
 * rerank(). We bench on a throwaway context anyway, so this is belt-and-braces.
 */
async function benchOnce(
  ctx: LlamaContext,
  pp: number,
  tg: number,
  nr: number,
): Promise<Record<string, unknown>> {
  // pl is pinned to 1: the app loads with n_seq_max = 1, and bench adds tokens
  // with seq_id = seq for seq < pl, so anything higher decodes into a sequence
  // the context does not have.
  const r = await ctx.bench(pp, tg, 1, nr);
  await ctx.clearCache();
  return {
    pp,
    tg,
    nr,
    speedPp: r.speedPp,
    speedTg: r.speedTg,
    tPp: r.tPp,
    tTg: r.tTg,
    nBatch: r.nBatch,
    nUBatch: r.nUBatch,
    flashAttn: r.flashAttn,
    nThreads: r.nThreads,
    nThreadsBatch: r.nThreadsBatch,
    nGpuLayers: r.nGpuLayers,
    nKvMax: r.nKvMax,
  };
}

// --- ops ---------------------------------------------------------------------

/**
 * Wait out an in-flight prewarm.
 *
 * LlamaEngine serializes every native call through one promise chain, and
 * countTokens() goes through it while generate() deliberately does not (it
 * aborts the prewarm instead). So enqueuing a trivial countTokens resolves
 * exactly when the prewarm chain has drained — a deterministic "prefix is fully
 * warm" signal, with no change to the engine. Without this, a cold turn's cost
 * depends entirely on WHICH prewarm slice was in flight when the user sent,
 * which is the single largest source of the run-to-run spread this replaces.
 */
async function opDrain(api: () => PerfApi): Promise<void> {
  // The model must be loaded first: countTokens throws on a null context, and
  // on a cold start the link can easily beat the load.
  const ok = await waitFor(() => api().ready, 300_000);
  const spec = ModelManager.getActive();
  if (!ok || !spec) {
    log({ ev: 'error', op: 'drain', reason: 'model never became ready' });
    return;
  }
  const t0 = Date.now();
  await engineFor(spec).countTokens?.('.');
  log({ ev: 'drained', ms: Date.now() - t0 });
}

async function opSend(
  api: () => PerfApi,
  msg: string,
  tag: string,
): Promise<void> {
  const ok = await waitFor(() => api().ready && !api().busy, 300_000);
  if (!ok) {
    log({ ev: 'error', op: 'send', reason: 'never became ready/idle', tag });
    return;
  }
  const t0 = Date.now();
  log({ ev: 'turn_start', tag, msg });
  // sendText awaits runModel, which awaits the whole agent loop, so this
  // resolves when the turn is genuinely finished — not when the orb hides.
  await api().sendText(msg);
  log({ ev: 'turn_end', tag, msg, ms: Date.now() - t0 });
}

/**
 * Settle `n_predict: 0` vs `1` for the prewarm.
 *
 * bench() CANNOT answer this: it clears the KV cache on every run, so it can
 * measure throughput but not cache residency, which is the entire question.
 * The right instrument is the thing the app already reports — `cache_n` on the
 * completion that follows the prewarm. Three arms, each on its own fresh
 * context so no arm inherits another's cache:
 *
 *   control : no prewarm at all      -> expect cached ~= 0
 *   n1      : shipped prewarm        -> expect cached ~= the whole prefix
 *   n0      : same, with n_predict 0 -> the claim under test
 */
async function opNpredict(reps: number): Promise<void> {
  const prefix = agentPrefix(TOOLS);
  const full = prefix[prefix.length - 1]!.content;
  const CHUNK = 1500; // mirrors LlamaEngine.PREWARM_CHUNK_CHARS

  const arms: { arm: string; nPredict: number | null }[] = [
    { arm: 'control', nPredict: null },
    { arm: 'n1', nPredict: 1 },
    { arm: 'n0', nPredict: 0 },
  ];

  for (let rep = 0; rep < reps; rep++) {
    for (const { arm, nPredict } of arms) {
      try {
        await withFreshContext({}, async (ctx) => {
          let warmMs = 0;
          if (nPredict !== null) {
            const t0 = Date.now();
            for (let end = CHUNK; ; end += CHUNK) {
              const sliced = [
                ...prefix.slice(0, -1),
                { ...prefix[prefix.length - 1]!, content: full.slice(0, end) },
              ];
              await ctx.completion({
                messages: sliced as RNLlamaOAICompatibleMessage[],
                n_predict: nPredict,
                temperature: 0,
              });
              if (end >= full.length) break;
            }
            warmMs = Date.now() - t0;
          }
          // The probe: the real thing a first user turn would send.
          const probe = await ctx.completion({
            messages: [
              ...prefix,
              { role: 'user', content: 'hi' },
            ] as RNLlamaOAICompatibleMessage[],
            n_predict: 1,
            temperature: 0,
          });
          const t = probe.timings;
          log({
            ev: 'npredict',
            arm,
            rep,
            warmMs,
            cached: t?.cache_n ?? -1,
            promptTokens: t?.prompt_n ?? -1,
            promptMs: Math.round(t?.prompt_ms ?? -1),
          });
        });
      } catch (e) {
        log({ ev: 'error', op: 'npredict', arm, rep, reason: String(e) });
      }
    }
  }
}

/**
 * Even/odd micro-batch A/B.
 *
 * ggml-cpu.c drops mul_mat from the 2-row i8mm (`smmla`) path to the 1-row
 * `sdot` path whenever `ne11` — the token count in the micro-batch — is odd.
 * Because the app ships `no_extra_bufts: true`, that vec_dot path IS the hot
 * prefill path, so an odd-length prompt may be running the whole prefill at
 * roughly half throughput. A warm turn's 305-token prefill is a single odd
 * micro-batch, which is exactly the shape that would be hit.
 *
 * Note the prediction is sharp and worth checking against the data: the penalty
 * should only bite while pp fits in ONE micro-batch (pp <= n_ubatch, 512 by
 * default). At pp = 1025 llama.cpp splits into 512 + 512 + 1, so only a 1-token
 * tail is odd and the effect should all but vanish. If odd is slow at 1025 too,
 * the explanation is not this branch.
 */
async function opParity(
  pairs: number[],
  tg: number,
  nr: number,
  threads: number[],
  reps: number,
): Promise<void> {
  for (const nThreads of threads) {
    try {
      // ONE context for every pp value, and the whole list repeated `reps`
      // times so the arms are INTERLEAVED rather than run in blocks. The host
      // running this AVD drifts by more than the effect we are looking for over
      // the span of a few minutes, so 304-then-305 measured once apart in time
      // would mostly report the drift. Interleaving lets a per-pp median cancel
      // it. bench() clears the KV cache before every run, so successive calls on
      // one context are self-consistent — the only hazard is what runs AFTER
      // (see benchOnce).
      await withFreshContext({ n_threads: nThreads }, async (ctx) => {
        for (let rep = 0; rep < reps; rep++) {
          for (const pp of pairs) {
            const r = await benchOnce(ctx, pp, tg, nr);
            log({
              ev: 'parity',
              rep,
              nThreadsReq: nThreads,
              parity: pp % 2 === 0 ? 'even' : 'odd',
              ...r,
            });
          }
        }
      });
    } catch (e) {
      log({ ev: 'error', op: 'parity', nThreads, reason: String(e) });
    }
  }
}

/**
 * What a larger context window costs in memory.
 *
 * Opens a context at each n_ctx and holds it open for a fixed window so the
 * host can sample RSS from /proc, then releases. Memory is the one thing worth
 * measuring on a contended host: it does not move when the CPU is oversubscribed
 * the way throughput does.
 */
async function opCtxMem(ctxSizes: number[], holdMs: number): Promise<void> {
  for (const nCtx of ctxSizes) {
    try {
      await withFreshContext({ n_ctx: nCtx }, async (ctx) => {
        log({ ev: 'ctxmem_open', nCtx, gpu: ctx.gpu });
        await sleep(holdMs);
        log({ ev: 'ctxmem_hold_done', nCtx });
      });
      // Sample the floor with no context resident, so the host can subtract it.
      log({ ev: 'ctxmem_released', nCtx });
      await sleep(holdMs);
    } catch (e) {
      log({ ev: 'error', op: 'ctxmem', nCtx, reason: String(e) });
    }
  }
}

/**
 * n_batch / n_ubatch sweep.
 *
 * bench() reads n_batch/n_ubatch off the context and offers no way to pass
 * them, so each arm needs its own initLlama. Compute-buffer size is the other
 * half of the answer — this app fights for RAM on 8 GB phones — so the host
 * script samples RSS around each arm from /proc and llama.cpp prints the
 * compute buffer size at init, which lands in logcat next to these lines.
 */
async function opUbatch(
  combos: { nBatch: number; nUBatch: number }[],
  pp: number,
  tg: number,
  nr: number,
): Promise<void> {
  for (const { nBatch, nUBatch } of combos) {
    try {
      await withFreshContext({ n_batch: nBatch, n_ubatch: nUBatch }, async (ctx) => {
        const r = await benchOnce(ctx, pp, tg, nr);
        log({ ev: 'ubatch', reqBatch: nBatch, reqUBatch: nUBatch, ...r });
      });
    } catch (e) {
      log({ ev: 'error', op: 'ubatch', nBatch, nUBatch, reason: String(e) });
    }
  }
}

/** Put the app's own model back after a bench op released it. */
async function opReload(): Promise<void> {
  const spec = ModelManager.getActive();
  if (!spec) return;
  await engineFor(spec).load(spec, ModelManager.filePaths(spec));
  log({ ev: 'reloaded', model: spec.id });
}

// --- dispatch ----------------------------------------------------------------

function nums(v: string | undefined, fallback: number[]): number[] {
  if (!v) return fallback;
  const out = v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return out.length ? out : fallback;
}

async function dispatch(api: () => PerfApi, url: string): Promise<void> {
  const { queryParams } = Linking.parse(url);
  const q = (k: string): string | undefined => {
    const v = queryParams?.[k];
    return typeof v === 'string' ? v : undefined;
  };
  const op = q('op');
  const tag = q('tag') ?? 'run';
  const n = (k: string, d: number) => Number(q(k) ?? d) || d;

  log({ ev: 'op_start', op, tag, url });
  try {
    switch (op) {
      case 'ping':
        log({ ev: 'pong', ready: api().ready, busy: api().busy, platform: Platform.OS });
        break;
      case 'new':
        await ChatStore.startNew();
        log({ ev: 'new_conversation' });
        break;
      case 'drain':
        await opDrain(api);
        break;
      case 'send':
        await opSend(api, q('msg') ?? 'hi', tag);
        break;
      case 'waitready': {
        // Readiness WITHOUT draining the prewarm — the state the previous
        // session's driver measured from (it settled a fixed 3s after the model
        // became resident). Kept so this harness can reproduce that protocol
        // exactly, which is the only way its numbers are comparable to theirs.
        const ok = await waitFor(() => api().ready, 300_000);
        log({ ev: 'ready', ok });
        break;
      }
      case 'npredict':
        await opNpredict(n('reps', 3));
        break;
      case 'parity':
        await opParity(
          nums(q('pp'), [304, 305, 510, 511, 512, 513, 1024, 1025]),
          n('tg', 32),
          n('nr', 3),
          nums(q('threads'), [4]),
          n('reps', 3),
        );
        break;
      case 'ctxmem':
        await opCtxMem(nums(q('nctx'), [4096, 8192]), n('hold', 8000));
        break;
      case 'ubatch': {
        const batches = nums(q('nbatch'), [2048]);
        const ubatches = nums(q('nubatch'), [128, 256, 512, 1024, 2048]);
        const combos = batches.flatMap((b) =>
          ubatches.filter((u) => u <= b).map((u) => ({ nBatch: b, nUBatch: u })),
        );
        await opUbatch(combos, n('pp', 512), n('tg', 32), n('nr', 3));
        break;
      }
      case 'reload':
        await opReload();
        break;
      default:
        log({ ev: 'error', reason: `unknown op ${String(op)}` });
    }
  } catch (e) {
    log({ ev: 'error', op, tag, reason: String(e) });
  }
  // Any op that benched left the app with no context (withFreshContext unloads
  // first and releases after). Reload before handing control back, so a caller
  // cannot accidentally measure a turn on a context that a bench() left with a
  // cleared KV cache but a stale `embd` — that combination reports a large
  // `cache` and a small `prefill`, which is exactly the signature of a WORKING
  // prefix restore, so it would read as a false positive on the thing we are
  // trying to verify rather than as an error.
  if (op === 'npredict' || op === 'parity' || op === 'ubatch' || op === 'ctxmem') {
    try {
      await opReload();
    } catch (e) {
      log({ ev: 'error', op: 'reload', reason: String(e) });
    }
  }
  log({ ev: 'op_done', op, tag });
}

// The live view of the chat screen, refreshed by the hook on every render.
// Module-level on purpose — see installOnce().
let currentApi: PerfApi = { sendText: async () => {}, ready: false, busy: false };

let installed = false;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Install the URL listener ONCE per JS runtime, outside React.
 *
 * An incoming deep link makes expo-router re-navigate to the root route, which
 * remounts the chat screen. If the listener lived in a component effect, that
 * remount would tear it down and orphan whatever op was in flight — observed
 * directly: `op=drain` started, the screen remounted twice, and the op never
 * reported completion because the promise chain it was queued on had been
 * discarded with the old mount. Module scope survives remounts; the API is read
 * through a mutable module binding so the op still sees the CURRENT mount's
 * sendText closure and ready/busy state rather than a stale one.
 */
function installOnce(): void {
  if (installed) return;
  installed = true;
  const handle = (url: string) => {
    if (!url.includes('perf=1')) return;
    // Serialize: a host script may fire the next op before this one lands.
    queue = queue.then(() => dispatch(() => currentApi, url)).catch(() => {});
  };
  Linking.addEventListener('url', ({ url }) => handle(url));
  void Linking.getInitialURL().then((u) => {
    if (u) handle(u);
  });
}

/** Publish the chat screen's current state to the harness. */
export function usePerfHarness(api: PerfApi): void {
  // After every render, not during one, so an op spanning minutes always reads
  // the latest state.
  useEffect(() => {
    currentApi = api;
  });
  useEffect(() => {
    installOnce();
    // Emitted per mount: the host uses it only to know the bundle is live, and
    // it is deliberately NOT the signal any op waits on.
    log({ ev: 'harness_ready' });
  }, []);
}
