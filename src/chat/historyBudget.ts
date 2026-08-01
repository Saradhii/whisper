// Context-window budgeting for chat history. Every turn re-sends the whole
// conversation; without a budget a long chat silently overflows the model's
// n_ctx (2048–4096 for the catalog models). Trimming interacts with speed:
// llama.cpp reuses the KV cache for the longest common PREFIX of consecutive
// prompts, so dropping from the front invalidates the entire cache and forces
// a full re-prefill. Therefore trims are made rare-but-large: when over
// budget, cut down to TRIM_TARGET of it, so many following turns keep a
// byte-stable prefix and prefill near-instantly.
//
// Pure module (counts injected) so it is unit-tested in Node.

export type CountedMessage<T> = { message: T; tokens: number };

/** Per-message chat-template overhead (role headers, turn separators). */
const MESSAGE_OVERHEAD = 8;

/** After a trim, aim for this fraction of the budget (headroom for growth). */
const TRIM_TARGET = 0.75;

/** Rough fallback when a real tokenizer count is unavailable. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Return the newest messages that fit `budget` tokens. The newest message is
 * always kept, even if it alone exceeds the budget (the engine's ctx_shift
 * backstop handles that pathological case).
 */
export function trimToBudget<T>(counted: CountedMessage<T>[], budget: number): T[] {
  const cost = (c: CountedMessage<T>) => c.tokens + MESSAGE_OVERHEAD;
  let total = counted.reduce((sum, c) => sum + cost(c), 0);
  if (total <= budget) return counted.map((c) => c.message);

  const target = Math.floor(budget * TRIM_TARGET);
  let start = 0;
  while (start < counted.length - 1 && total > target) {
    total -= cost(counted[start]!);
    start++;
  }
  return counted.slice(start).map((c) => c.message);
}
