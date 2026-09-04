// The real planner, on the host. Loads the SAME GGUF the phone runs, renders
// prompts through the SAME chat template baked into that GGUF, and decodes under
// the SAME GBNF grammar the app builds.
//
// ============================ READ THIS FIRST ============================
// THIS HARNESS MEASURES ACCURACY ONLY. NEVER QUOTE A TIMING FROM IT.
//
// Accuracy transfers exactly: identical weights, identical grammar and identical
// prompt bytes produce the same decision distribution no matter which machine
// samples them. That is why a decision made here is evidence about the decision
// the phone will make.
//
// Latency does NOT transfer, not even approximately. This runs on an Apple M4
// Pro through Metal; the phone runs four little ARM cores through a CPU-only
// llama.cpp build with `no_extra_bufts` on. The two differ by more than an order
// of magnitude and they differ NON-UNIFORMLY — prefill and decode scale by
// different factors, which is precisely the ratio every latency decision on this
// project turns on. `totalMs` is reported so a run that has hung is visible, and
// for nothing else. Device timing belongs to the emulator agent.
// =========================================================================
//
// Nothing here is a dependency of the app. `node-llama-cpp` is resolved at
// runtime from a directory OUTSIDE the repo (see RUNNER_DIR) precisely so it
// never enters the app's dependency tree, never ships in an APK, and never has
// to be installed by CI or by an agent that only wants `npm run check`.
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Where the harness looks for its two large, un-committable inputs.
 *
 * Both are overridable so a second machine (or a second quantization) needs no
 * code change. Neither may ever live inside the repo: the model is 1.1 GB and
 * the runner unpacks a platform-specific native binary.
 */
export const MODEL_PATH =
  process.env.WHISPER_EVAL_MODEL ??
  path.join(os.homedir(), '.cache', 'whisper-eval', 'qwen3-1.7b-q4km.gguf');

export const RUNNER_DIR =
  process.env.WHISPER_EVAL_RUNNER ??
  path.join(os.homedir(), '.cache', 'whisper-eval', 'runner', 'node_modules');

/** Context window. Matches `nCtx` for qwen3-1.7b-q4km in `src/models/catalog.ts`
 *  — a host run with a roomier window would silently pass prompts the phone
 *  would have truncated. */
export const CONTEXT_SIZE = Number(process.env.WHISPER_EVAL_CTX ?? 4096);

/** Extra stop strings, mirroring `spec.stop` for this model in the catalog. */
const STOP = ['<|im_end|>'];

export type Availability =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Whether a real run is possible, with a reason a human can act on.
 *
 * Returned rather than thrown because the ONLY correct behaviour when the model
 * is absent is to skip loudly: this suite is not part of `npm run check`, and an
 * agent or a CI box that has never pulled a 1.1 GB GGUF must not see a red build
 * because of it.
 */
export function availability(): Availability {
  if (!fs.existsSync(MODEL_PATH)) {
    return {
      ok: false,
      reason:
        `model not found at ${MODEL_PATH}\n` +
        `  Pull it from the emulator:\n` +
        `    adb root && adb pull /data/data/com.whisper.app/files/models/qwen3-1.7b-q4km.gguf ${MODEL_PATH}\n` +
        `  or download the catalog URL (src/models/catalog.ts):\n` +
        `    https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf\n` +
        `  Override the location with WHISPER_EVAL_MODEL.`,
    };
  }
  if (!fs.existsSync(path.join(RUNNER_DIR, 'node-llama-cpp'))) {
    return {
      ok: false,
      reason:
        `node-llama-cpp not found under ${RUNNER_DIR}\n` +
        `  Install it OUTSIDE the repo (it must not enter the app's dependency tree):\n` +
        `    mkdir -p ~/.cache/whisper-eval/runner && cd ~/.cache/whisper-eval/runner\n` +
        `    npm init -y && npm pkg set type=module && npm i node-llama-cpp\n` +
        `  Override the location with WHISPER_EVAL_RUNNER.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Minimal structural types for the runtime-resolved runner
// ---------------------------------------------------------------------------
// Declared by hand rather than imported. Importing the real types would make
// `tsc --noEmit` — which every agent runs as part of `npm run check` — fail on
// any machine that has not installed the runner, which is exactly the coupling
// this file exists to avoid. Only the members actually called are described, so
// a signature drift surfaces here as a type error rather than at 3 a.m. in a
// score table.

type Grammar = { readonly __grammar?: never };

type CompletionOptions = {
  grammar?: Grammar;
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  customStopTriggers?: string[];
  onTextChunk?: (chunk: string) => void;
};

type Completion = {
  generateCompletion(prompt: string, options: CompletionOptions): Promise<string>;
};

type Runner = {
  getLlama(): Promise<{
    gpu: string | false;
    createGrammar(options: { grammar: string }): Promise<Grammar>;
    loadModel(options: { modelPath: string }): Promise<{
      createContext(options: { contextSize: number; sequences: number }): Promise<{
        getSequence(): object;
      }>;
      dispose(): Promise<void>;
    }>;
  }>;
  LlamaCompletion: new (options: { contextSequence: object }) => Completion;
  readGgufFileInfo(pathOrUrl: string): Promise<{
    metadata: { tokenizer?: { chat_template?: string } };
  }>;
};

type JinjaModule = {
  Template: new (source: string) => {
    render(context: Record<string, unknown>): string;
  };
};

// `@vite-ignore` is required: vitest runs this file through Vite, which would
// otherwise try to pre-bundle an absolute path outside the project root and
// fail on the native `.node` binary inside it.
const load = async <T>(specifier: string): Promise<T> =>
  (await import(/* @vite-ignore */ specifier)) as T;

// ---------------------------------------------------------------------------
// The loaded model
// ---------------------------------------------------------------------------

export type RealModel = {
  /** Which backend llama.cpp actually chose — reported so a run on a machine
   *  that silently fell back to CPU is distinguishable from one on Metal. */
  backend: string;
  /**
   * Render `messages` through the model's own chat template and decode.
   * `grammar` is GBNF exactly as `buildToolGrammar()` emits it.
   */
  complete(
    messages: { role: string; content: string }[],
    opts: {
      grammar?: string;
      maxTokens?: number;
      temperature?: number;
      seed?: number;
      disableThinking?: boolean;
      onToken?: (t: string) => void;
    },
  ): Promise<string>;
  dispose(): Promise<void>;
};

/**
 * Load the model once per process.
 *
 * The context and its single sequence are reused across every generation in the
 * run, which is not only faster but MORE faithful: llama.cpp reuses the KV
 * prefix between consecutive completions exactly as llama.rn does on device, so
 * the corpus exercises the same cache behaviour the app relies on.
 */
export async function loadRealModel(): Promise<RealModel> {
  const runner = await load<Runner>(path.join(RUNNER_DIR, 'node-llama-cpp'));
  const { Template } = await load<JinjaModule>(path.join(RUNNER_DIR, '@huggingface', 'jinja'));

  // The chat template comes out of the GGUF itself, never from a copy in this
  // repo. llama.rn applies that same embedded template on device, so reading it
  // from the file is the only way to be sure the host is not evaluating a prompt
  // the phone never sees. A hand-written ChatML renderer would drift the first
  // time the model is re-quantized.
  const info = await runner.readGgufFileInfo(MODEL_PATH);
  const source = info.metadata.tokenizer?.chat_template;
  if (!source) {
    throw new Error(
      `${MODEL_PATH} carries no tokenizer.chat_template. The app relies on the ` +
        `GGUF's embedded template, so a build without one cannot be evaluated ` +
        `faithfully here.`,
    );
  }
  const template = new Template(source);

  const llama = await runner.getLlama();
  const model = await llama.loadModel({ modelPath: MODEL_PATH });
  const context = await model.createContext({ contextSize: CONTEXT_SIZE, sequences: 1 });
  const completion = new runner.LlamaCompletion({ contextSequence: context.getSequence() });

  // Compiling a GBNF grammar is not free and the loop rebuilds the same two
  // grammars (with and without the `respond` alternative) for every single
  // planning turn in the corpus.
  const grammars = new Map<string, Grammar>();
  const grammarFor = async (gbnf: string): Promise<Grammar> => {
    const hit = grammars.get(gbnf);
    if (hit) return hit;
    const made = await llama.createGrammar({ grammar: gbnf });
    grammars.set(gbnf, made);
    return made;
  };

  return {
    backend: String(llama.gpu || 'cpu'),
    async complete(messages, opts) {
      const prompt = template.render({
        messages,
        add_generation_prompt: true,
        // Mirrors `chat_template_kwargs: { enable_thinking: false }` in
        // LlamaEngine.doGenerate(). For Qwen3 this appends a pre-closed
        // `<think>\n\n</think>` block, which is part of the prompt the model
        // sees — omitting it would evaluate a different prompt entirely.
        ...(opts.disableThinking ? { enable_thinking: false } : {}),
        bos_token: '',
        eos_token: '<|im_end|>',
      });
      const text = await completion.generateCompletion(prompt, {
        ...(opts.grammar ? { grammar: await grammarFor(opts.grammar) } : {}),
        maxTokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.7,
        ...(opts.seed === undefined ? {} : { seed: opts.seed }),
        customStopTriggers: STOP,
        ...(opts.onToken ? { onTextChunk: opts.onToken } : {}),
      });
      // LlamaEngine returns `result.text.trim()`; matching it here keeps the
      // parser and every `mustContain` assertion seeing the same string.
      return text.trim();
    },
    dispose: () => model.dispose(),
  };
}
