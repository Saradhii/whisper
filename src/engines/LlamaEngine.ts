// llama.cpp engine via llama.rn. Handles any GGUF model, with optional vision
// through a mmproj file. Only one model is ever resident: load() releases the
// previous context before creating the next.
//
// All native access is serialized through a single promise queue: llama.rn's
// context is not reentrant, so a completion racing another completion (e.g. the
// uncensored canary vs. a user message) or a load racing a release corrupts
// native state. stop() is the one deliberate exception — it must interrupt the
// completion currently holding the queue.
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import {
  initLlama,
  releaseAllLlama,
  type LlamaContext,
  type RNLlamaOAICompatibleMessage,
} from 'llama.rn';

import type { ModelSpec } from '@/src/models/catalog';
import * as Settings from '@/src/settings/store';
import { holdWakeLock } from './keepAlive';
import { normalizeToolCalls } from './toolcalls';
import type {
  AgentMessage,
  Engine,
  GenerateOptions,
  GenerateResult,
  ModelFiles,
} from './types';

let context: LlamaContext | null = null;
let loadedSpec: ModelSpec | null = null;
let loadedFiles: ModelFiles | null = null;

// True while a prewarm completion is in flight, so a real turn can cut it
// short instead of queueing behind it.
// True while a load is queued or running: the model is "about to be resident",
// which the lifecycle guard treats the same as resident.
let loading = 0;
let prewarming = false;
// Set by a real turn so a prewarm that is still QUEUED does not start at all.
let prewarmAbort = false;

// Set while suspended: the model to restore on the next generate()/resume().
let suspendedSpec: ModelSpec | null = null;
let suspendedFiles: ModelFiles | null = null;
// Whether the vision projector has been loaded into the current context.
// Cleared with the context, so a reload starts text-only again.
let multimodalReady = false;

// Android CPU decode: pin to the performance cores. Phones are big.LITTLE, so
// using every core (llama.cpp's default) drags the fast cores down to the pace
// of the little ones — 4 threads is the widely-tuned sweet spot for on-device
// llama.cpp and matches what whisper uses here.
const ANDROID_THREADS = 4;

/**
 * The KV checkpoint: one file holding whatever the context last evaluated —
 * the agent prefix on a first run, prefix + conversation after that.
 *
 * It is written when the app has been off-screen for a few seconds
 * (lifecycle.ts), before a release, and once after the very first prewarm; it
 * is read back after EVERY model load, cold start included. That last part is
 * the point. The snapshot used to be remembered only in a JS variable, so it
 * was honoured on an in-process resume and orphaned by exactly the event it
 * existed for: the process being killed in the background. A cold start then
 * restored at most the system prefix and re-read the whole conversation inside
 * the user's first message.
 *
 * There is deliberately ONE file, not a prefix snapshot plus a conversation
 * snapshot. A conversation checkpoint BEGINS with the prefix, and the cache
 * hit is computed by comparing token vectors (find_common_prefix_length in
 * rn-completion.cpp), so restoring it into a different conversation — or a new
 * one — still yields the full prefix hit and never a wrong answer. A stale
 * snapshot degrades to a shorter common prefix; that is all it can do.
 *
 * The sidecar stamp is the context signature. It is not needed for
 * correctness either: it only stops a multi-hundred-MB read of a file written
 * by another model or KV geometry, which llama.cpp would reject anyway.
 *
 * Lives in the cache dir — a pure speed optimization, so the OS reclaiming it
 * costs nothing but latency.
 */
const SESSION_PATH = (
  (FileSystem.cacheDirectory ?? FileSystem.documentDirectory) + 'llama-session.bin'
).replace('file://', '');
const SESSION_META_PATH =
  (FileSystem.cacheDirectory ?? FileSystem.documentDirectory) + 'llama-session.json';

// Builds before the single checkpoint kept a separate ~100 MB prefix snapshot.
// Nothing reads it any more; reclaim the space once per process.
for (const stale of ['llama-prefix.bin', 'llama-prefix.json']) {
  void FileSystem.deleteAsync(
    (FileSystem.cacheDirectory ?? FileSystem.documentDirectory) + stale,
    { idempotent: true },
  ).catch(() => {});
}

/** Identity of the loaded context: a snapshot is only loadable into the same
 *  model and the same KV geometry. Set by doLoad, cleared by doUnload. */
let contextSig: string | null = null;

/** True when the KV cache holds something the checkpoint on disk does not. */
let kvDirty = false;

/** True once this context has evaluated an image. Image embeddings sit in the
 *  cache without a token representation; such a context is never checkpointed
 *  and resumes by re-prefilling instead (correct, just slower). */
let kvHasImage = false;

/**
 * Token length of the rendered SYSTEM turn, memoized per distinct system text.
 * Passed as `n_keep` so an overflow evicts old conversation, not the prompt.
 * Cleared with the context: the count belongs to one model's tokenizer.
 */
let keepMemo: { system: string; tokens: number } | null = null;

/** Template wrapping assumed around the system text when the system turn
 *  cannot be rendered on its own (BOS + ChatML open/close is 6). Erring high
 *  pins a few tokens of the next turn's header; erring low would drop the END
 *  of the system prompt, which is where the JSON protocol lives. */
const SYSTEM_WRAP_TOKENS = 8;

/**
 * How many leading prompt tokens a context shift must not discard.
 *
 * Only called from inside the serialization queue. Costs one template render
 * and one tokenize per distinct system prompt (it changes when the date line
 * does), then nothing. Returns 0 — llama.rn's own default — whenever there is
 * no system turn or the count cannot be had: this is a backstop for a path the
 * token budgets already keep unreachable, never a reason to fail a turn.
 */
async function systemKeepTokens(ctx: LlamaContext, messages: AgentMessage[]): Promise<number> {
  const first = messages[0];
  if (!first || first.role !== 'system' || !first.content) return 0;
  if (keepMemo?.system === first.content) return keepMemo.tokens;
  let tokens = 0;
  try {
    // Exact where the template can render a lone system turn: the result is
    // the literal prefix of every prompt this conversation will send.
    const rendered = await ctx.getFormattedChat(
      [{ role: 'system', content: first.content }],
      null,
      { add_generation_prompt: false },
    );
    tokens = (await ctx.tokenize(rendered.prompt)).tokens.length;
  } catch {
    // Templates that refuse a conversation with no user turn land here.
    try {
      tokens = (await ctx.tokenize(first.content)).tokens.length + SYSTEM_WRAP_TOKENS;
    } catch {
      return 0;
    }
  }
  keepMemo = { system: first.content, tokens };
  return tokens;
}

// --- serialization queue ---
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = chain.then(op, op);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// --- Android GPU probe ---
// llama.rn ships an OpenCL (Adreno) build and auto-loads it on Snapdragon
// devices, so n_gpu_layers can offload there too — but we only trust it after
// a successful probe. The flag is written to disk *before* the first GPU
// attempt: if that init takes the process down natively, the next launch finds
// 'probing' and falls back to CPU permanently instead of crash-looping.
type GpuProbe = 'untested' | 'probing' | 'ok' | 'failed';
const GPU_PROBE_PATH = FileSystem.documentDirectory + 'gpu-probe.txt';
let gpuProbe: GpuProbe | null = null;

// The verdict is stamped with the build that produced it. Without this the flag
// latches: one transient failure — an OOM during a first load while another app
// held the RAM, a driver hiccup — costs that install its GPU offload
// permanently, with no way back short of clearing app data. A new build ships a
// new llama.rn and deserves a fresh probe.
//
// Stamped on versionCode, not version. versionCode is the field that must
// increment for every uploaded build, so it moves on its own; a marketing
// version can sit at 1.0.0 across several builds, and a stamp that doesn't move
// is the same latch this exists to break. version is the fallback for iOS,
// which has no versionCode.
const PROBE_STAMP = String(
  Constants.expoConfig?.android?.versionCode ?? Constants.expoConfig?.version ?? 'dev',
);

async function readGpuProbe(): Promise<GpuProbe> {
  if (gpuProbe === null) {
    const raw = await FileSystem.readAsStringAsync(GPU_PROBE_PATH).catch(() => null);
    const [value, stamp] = (raw ?? '').split('@');
    gpuProbe =
      stamp === PROBE_STAMP && (value === 'probing' || value === 'ok' || value === 'failed')
        ? value
        : 'untested';
  }
  return gpuProbe;
}

async function writeGpuProbe(value: GpuProbe): Promise<void> {
  gpuProbe = value;
  await FileSystem.writeAsStringAsync(GPU_PROBE_PATH, `${value}@${PROBE_STAMP}`).catch(() => {});
}

/**
 * GPU layers to request for this load. iOS always gets Metal.
 *
 * Android is CPU unless the user opts in (Settings.gpuAccel). llama.rn picks
 * its OpenCL build on its own on Snapdragon 8-series phones, and until this
 * was gated every such phone silently took a path nothing here was measured
 * on: weights copied out of the evictable file mapping into driver memory,
 * a full-precision KV cache (about twice the size), none of the anonymous-RSS
 * work below applying, and a complete re-upload on every load. The CPU path is
 * the one the prefill and memory numbers in docs/perf describe.
 */
async function gpuLayersFor(): Promise<number> {
  if (Platform.OS === 'ios') return 99;
  await Settings.init().catch(() => {});
  if (!Settings.get().gpuAccel) return 0;
  const probe = await readGpuProbe();
  if (probe === 'ok') return 99;
  if (probe === 'untested') {
    await writeGpuProbe('probing');
    return 99;
  }
  // 'failed', or 'probing' left over from a crash during the last attempt.
  if (probe === 'probing') await writeGpuProbe('failed');
  return 0;
}

async function initContext(
  spec: ModelSpec,
  files: ModelFiles,
  gpuLayers: number,
  onProgress?: (progress: number) => void,
): Promise<LlamaContext> {
  const ctx = await initLlama(
    {
      model: files.model,
      n_ctx: spec.nCtx,
      n_gpu_layers: gpuLayers,
      // Prompt evaluation runs in chunks of n_batch and llama.rn checks its
      // interrupt flag only BETWEEN chunks (rn-completion.cpp). The default is
      // 2048, which made any prompt up to 2048 tokens one uninterruptible
      // llama_decode: the Stop button was dead for the whole prefill, and a
      // prewarm could not yield to a real turn. 512 is n_ubatch's own default,
      // so the compute batch — and with it throughput — is unchanged; only the
      // granularity at which a stop is noticed moves.
      n_batch: 512,
      // CPU-only means CPU-only. With n_gpu_layers 0 alone the default device
      // list still contains the GPU and llama.cpp still initialises that
      // backend for the context. Naming the CPU device yields an empty offload
      // list (buildDeviceOverrides in RNLlamaJSI.cpp).
      ...(Platform.OS === 'android' && gpuLayers === 0 ? { devices: ['CPU'] } : {}),
      // mmap keeps the multi-GB weights file-backed: under memory pressure the
      // OS can evict and re-fault those pages instead of killing the process.
      // mlock would pin them as unevictable — never on a phone.
      use_mmap: true,
      use_mlock: false,
      // Weight repacking off. llama.cpp otherwise allocates a repacked,
      // ARM-optimised copy of the quantized weights in ANONYMOUS memory,
      // *alongside* the mmap — measured on device at 1049.96 MiB next to a
      // 1043.68 MiB mapping, i.e. the weights resident twice. Anonymous memory
      // is what Android's low-memory killer weighs; the mapping is clean and
      // evictable. Disabling it cut this process's anonymous RSS by 71%
      // (1479 -> 429 MiB) with the KV cache and compute buffer byte-identical.
      //
      // The cost is prefill only, and it is bounded: repack buys GEMM blocking,
      // not an instruction set. Q4_K only repacks when NEON+dotprod (or i8mm)
      // is present, and the non-repacked vec_dot on those same builds uses the
      // same sdot/smmla instruction — so this never falls back to the emulated
      // or scalar path. Decode is gemv either way and does not move.
      no_extra_bufts: true,
      // If a conversation outgrows n_ctx anyway, shift the cache window rather
      // than failing the completion (history is budgeted before we get here).
      // The shift discards from just after `n_keep`, which doGenerate() sets to
      // the system turn's length, so an overflow costs old conversation rather
      // than the tool catalog. Tool results are still token-bounded in the
      // agent loop: a shift re-prefills the whole next turn, so this remains a
      // backstop and not a code path.
      ctx_shift: true,
      ...(Platform.OS === 'android' && gpuLayers === 0
        ? {
            n_threads: ANDROID_THREADS,
            // Quantize BOTH cache halves to 8-bit on memory-tight Android CPU
            // runs. Measured split on device for a 28-layer 4096-ctx model:
            // K (q8_0) 119 MiB + V (f16) 224 MiB, so quantizing V is worth as
            // much again as quantizing K — 135 MiB on Qwen3-4B.
            cache_type_k: 'q8_0' as const,
            cache_type_v: 'q8_0' as const,
            // A quantized V cache REQUIRES flash attention, and llama.cpp's own
            // guard only tests the *requested* enum: 'auto' passes the check and
            // can still resolve to disabled at runtime, which is exactly the
            // combination the guard exists to prevent. Ask for it explicitly.
            // Verified on device: flash attention resolves to enabled here.
            flash_attn_type: 'on' as const,
          }
        : {
            ...(Platform.OS === 'android' ? { n_threads: ANDROID_THREADS } : {}),
            // Offloaded (OpenCL/Metal) paths keep the defaults and the auto
            // probe — the quantized-V requirement above is not safe to assume
            // on a backend this has not been measured on.
            flash_attn_type: 'auto' as const,
          }),
    },
    // llama.rn reports 1..100; normalize to 0..1 for the UI.
    onProgress ? (p) => onProgress(p / 100) : undefined,
  );

  // Vision is NOT initialized here — see ensureMultimodal(). The projector is
  // a separate multi-hundred-MB file (940 MiB for the catalog's recommended
  // Gemma E2B) and loading it at model-load time made every text-only chat pay
  // for a capability most sessions never use.
  return ctx;
}

/**
 * Load the vision projector on first actual image use, not at model load.
 *
 * `mmproj-F16.gguf` for the catalog's suggested Gemma E2B is 940 MiB, and on
 * Android it lands in anonymous RAM (`use_gpu` is false there) — the memory the
 * low-memory killer weighs. Loading it eagerly meant a user who never attaches
 * a photo still carried it, resident, for the whole session, on top of the
 * weights and the KV cache.
 *
 * Once loaded it STAYS loaded: the cost is a one-off delay on the first image
 * turn, and paying it again on every image would be worse than holding it.
 * doUnload/doSuspend clear the flag along with the context.
 *
 * Callers are already inside the serialization queue — this must not re-enter
 * enqueue(), or it would deadlock behind the generate() holding the chain.
 */
async function ensureMultimodal(): Promise<void> {
  if (multimodalReady || !context || !loadedSpec?.vision || !loadedFiles?.mmproj) return;
  await context.initMultimodal({
    path: loadedFiles.mmproj,
    use_gpu: Platform.OS === 'ios',
  });
  multimodalReady = true;
}

async function doLoad(
  spec: ModelSpec,
  files: ModelFiles,
  onProgress?: (progress: number) => void,
): Promise<void> {
  if (context && loadedSpec?.id === spec.id) return;
  await doUnload();

  const gpuLayers = await gpuLayersFor();
  let ctx: LlamaContext;
  try {
    ctx = await initContext(spec, files, gpuLayers, onProgress);
  } catch (e) {
    // Only blame the GPU (and retry on CPU) while probing — a failure under a
    // previously *proven* GPU config is a model problem, not a backend one.
    if (Platform.OS === 'android' && gpuLayers > 0 && gpuProbe === 'probing') {
      await writeGpuProbe('failed');
      ctx = await initContext(spec, files, 0, onProgress);
    } else {
      throw e;
    }
  }
  if (Platform.OS === 'android' && gpuProbe === 'probing') {
    // gpu=false with layers requested means no usable device — don't reprobe.
    await writeGpuProbe(ctx.gpu ? 'ok' : 'failed');
    if (!ctx.gpu) {
      // A SOFT probe failure: init succeeded but nothing was offloaded, so this
      // context was built down the offloaded branch — without the quantized K/V
      // caches and explicit flash attention that the CPU path relies on. Keeping
      // it costs a measured 105 MiB of f16 KV for the whole session, on exactly
      // the devices that just proved they have no GPU to spare it. Rebuild on
      // the CPU path now that we know.
      await releaseAllLlama();
      ctx = await initContext(spec, files, 0, onProgress);
    }
  }

  context = ctx;
  loadedSpec = spec;
  loadedFiles = files;
  // Everything a saved KV snapshot must agree with to be loadable at all.
  contextSig = [
    spec.id,
    spec.nCtx,
    Platform.OS,
    gpuLayers > 0 && ctx.gpu ? 'gpu' : 'cpu',
    PROBE_STAMP,
  ].join('|');
  kvDirty = false;
  kvHasImage = false;
}

/**
 * Read the KV checkpoint into a context that has just been created. Only ever
 * called on an EMPTY cache — loadSession replaces the cache wholesale, so
 * doing this to a context that has generated would swap the model's memory out
 * from under the conversation.
 */
async function doRestore(): Promise<void> {
  if (!context || !contextSig) return;
  const stamp = await FileSystem.readAsStringAsync(SESSION_META_PATH).catch(() => null);
  if (stamp !== contextSig) return;
  try {
    await context.loadSession(SESSION_PATH);
  } catch {
    // Truncated, or reclaimed by the OS — the next completion re-prefills.
  }
}

/**
 * Write the KV cache to disk without releasing anything. No-op when the disk
 * already holds what the cache does.
 */
async function doCheckpoint(): Promise<void> {
  if (!context || !contextSig || !kvDirty || kvHasImage) return;
  try {
    // Stamp off first: a save torn by a kill must not be trusted next launch.
    await FileSystem.deleteAsync(SESSION_META_PATH, { idempotent: true }).catch(() => {});
    await context.saveSession(SESSION_PATH, { tokenSize: -1 });
    await FileSystem.writeAsStringAsync(SESSION_META_PATH, contextSig);
    kvDirty = false;
  } catch {
    // Out of disk, or the cache dir was reclaimed. Costs latency only.
  }
}

async function doUnload(): Promise<void> {
  await releaseAllLlama();
  context = null;
  loadedSpec = null;
  loadedFiles = null;
  suspendedSpec = null;
  suspendedFiles = null;
  multimodalReady = false;
  keepMemo = null;
  contextSig = null;
  kvDirty = false;
  kvHasImage = false;
}

async function doSuspend(): Promise<void> {
  if (!context || !loadedSpec || !loadedFiles) return;
  const spec = loadedSpec;
  const files = loadedFiles;
  // Snapshot the KV cache so resume skips re-prefilling the conversation.
  await doCheckpoint();
  await releaseAllLlama();
  context = null;
  loadedSpec = null;
  loadedFiles = null;
  suspendedSpec = spec;
  suspendedFiles = files;
  multimodalReady = false;
  keepMemo = null;
  contextSig = null;
}

async function doResume(): Promise<void> {
  if (context || !suspendedSpec || !suspendedFiles) return;
  const spec = suspendedSpec;
  const files = suspendedFiles;
  suspendedSpec = null;
  suspendedFiles = null;
  // Weights pages are usually still in the OS page cache, so this re-init is
  // far cheaper than the cold load.
  await doLoad(spec, files);
  await doRestore();
}

async function doGenerate(
  messages: AgentMessage[],
  onToken: (token: string) => void,
  opts?: GenerateOptions,
): Promise<GenerateResult> {
  if (!context) throw new Error('No model loaded.');

  // Build the OpenAI-compatible message list. If there's an image, replace
  // the last user turn's plain content with a [text, image] parts array.
  // llama.rn applies the GGUF's built-in chat template automatically and
  // extracts `image_url` parts into the native multimodal path.
  let payload: unknown[] = messages;
  if (opts?.imageUri) {
    // First image of this context pays for the projector; later ones don't.
    await ensureMultimodal();
    kvHasImage = true;
    const path = opts.imageUri.replace('file://', '');
    payload = messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user'
        ? {
            role: 'user',
            content: [
              { type: 'text', text: m.content },
              { type: 'image_url', image_url: { url: path } },
            ],
          }
        : m,
    );
  }

  const keep = await systemKeepTokens(context, messages);

  kvDirty = true;
  const result = await context.completion(
    {
      // Pin the system turn across a context shift (see ctx_shift in
      // initContext). Per-request in llama.rn; 0 is its default.
      ...(keep > 0 ? { n_keep: keep } : {}),
      // llama.rn's message type doesn't declare tool_calls/tool_call_id, but
      // the native OpenAI-compat parser accepts them — the single, deliberate
      // boundary cast. Everything inside `payload` is built from validated
      // values (see toolcalls.ts), never echoed native objects.
      messages: payload as RNLlamaOAICompatibleMessage[],
      n_predict: opts?.maxTokens ?? 1024,
      temperature: opts?.temperature ?? 0.7,
      stop: loadedSpec?.stop ?? [],
      // GBNF grammar (grammar-constrained decoding): forces the sampler to
      // only emit tokens forming a valid decision. Used for tool planning.
      ...(opts?.grammar ? { grammar: opts.grammar } : {}),
      // Native tool parsing (Jinja/common_chat) — used only when NOT grammar-
      // constrained. We drive tools via the grammar path instead (more robust).
      ...(opts?.tools && !opts.grammar
        ? { jinja: true, tools: opts.tools, tool_choice: 'auto' }
        : {}),
      // Qwen3-family kwarg; harmlessly ignored by other templates.
      ...(opts?.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    },
    (data) => {
      if (data.token) onToken(data.token);
    },
  );

  const t = result.timings;
  return {
    text: result.text.trim(),
    toolCalls: normalizeToolCalls(result.tool_calls),
    ...(t
      ? {
          timings: {
            cached: t.cache_n ?? 0,
            promptTokens: t.prompt_n ?? 0,
            promptMs: Math.round(t.prompt_ms ?? 0),
            predictedTokens: t.predicted_n ?? 0,
            predictedMs: Math.round(t.predicted_ms ?? 0),
          },
        }
      : {}),
  };
}

/** Tell speculative work to get out of a real turn's way. */
function cancelPrewarm(): void {
  prewarmAbort = true;
  // Prefill is interruptible at n_batch granularity (see initContext), so this
  // costs the turn at most one batch of somebody else's work — and the tokens
  // the prewarm did evaluate stay in the cache for the turn to reuse.
  if (prewarming) void context?.stopCompletion();
}

export const LlamaEngine: Engine = {
  load(spec, files, onProgress) {
    loading++;
    const loaded = enqueue(async () => {
      try {
        const fresh = !(context && loadedSpec?.id === spec.id);
        await doLoad(spec, files, onProgress);
        return fresh;
      } finally {
        loading--;
      }
    });
    // Restore the KV checkpoint as its own queue entry: the caller is told the
    // model is ready as soon as the weights are, while anything that would
    // touch the cache still queues behind the restore.
    void enqueue(async () => {
      if (await loaded.catch(() => false)) await doRestore();
    });
    return loaded.then(() => undefined);
  },

  generate(messages, onToken, opts) {
    // A real turn outranks speculative work. Measured on the test AVD with an
    // uninterruptible prewarm: a 123s opening turn against 58s with no prewarm
    // at all, which is the opposite of the point.
    cancelPrewarm();
    return enqueue(async () => {
      await doResume(); // transparent wake-up if the model was released
      // Hold the CPU for the length of the turn: the keep-alive service keeps
      // the PROCESS alive off-screen, but a sleeping device still stalls it.
      holdWakeLock(true);
      try {
        return await doGenerate(messages, onToken, opts);
      } finally {
        holdWakeLock(false);
      }
    });
  },

  prewarm(messages) {
    prewarmAbort = false;
    return enqueue(async () => {
      if (!context || prewarmAbort) return; // nothing loaded, or a turn is waiting
      prewarming = true;
      try {
        // n_predict 0 — "evaluate the prompt, generate nothing". Not just a
        // tidier spelling of 1: with n_predict 1 the sampled token is pushed
        // into rn-llama's `embd` but never decoded into the KV cache, leaving
        // embd one token LONGER than the cache is deep. The next call derives
        // its cache hit from find_common_prefix_length(embd, ...), so if that
        // stray token happens to equal the first divergent token of the next
        // prompt the hit lands one cell past what is actually cached and a
        // token is silently skipped. n_predict 0 returns before that push_back,
        // so embd is exactly the prefix.
        //
        // One completion, not a ladder of slices: prefill yields to
        // stopCompletion() between n_batch chunks now, which is what the
        // slicing used to emulate. Whatever was evaluated before a stop stays
        // cached, and — since this prompt is a prefix of the turn that
        // interrupted it — is exactly what that turn needs next.
        const res = await context.completion({
          messages: messages as RNLlamaOAICompatibleMessage[],
          n_predict: 0,
          temperature: 0,
          ...(loadedSpec?.stop ? { stop: loadedSpec.stop } : {}),
        });
        if ((res.timings?.prompt_n ?? 1) > 0) kvDirty = true;
        // First run on this install/model/build: there is no checkpoint yet,
        // so write one now rather than waiting for the app to be backgrounded
        // — otherwise a user who force-quits pays this whole warm-up again.
        // Later prewarms leave the write to lifecycle.ts.
        if (!prewarmAbort && contextSig) {
          const stamp = await FileSystem.readAsStringAsync(SESSION_META_PATH).catch(() => null);
          if (stamp !== contextSig) await doCheckpoint();
        }
      } catch {
        // Best-effort: a warm cache is an optimization, never a requirement.
      } finally {
        prewarming = false;
      }
    });
  },

  cancelPrewarm,

  isLoaded() {
    return context !== null || loading > 0;
  },

  checkpoint() {
    return enqueue(doCheckpoint);
  },

  countTokens(text) {
    return enqueue(async () => {
      await doResume();
      if (!context) throw new Error('No model loaded.');
      const res = await context.tokenize(text);
      return res.tokens.length;
    });
  },

  // Deliberately NOT queued: it interrupts the completion holding the queue.
  async stop() {
    if (context) await context.stopCompletion();
  },

  suspend(shouldProceed) {
    return enqueue(async () => {
      if (shouldProceed && !shouldProceed()) return;
      await doSuspend();
    });
  },

  resume() {
    return enqueue(doResume);
  },

  unload() {
    return enqueue(doUnload);
  },
};
