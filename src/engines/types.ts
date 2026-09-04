// Engine abstraction: one interface, one implementation per inference runtime.
// Today only llama.cpp (via llama.rn); a LiteRT-LM engine slots in later for
// .litertlm Gemma builds without touching the UI.
import type { ModelSpec } from '@/src/models/catalog';
import type { CleanToolCall } from './toolcalls';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

/**
 * Full OpenAI-style message for agent loops: adds the `tool` role, assistant
 * `tool_calls`, and the `tool_call_id` linking a result to its call.
 */
export type AgentMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
};

/** A tool invocation parsed out of a completion (normalized, never nullable). */
export type ToolCall = CleanToolCall;

export type GenerateOptions = {
  /** Attach an image (local URI) to the latest user turn (vision models). */
  imageUri?: string;
  /** OpenAI-style tool declarations; enables tool-call parsing. */
  tools?: unknown[];
  /** Disable model "thinking" (Qwen3 etc.) — more direct, faster, and more
   *  reliable tool-calling for small models. Ignored by models without it. */
  disableThinking?: boolean;
  /** GBNF grammar to constrain output (forces valid tool-call/decision JSON). */
  grammar?: string;
  /** Cap on generated tokens. Short for spoken/planning turns (faster, avoids
   *  runaway); defaults to a roomy 1024 for full chat answers. */
  maxTokens?: number;
  /** Sampling temperature; defaults to 0.7. */
  temperature?: number;
};

/**
 * llama.cpp's own accounting for one completion, surfaced so latency can be
 * attributed instead of guessed. The decisive field is `cached`: a turn that
 * feels slow because it re-prefills a prompt it should have reused looks
 * identical from the outside to one that is simply generating a lot.
 */
export type GenerateTimings = {
  /** Prompt tokens reused from the KV cache (not re-evaluated). */
  cached: number;
  /** Prompt tokens actually evaluated this call, and what that cost. */
  promptTokens: number;
  promptMs: number;
  /** Tokens generated, and what that cost. */
  predictedTokens: number;
  predictedMs: number;
};

export type GenerateResult = {
  text: string;
  toolCalls: ToolCall[];
  timings?: GenerateTimings;
};

/** Local absolute paths (no file:// prefix) of a downloaded model's files. */
export type ModelFiles = { model: string; mmproj?: string };

export interface Engine {
  /** Load `spec` from disk, replacing whatever model was loaded before.
   *  `onProgress` reports 0..1 while the weights load. */
  load(
    spec: ModelSpec,
    files: ModelFiles,
    onProgress?: (progress: number) => void,
  ): Promise<void>;
  /** Stream a completion for the chat history; resolves with text + tool calls. */
  generate(
    messages: AgentMessage[],
    onToken: (token: string) => void,
    opts?: GenerateOptions,
  ): Promise<GenerateResult>;
  /**
   * Evaluate `messages` into the KV cache and throw the output away, so the
   * next real turn reuses the prefix instead of building it.
   *
   * This exists because the agent's cost is almost entirely PREFILL, and the
   * whole of it used to land on the user's first message: measured on the test
   * AVD, turn one evaluated 2333 prompt tokens at 63 tok/s — 37.2 of the 41.2
   * second turn — to emit a five-token decision. The ~1736-token system
   * message (tool catalog + worked examples) is known the moment the model
   * loads, so there is no reason for a person to wait for it.
   *
   * Best-effort by contract: a failure here must never surface to the user or
   * block a turn, because nothing is wrong if it doesn't run — the next
   * generate() simply pays what it pays today.
   */
  prewarm?(messages: AgentMessage[]): Promise<void>;
  /** Count tokens with the loaded model's tokenizer (for context budgeting). */
  countTokens?(text: string): Promise<number>;
  /** Interrupt the in-flight generation. */
  stop(): Promise<void>;
  /**
   * Release native memory (KV cache, compute buffers, weight mappings) while
   * remembering the model — and, where supported, its KV session on disk — so
   * the next generate()/resume() restores it far faster than a cold load.
   * Called when the app backgrounds so a multi-GB resident footprint doesn't
   * make the process the OS's first low-memory kill target.
   * `shouldProceed` is re-checked at execution time (the call may sit behind an
   * in-flight generation in the queue) so a suspend requested while
   * backgrounded is skipped if the user has since returned.
   */
  suspend?(shouldProceed?: () => boolean): Promise<void>;
  /** Undo suspend(): reload weights (warm mmap) and restore the KV session. */
  resume?(): Promise<void>;
  /** Free all native memory held by this engine. */
  unload(): Promise<void>;
}
