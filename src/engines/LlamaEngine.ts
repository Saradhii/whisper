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

// True while a prewarm completion is in flight, so a real generate() can cut
// it short instead of queueing behind it.
let prewarming = false;
// Set by generate() to tell a running prewarm to stop at its next chunk.
let prewarmAbort = false;

/**
 * How much of the prompt each prewarm slice adds. ~390 Qwen3 tokens, which is
 * ~8s of prefill on the test AVD and well under a second on a phone — the
 * worst case a user can wait for speculative work they did not ask for.
 */
const PREWARM_CHUNK_CHARS = 1500;

// Set while suspended: the model to restore on the next generate()/resume().
let suspendedSpec: ModelSpec | null = null;
let suspendedFiles: ModelFiles | null = null;
let sessionSaved = false;
// Whether the vision projector has been loaded into the current context.
// Cleared with the context, so a reload starts text-only again.
let multimodalReady = false;

// Android CPU decode: pin to the performance cores. Phones are big.LITTLE, so
// using every core (llama.cpp's default) drags the fast cores down to the pace
// of the little ones — 4 threads is the widely-tuned sweet spot for on-device
// llama.cpp and matches what whisper uses here.
const ANDROID_THREADS = 4;

// KV session snapshot used across suspend/resume. Lives in the cache dir — it
// is a pure speed optimization (skips re-prefilling the conversation), so the
// OS reclaiming it costs nothing but latency.
const SESSION_PATH = (
  (FileSystem.cacheDirectory ?? FileSystem.documentDirectory) + 'llama-session.bin'
).replace('file://', '');

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

/** GPU layers to request for this load. iOS always gets Metal. */
async function gpuLayersFor(): Promise<number> {
  if (Platform.OS === 'ios') return 99;
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
      // Note ctx_shift discards from the FRONT (llama.rn pins n_keep at 0), so
      // an overflow eats the system prompt — tool results are token-bounded in
      // the agent loop precisely so this stays a backstop and not a code path.
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
}

async function doUnload(): Promise<void> {
  await releaseAllLlama();
  context = null;
  loadedSpec = null;
  loadedFiles = null;
  suspendedSpec = null;
  suspendedFiles = null;
  sessionSaved = false;
  multimodalReady = false;
}

async function doSuspend(): Promise<void> {
  if (!context || !loadedSpec || !loadedFiles) return;
  const spec = loadedSpec;
  const files = loadedFiles;
  sessionSaved = false;
  // Snapshot the KV cache so resume skips re-prefilling the conversation.
  // Vision chats are excluded: image embeddings in the cache have no token
  // representation, so a restored session would not line up with the prompt —
  // those resume via a plain re-prefill instead (correct, just slower).
  if (!spec.vision) {
    try {
      await context.saveSession(SESSION_PATH, { tokenSize: -1 });
      sessionSaved = true;
    } catch {
      // best-effort — resume falls back to re-prefill
    }
  }
  await releaseAllLlama();
  context = null;
  loadedSpec = null;
  loadedFiles = null;
  suspendedSpec = spec;
  suspendedFiles = files;
  multimodalReady = false;
}

async function doResume(): Promise<void> {
  if (context || !suspendedSpec || !suspendedFiles) return;
  const spec = suspendedSpec;
  const files = suspendedFiles;
  const restoreSession = sessionSaved;
  suspendedSpec = null;
  suspendedFiles = null;
  sessionSaved = false;
  // Weights pages are usually still in the OS page cache, so this re-init is
  // far cheaper than the cold load.
  await doLoad(spec, files);
  if (restoreSession && context) {
    try {
      await (context as LlamaContext).loadSession(SESSION_PATH);
    } catch {
      // stale/corrupt session — the next completion re-prefills instead
    }
  }
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

  const result = await context.completion(
    {
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

export const LlamaEngine: Engine = {
  load(spec, files, onProgress) {
    return enqueue(() => doLoad(spec, files, onProgress));
  },

  generate(messages, onToken, opts) {
    // A real turn outranks speculative work: ask any in-flight prewarm to stop
    // at its next chunk boundary. Without this the user waits for the whole
    // prewarm first — measured on the test AVD as a 123s opening turn against
    // 58s with no prewarm at all, which is the opposite of the point.
    //
    // stopCompletion() is NOT enough on its own, and that is the whole reason
    // prewarm is chunked: it stops token GENERATION, and a prewarm is almost
    // entirely prompt EVALUATION, which llama.cpp will not abandon part-way.
    // Chunking is what bounds the wait to one chunk instead of the full warm.
    prewarmAbort = true;
    if (prewarming) void context?.stopCompletion();
    return enqueue(async () => {
      await doResume(); // transparent wake-up if the app was backgrounded
      return doGenerate(messages, onToken, opts);
    });
  },

  prewarm(messages) {
    prewarmAbort = false;
    return enqueue(async () => {
      if (!context) return; // nothing loaded (or unloaded while we queued)
      prewarming = true;
      try {
        // Warm in slices of the final message, each completion extending the
        // cached prefix the previous one left behind. One shot would be fewer
        // calls, but it would also be UNINTERRUPTIBLE: prompt evaluation runs
        // to completion inside llama.cpp, so a user who sends mid-warm would
        // wait out the entire remaining prefill. Chunking caps that wait at one
        // slice, which is the difference between a prewarm that helps and one
        // that makes the first message slower than having no prewarm at all.
        const last = messages[messages.length - 1];
        if (!last) return;
        const full = last.content;
        for (let end = PREWARM_CHUNK_CHARS; ; end += PREWARM_CHUNK_CHARS) {
          if (prewarmAbort) return; // a real turn is waiting — drop the rest
          const sliced = [
            ...messages.slice(0, -1),
            { ...last, content: full.slice(0, end) },
          ];
          // n_predict 0 — "evaluate the prompt, generate nothing". Not just a
          // tidier spelling of 1: with n_predict 1 the sampled token is pushed
          // into rn-llama's `embd` (rn-completion.cpp:621) but never decoded
          // into the KV cache, leaving embd one token LONGER than the cache is
          // deep. The next call derives its cache hit from
          // find_common_prefix_length(embd, ...) (rn-completion.cpp:142), so if
          // that stray token happens to equal the first divergent token of the
          // next prompt — very possible after a system prompt, where the greedy
          // pick is often the same ChatML marker the next turn opens with — the
          // hit lands one cell past what is actually cached and a token is
          // silently skipped. n_predict 0 returns at rn-completion.cpp:574,
          // BEFORE that push_back, so embd is exactly the prefix.
          //
          // Caveat for whoever benchmarks this: one contended run with 0
          // measured a cold prefill of 2722 tokens, WORSE than the 2333 with no
          // prewarm at all, against 597/672 on two runs with 1. Nothing in the
          // source explains that and the run was noisy (5 tok/s), so it is
          // recorded rather than acted on. Settle it with context.bench().
          await context.completion({
            messages: sliced as RNLlamaOAICompatibleMessage[],
            n_predict: 0,
            temperature: 0,
            ...(loadedSpec?.stop ? { stop: loadedSpec.stop } : {}),
          });
          if (end >= full.length) break;
        }
      } catch {
        // Best-effort: a warm cache is an optimization, never a requirement.
      } finally {
        prewarming = false;
      }
    });
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
