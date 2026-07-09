// llama.cpp engine via llama.rn. Handles any GGUF model, with optional vision
// through a mmproj file. Only one model is ever resident: load() releases the
// previous context before creating the next.
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

// Android CPU decode: pin to the performance cores. Phones are big.LITTLE, so
// using every core (llama.cpp's default) drags the fast cores down to the pace
// of the little ones — 4 threads is the widely-tuned sweet spot for on-device
// llama.cpp and matches what whisper uses here.
const ANDROID_THREADS = 4;

export const LlamaEngine: Engine = {
  async load(spec: ModelSpec, files: ModelFiles): Promise<void> {
    if (context && loadedSpec?.id === spec.id) return;
    await this.unload();

    const ctx = await initLlama({
      model: files.model,
      n_ctx: spec.nCtx,
      n_gpu_layers: Platform.OS === 'ios' ? 99 : 0, // Metal on iOS; CPU on Android
      ...(Platform.OS === 'android' ? { n_threads: ANDROID_THREADS } : {}),
      // Flash attention: fused attention kernel — less memory and faster on long
      // contexts. 'auto' lets llama.cpp turn it on where the build supports it.
      flash_attn_type: 'auto',
    });

    // Enable vision. Without this, image parts in messages are ignored.
    if (spec.vision && files.mmproj) {
      await ctx.initMultimodal({
        path: files.mmproj,
        use_gpu: Platform.OS === 'ios',
      });
    }

    context = ctx;
    loadedSpec = spec;
  },

  async generate(
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
        temperature: 0.7,
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
  },

  async stop(): Promise<void> {
    if (context) await context.stopCompletion();
  },

  async unload(): Promise<void> {
    await releaseAllLlama();
    context = null;
    loadedSpec = null;
  },
};
