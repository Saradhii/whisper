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
};

export type GenerateResult = { text: string; toolCalls: ToolCall[] };

/** Local absolute paths (no file:// prefix) of a downloaded model's files. */
export type ModelFiles = { model: string; mmproj?: string };

export interface Engine {
  /** Load `spec` from disk, replacing whatever model was loaded before. */
  load(spec: ModelSpec, files: ModelFiles): Promise<void>;
  /** Stream a completion for the chat history; resolves with text + tool calls. */
  generate(
    messages: AgentMessage[],
    onToken: (token: string) => void,
    opts?: GenerateOptions,
  ): Promise<GenerateResult>;
  /** Interrupt the in-flight generation. */
  stop(): Promise<void>;
  /** Free all native memory held by this engine. */
  unload(): Promise<void>;
}
