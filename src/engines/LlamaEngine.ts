// llama.cpp engine via llama.rn. Handles any GGUF model, with optional vision
// through a mmproj file. Only one model is ever resident: load() releases the
// previous context before creating the next.
//
// All native access is serialized through a single promise queue: llama.rn's
// context is not reentrant, so a completion racing another completion (e.g. the
// uncensored canary vs. a user message) or a load racing a release corrupts
// native state. stop() is the one deliberate exception — it must interrupt the
// completion currently holding the queue.
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

// Set while suspended: the model to restore on the next generate()/resume().
let suspendedSpec: ModelSpec | null = null;
let suspendedFiles: ModelFiles | null = null;
let sessionSaved = false;

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

async function readGpuProbe(): Promise<GpuProbe> {
  if (gpuProbe === null) {
    const raw = await FileSystem.readAsStringAsync(GPU_PROBE_PATH).catch(() => null);
    gpuProbe = raw === 'probing' || raw === 'ok' || raw === 'failed' ? raw : 'untested';
  }
  return gpuProbe;
}

async function writeGpuProbe(value: GpuProbe): Promise<void> {
  gpuProbe = value;
  await FileSystem.writeAsStringAsync(GPU_PROBE_PATH, value).catch(() => {});
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
      // If a conversation outgrows n_ctx anyway, shift the cache window rather
      // than failing the completion (history is budgeted before we get here).
      ctx_shift: true,
      ...(Platform.OS === 'android'
        ? {
            n_threads: ANDROID_THREADS,
            // Quantize the K cache to 8-bit on memory-tight Android CPU runs:
            // ~half the key-cache RAM for negligible quality loss. Skipped when
            // layers are offloaded — the OpenCL path is safest with defaults.
            ...(gpuLayers === 0 ? { cache_type_k: 'q8_0' as const } : {}),
          }
        : {}),
      // Flash attention: fused attention kernel — less memory and faster on long
      // contexts. 'auto' lets llama.cpp turn it on where the build supports it.
      flash_attn_type: 'auto',
    },
    // llama.rn reports 1..100; normalize to 0..1 for the UI.
    onProgress ? (p) => onProgress(p / 100) : undefined,
  );

  // Enable vision. Without this, image parts in messages are ignored.
  if (spec.vision && files.mmproj) {
    await ctx.initMultimodal({
      path: files.mmproj,
      use_gpu: Platform.OS === 'ios',
    });
  }
  return ctx;
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

  return {
    text: result.text.trim(),
    toolCalls: normalizeToolCalls(result.tool_calls),
  };
}

export const LlamaEngine: Engine = {
  load(spec, files, onProgress) {
    return enqueue(() => doLoad(spec, files, onProgress));
  },

  generate(messages, onToken, opts) {
    return enqueue(async () => {
      await doResume(); // transparent wake-up if the app was backgrounded
      return doGenerate(messages, onToken, opts);
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
