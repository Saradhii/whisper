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
  nCtx: number;
  /** Extra stop strings for this model family (native EOS still applies). */
  stop?: string[];
  custom?: boolean;
};

export const GB = 1024 ** 3;

export const CATALOG: ModelSpec[] = [
  {
    id: 'gemma-4-e2b-q4km',
    name: 'Gemma 4 E2B · Q4_K_M',
    description: 'Recommended. Multimodal (text + vision). Comfortable on 8 GB phones.',
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
    nCtx: 2048,
    stop: ['<end_of_turn>', '<eos>'],
  },
  {
    id: 'qwen3-4b-instruct-q4km',
    name: 'Qwen3 4B Instruct',
    description:
      'Best answer quality per GB in its class, and the strongest at phone actions (tools). Recommended for the assistant.',
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
    nCtx: 4096,
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
    nCtx: 4096,
    stop: ['<|eot_id|>'],
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
    nCtx: 4096,
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
    nCtx: 4096,
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
      'Bigger sibling. llama.cpp keeps all 8B raw params in RAM, so this needs a 12 GB+ device.',
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
