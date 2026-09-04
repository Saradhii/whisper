// Built-in model catalog. Each entry maps a model to the engine that runs it
// plus everything the download manager needs. Users can extend this at runtime
// with custom GGUF URLs from the models screen.

export type EngineKind = 'llama'; // 'litert' arrives with the LiteRT-LM engine

export type ModelFileSpec = {
  key: 'model' | 'mmproj';
  url: string;
  filename: string; // on-disk name under the models/ directory
};

export type ModelSpec = {
  id: string;
  name: string;
  description: string;
  engine: EngineKind;
  files: ModelFileSpec[];
  /** Rough total download size for the catalog UI. 0 = unknown (custom models). */
  sizeBytes: number;
  /** Minimum device RAM to run without risking an OS kill. 0 = unknown. */
  minRamBytes: number;
  vision: boolean;
  /** Model is reliable at tool calling → chat runs through the agent loop. */
  tools?: boolean;
  /** Abliterated/unfiltered model → app runs a canary self-test after download. */
  uncensored?: boolean;
  /** Highlighted as a recommended pick within its size group. */
  suggested?: boolean;
  nCtx: number;
  /** Extra stop strings for this model family (native EOS still applies). */
  stop?: string[];
  custom?: boolean;
};

export const GB = 1024 ** 3;

// Order is the order of the models screen, and the first card in the
// open-by-default group is what a new user reads first. That slot has to belong
// to a `tools: true` model: the onboarding screen promises "set alarms and
// reminders, check your calendar", and only the agent loop delivers that —
// app/index.tsx routes chat through runAgent ONLY when the active spec declares
// tools. Gemma led this list for months with the word "Recommended.", so the
// likely first-run path handed the user a model that answers "Done, alarm set
// for 7am" without an alarm existing: no agent loop means no tool call, and
// nothing in the plain chat path can stop a narrated action.
export const CATALOG: ModelSpec[] = [
  {
    id: 'qwen3-4b-instruct-q4km',
    name: 'Qwen3 4B Instruct',
    description:
      'Recommended. Best answer quality per GB in its class, and the strongest at phone actions — alarms, reminders, calendar, web search.',
    engine: 'llama',
    files: [
      {
        key: 'model',
        url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        filename: 'qwen3-4b-instruct-q4km.gguf',
      },
    ],
    sizeBytes: 2381 * 1024 ** 2,
    minRamBytes: 6 * GB,
    vision: false,
    tools: true,
    suggested: true,
    // 8192, not 4096. An honest derived TOOL_PROMPT_RESERVE leaves only ~896
    // tokens of history at 4096 — about four turns — against the 1024 minimum
    // catalog.test.ts asserts a tools model needs. Trimming the prefix is
    // exhausted: the system message cannot go below ~1900 tokens without
    // deleting worked examples, which are this codebase's strongest lever on a
    // small model. The window is the only remaining way to give the
    // conversation room.
    //
    // Cost, measured on device (Qwen3-1.7B, q8_0 K and V, flash attention on):
    // VmRSS 1912 -> 2147 MB, RssAnon 655 -> 889 MB, and prefill throughput did
    // not regress. The whole +235 MB lands in ANONYMOUS memory, which is what
    // Android's low-memory killer weighs. KV scales with layer count, so a 4B
    // costs proportionally more — expect ~300 MB here — which is why this is
    // applied only to the 6 GB models. See docs/perf/prefill-campaign.md.
    nCtx: 8192,
    stop: ['<|im_end|>'],
  },
  {
    id: 'llama-3.2-3b-q4km',
    name: 'Llama 3.2 3B Instruct',
    description: "Meta's compact chat model. Fast, friendly, and reliable for everyday questions.",
    engine: 'llama',
    files: [
      {
        key: 'model',
        url: 'https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
        filename: 'llama-3.2-3b-q4km.gguf',
      },
    ],
    sizeBytes: 1925 * 1024 ** 2,
    minRamBytes: 6 * GB,
    vision: false,
    tools: true,
    suggested: true,
    // 8192 for the same reason as Qwen3 4B above — see that comment.
    nCtx: 8192,
    stop: ['<|eot_id|>'],
  },
  {
    id: 'gemma-4-e2b-q4km',
    name: 'Gemma 4 E2B · Q4_K_M',
    // Still suggested — it is the only model here that can see an image — but
    // the description has to carry the trade. Its 2048-token window cannot hold
    // the agent prompt (the 18-tool system message alone is ~1825 tokens, and
    // TOOL_PROMPT_RESERVE is 3200), so it will never get
    // `tools: true`; a user who picks it must know before the 3.4 GB download
    // that this is the model that talks about actions instead of taking them.
    description:
      'Sees images — point the camera at something and ask. Chat and vision only: it cannot set alarms, check your calendar, or take any other action on the phone. Comfortable on 8 GB phones.',
    engine: 'llama',
    files: [
      {
        key: 'model',
        url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf',
        filename: 'gemma-4-e2b-q4km.gguf',
      },
      {
        key: 'mmproj',
        url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/mmproj-F16.gguf',
        filename: 'gemma-4-e2b-mmproj-f16.gguf',
      },
    ],
    sizeBytes: 3.4 * GB,
    minRamBytes: 6 * GB,
    vision: true,
    suggested: true,
    nCtx: 2048,
    stop: ['<end_of_turn>', '<eos>'],
  },
  {
    id: 'phi-4-mini-q4km',
    name: 'Phi-4 Mini Instruct',
    description: "Microsoft's small model, strong at math, logic, and structured answers.",
    engine: 'llama',
    files: [
      {
        key: 'model',
        url: 'https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/resolve/main/Phi-4-mini-instruct-Q4_K_M.gguf',
        filename: 'phi-4-mini-q4km.gguf',
      },
    ],
    sizeBytes: 2376 * 1024 ** 2,
    minRamBytes: 6 * GB,
    vision: false,
    tools: true,
    // 8192 for the same reason as Qwen3 4B above — see that comment.
    nCtx: 8192,
    stop: ['<|end|>'],
  },
  {
    id: 'smollm3-3b-q4km',
    name: 'SmolLM3 3B',
    description: 'Popular fully-open model with step-by-step reasoning. Good balance of speed and smarts.',
    engine: 'llama',
    files: [
      {
        key: 'model',
        url: 'https://huggingface.co/unsloth/SmolLM3-3B-GGUF/resolve/main/SmolLM3-3B-Q4_K_M.gguf',
        filename: 'smollm3-3b-q4km.gguf',
      },
    ],
    sizeBytes: 1826 * 1024 ** 2,
    minRamBytes: 6 * GB,
    vision: false,
    tools: true,
    // 8192 for the same reason as Qwen3 4B above — see that comment.
    nCtx: 8192,
    stop: ['<|im_end|>'],
  },
  {
    id: 'qwen3-1.7b-q4km',
    name: 'Qwen3 1.7B',
    description: 'Smallest and fastest. Shows its reasoning while it thinks. Ideal for older phones.',
    engine: 'llama',
    files: [
      {
        key: 'model',
        url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
        filename: 'qwen3-1.7b-q4km.gguf',
      },
    ],
    sizeBytes: 1056 * 1024 ** 2,
    minRamBytes: 4 * GB,
    vision: false,
    tools: true,
    // Stays at 4096 while the 6 GB models move to 8192, and that is deliberate.
    // The larger window costs a measured +235 MB of ANONYMOUS memory — the
    // memory Android's low-memory killer weighs — taking this model from 1912
    // to 2147 MB resident. On the 4 GB devices this entry exists to serve, that
    // is over half the phone, and being killed mid-answer is worse for the user
    // than a shorter memory. So this model keeps ~896 tokens of history, stays
    // in NCTX_EXEMPT in catalog.test.ts, and the exemption list is now what it
    // should be: the genuinely constrained cases, not every model we ship.
    nCtx: 4096,
    stop: ['<|im_end|>'],
  },
  {
    id: 'qwen3-1.7b-abliterated-q4km',
    name: 'Qwen3 1.7B · Uncensored',
    description:
      'Abliterated (refusal-removed) build by the technique’s author, documented >90% compliance. The app verifies it after download. You are responsible for how you use it.',
    engine: 'llama',
    files: [
      {
        key: 'model',
        url: 'https://huggingface.co/bartowski/mlabonne_Qwen3-1.7B-abliterated-GGUF/resolve/main/mlabonne_Qwen3-1.7B-abliterated-Q4_K_M.gguf',
        filename: 'qwen3-1.7b-abliterated-q4km.gguf',
      },
    ],
    sizeBytes: 1056 * 1024 ** 2,
    minRamBytes: 4 * GB,
    vision: false,
    tools: true,
    uncensored: true,
    nCtx: 4096,
    stop: ['<|im_end|>'],
  },
  {
    id: 'gemma-4-e4b-q4km',
    name: 'Gemma 4 E4B · Q4_K_M',
    description:
      'Bigger sibling, and the same chat-and-vision limits as E2B: no phone actions. llama.cpp keeps all 8B raw params in RAM, so this needs a 12 GB+ device.',
    engine: 'llama',
    files: [
      {
        key: 'model',
        url: 'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf',
        filename: 'gemma-4-e4b-q4km.gguf',
      },
      {
        key: 'mmproj',
        url: 'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/mmproj-F16.gguf',
        filename: 'gemma-4-e4b-mmproj-f16.gguf',
      },
    ],
    sizeBytes: 6.0 * GB,
    minRamBytes: 12 * GB,
    vision: true,
    nCtx: 2048,
    stop: ['<end_of_turn>', '<eos>'],
  },
];

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '?';
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export type SizeTier = 'mini' | 'medium' | 'large';

/** Bucket a model by download size. Unknown (custom, 0) falls into Mini. */
export function sizeTier(bytes: number): SizeTier {
  if (bytes >= 6 * GB) return 'large';
  if (bytes >= 2 * GB) return 'medium';
  return 'mini';
}

export const TIER_ORDER: SizeTier[] = ['mini', 'medium', 'large'];

export const TIER_LABEL: Record<SizeTier, string> = {
  mini: 'Mini',
  medium: 'Medium',
  large: 'Large',
};

export const TIER_HINT: Record<SizeTier, string> = {
  mini: 'under 2 GB',
  medium: '2–6 GB',
  large: '6 GB and up',
};
