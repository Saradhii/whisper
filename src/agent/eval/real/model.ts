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

/**
 * Hard ceiling on one generation, in ms.
 *
 * OBSERVED, not defensive: on this machine `generateCompletion()` intermittently
 * returns a promise that never settles. A stack sample of a wedged run showed
 * the main thread parked in `uv__io_poll` at ~1.7% CPU — not computing, just
 * waiting on a native completion that never came back. It reproduces perhaps
 * one full-corpus run in three, and only when the machine is also running an
 * emulator and a gradle build, so it smells like a Metal dispatch lost under
 * memory pressure rather than anything in this harness.
 *
 * Without a ceiling, one wedged generation costs the entire run and prints
 * nothing at all — the worst possible failure mode for a gate. With it, the
 * scenario throws, `scoreAll()` records it as a failed row (that is exactly what
 * its try/catch is for), and the other 70-odd scenarios still produce a table.
 * A run that hits this is visibly degraded rather than silently absent.
 *
 * A legitimate generation here is well under a second, and the slowest observed
 * (a full 256-token constrained plan on a contended machine) is a few seconds.
 * 45 s is therefore already far into pathological territory, and keeping it
 * tight matters: the wedge is STICKY — once a sequence stops answering, every
 * later generation on it does too — so a loose timeout turns one wedge into
 * `timeout x 70 scenarios` of dead waiting instead of a fast, legible failure.
 * `CONSECUTIVE_TIMEOUT_LIMIT` is the other half of that.
 */
const GENERATION_TIMEOUT_MS = Number(process.env.WHISPER_EVAL_GEN_TIMEOUT_MS ?? 45_000);

/**
 * Give up on the whole run after this many timeouts in a row.
 *
 * Because the wedge is sticky, a run that has hit it three times running is not
 * going to recover, and every further scenario is 45 s of nothing followed by a
 * failed row. Aborting turns a two-hour non-answer into a one-minute "the
 * runtime wedged, run it again" — and, critically, stops a wedged run from
 * writing a catastrophically low score that someone might mistake for a real
 * accuracy regression.
 */
const CONSECUTIVE_TIMEOUT_LIMIT = 3;

/**
 * Force the CPU backend with WHISPER_EVAL_GPU=false.
 *
 * Accuracy is identical either way — same weights, same grammar, same sampler —
 * so this costs nothing that this harness measures. It exists because the wedge
 * above has only ever been seen on Metal, and only when the machine was also
 * hosting an Android emulator and a gradle build.
 *
 * KNOW WHAT IT COSTS BEFORE YOU REACH FOR IT: node-llama-cpp ships a Metal
 * prebuild only, so asking for `gpu: false` makes it clone llama.cpp and BUILD
 * FROM SOURCE — a one-off ~10 minute compile (cached at
 * `<runner>/node-llama-cpp/llama/localBuilds/` for later runs) that needs Xcode
 * and a network connection. A run that appears to have hung right after
 * starting is usually this compile; check the log before killing it. Prefer
 * simply re-running on Metal, which is a 45-second experiment, and keep this
 * for a machine where the wedge is persistent.
 */
const USE_GPU = process.env.WHISPER_EVAL_GPU !== 'false';

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
  getLlama(options?: { gpu: false }): Promise<{
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

  const llama = await runner.getLlama(USE_GPU ? undefined : { gpu: false });
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

  // See CONSECUTIVE_TIMEOUT_LIMIT: the wedge is sticky, so the run is abandoned
  // rather than grinding through seventy more 45-second nothings.
  let consecutiveTimeouts = 0;

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
      if (consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT) {
        throw new Error(
          `abandoning the run: ${consecutiveTimeouts} generations in a row exceeded ` +
            `${GENERATION_TIMEOUT_MS} ms. The llama.cpp runtime has wedged and will not ` +
            `recover on this context. Re-run; if it recurs, use WHISPER_EVAL_GPU=false ` +
            `(same accuracy, CPU backend). NOTE: the score from this run is meaningless ` +
            `and must NOT be read as an accuracy regression.`,
        );
      }
      // Resolved BEFORE the try, and wrapped in its own timeout.
      //
      // This used to sit inline in the options object, where `await` ran during
      // ARGUMENT construction — i.e. before `withTimeout` had wrapped anything.
      // That left compiling a GBNF grammar as the one un-timed native call in
      // the hot path, and it is a prime suspect for the wedge: a run that hung
      // with the model loaded but no score table printed, while the
      // consecutive-timeout abort never fired, is exactly what an un-timed hang
      // here looks like. Grammars are cached, so this costs nothing after the
      // first two generations.
      const grammar = opts.grammar
        ? await withTimeout(grammarFor(opts.grammar), 'GBNF grammar compilation')
        : undefined;

      let text: string;
      try {
        text = await withTimeout(
          completion.generateCompletion(prompt, {
            ...(grammar ? { grammar } : {}),
            maxTokens: opts.maxTokens ?? 1024,
            temperature: opts.temperature ?? 0.7,
            ...(opts.seed === undefined ? {} : { seed: opts.seed }),
            customStopTriggers: STOP,
            ...(opts.onToken ? { onTextChunk: opts.onToken } : {}),
          }),
          `generation (${phaseLabel(opts)})`,
        );
      } catch (e) {
        // Only a TIMEOUT counts toward the wedge tally. A grammar error or an
        // over-long prompt is a real, per-scenario failure and must not trip the
        // abort — that would hide a genuine corpus problem behind a runtime one.
        if (e instanceof Error && e.message.startsWith('generation exceeded')) {
          consecutiveTimeouts++;
        }
        throw e;
      }
      consecutiveTimeouts = 0;
      // LlamaEngine returns `result.text.trim()`; matching it here keeps the
      // parser and every `mustContain` assertion seeing the same string.
      return text.trim();
    },
    dispose: () => model.dispose(),
  };
}

/**
 * Reject if the underlying completion never settles. See GENERATION_TIMEOUT_MS.
 *
 * Cleared on BOTH paths, which is the only part that needs care: a corpus is
 * ~200 generations, and a timer leaked per generation would keep the process
 * alive for two minutes after the table had already printed.
 */
/** Which half of a turn a stalled call belonged to, for the timeout message. */
const phaseLabel = (opts: { grammar?: string }) =>
  opts.grammar ? 'grammar-constrained planning' : 'unconstrained answer';

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `generation exceeded ${GENERATION_TIMEOUT_MS} ms and was abandoned — stalled in: ` +
            `${what}. This is the known node-llama-cpp wedge, not a slow prompt: the ` +
            `scenario is scored as a failure so the rest of the run survives, and three ` +
            `in a row abandon the run rather than writing a meaningless score.`,
        ),
      );
    }, GENERATION_TIMEOUT_MS);
  });
  return Promise.race([work, bomb]).finally(() => clearTimeout(timer));
}
