// Prompt size and KV-cache divergence, measured in Node.
//
// WHY THIS EXISTS
// This app's latency is PREFILL, not decode. Measured on the test AVD (Qwen3
// 1.7B Q4_K_M) prefill runs at 65-73 tok/s and decode at a healthy 16-17 tok/s,
// so every second the user waits is a prompt token being evaluated. llama.rn
// reuses the KV cache for the longest common PREFIX of two consecutive prompts
// and re-evaluates everything after the first token that differs. The cost of a
// turn is therefore the size of the volatile tail that sits after the cached
// prefix, paid once per generation — and a turn runs two to five generations.
//
// That number was invisible until now: it lives in `adb logcat` as
// `n_past`/`num_prompt_tokens` on a device somebody has to be holding. This
// module makes it a unit-testable property of the prompt itself, so a layout
// change that reintroduces the thrash fails in CI instead of on a phone.
//
// WHY CHARACTERS ARE THE EXACT FIGURE AND TOKENS ARE AN ESTIMATE
// There is no Qwen3 tokenizer in Node. Characters are exact and deterministic
// and are what every assertion here is written against; tokens are derived and
// are always labelled "est". The divisor is calibrated from this project's own
// device data, not guessed:
//
//   * the prewarm's first 1500-char slice measured 393 prompt tokens on device
//     (RNLlama loadPrompt) -> 3.82 chars/token including the template wrapper;
//   * the whole 6665-char system prompt measured 1804 -> 3.70 chars/token.
//
// 3.85 sits at the low end of that band, so token figures here under-state
// rather than over-state a saving. A ±4% error on an estimate does not change
// any conclusion a 4x structural difference supports.
import type { AgentMessage } from '@/src/engines/types';

/** Calibrated above. Deliberately at the conservative end of the measured band. */
export const CHARS_PER_TOKEN = 3.85;

/**
 * Per-message chat-template overhead, in characters.
 *
 * `<|im_start|>role\n … <|im_end|>\n` is what llama.rn's template wraps every
 * message in, and it is not free: the prewarm ladder re-evaluated ~6 tokens at
 * each of its four slice boundaries for exactly this. Modelling it here keeps
 * a divergence measured in Node aligned with a message boundary on device — a
 * prompt that appends one message must cost that message PLUS its wrapper.
 */
export const MESSAGE_TEMPLATE_CHARS = 23;

/** Estimated Qwen3 tokens for a character count. Always report as "estimated". */
export function estTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/**
 * The prompt as llama.rn's chat template lays it out, near enough for prefix
 * arithmetic: one flat string, message boundaries included.
 *
 * The template wrapper matters to the shape of the answer, not just its size.
 * Two prompts that share the first N messages share this string's first N
 * blocks EXACTLY, so a divergence found here falls on the same message boundary
 * it would fall on inside llama.cpp. Comparing bare concatenated content would
 * let a role change slip past unnoticed.
 */
export function renderForCache(messages: AgentMessage[]): string {
  return messages.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('');
}

export type PromptSize = {
  messages: number;
  chars: number;
  /** Estimated — see CHARS_PER_TOKEN. */
  estTokens: number;
};

export function promptSize(messages: AgentMessage[]): PromptSize {
  const chars = renderForCache(messages).length;
  return { messages: messages.length, chars, estTokens: estTokens(chars) };
}

export type Divergence = {
  /** Characters `next` shares with `prev` — what llama.cpp serves from cache. */
  sharedChars: number;
  /** Whole leading messages the two prompts have in common. */
  sharedMessages: number;
  /** Characters of `next` at or after the first difference — the re-prefill. */
  reEvaluatedChars: number;
  /** Estimated — see CHARS_PER_TOKEN. */
  reEvaluatedTokens: number;
  /**
   * True when `next` is a strict extension of `prev`: nothing before the
   * divergence changed AND the divergence is at the very end of `prev`. This is
   * the append-only property the whole layout exists to hold.
   */
  appendOnly: boolean;
};

/**
 * What a generation on `next` must re-evaluate, given that `prev` is what the
 * KV cache is currently holding.
 *
 * This is the same arithmetic llama.rn logs as `num_prompt_tokens - n_past`,
 * in characters instead of tokens.
 */
export function divergence(prev: AgentMessage[], next: AgentMessage[]): Divergence {
  const a = renderForCache(prev);
  const b = renderForCache(next);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const reEvaluatedChars = b.length - i;

  // Whole messages in common, counted by re-rendering prefixes: cheaper to read
  // than to reason about offsets, and the lists are a dozen messages long.
  let sharedMessages = 0;
  for (let n = 1; n <= Math.min(prev.length, next.length); n++) {
    if (renderForCache(next.slice(0, n)).length > i) break;
    if (renderForCache(prev.slice(0, n)) !== renderForCache(next.slice(0, n))) break;
    sharedMessages = n;
  }

  return {
    sharedChars: i,
    sharedMessages,
    reEvaluatedChars,
    reEvaluatedTokens: estTokens(reEvaluatedChars),
    appendOnly: i === a.length && b.length >= a.length,
  };
}

/** "1234 chars (~320 est tokens)" — the only sanctioned way to print a size. */
export function formatSize(chars: number): string {
  return `${chars} chars (~${estTokens(chars)} est tokens)`;
}
