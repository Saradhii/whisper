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

export type GenerateResult = { text: string; toolCalls: ToolCall[] };

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
