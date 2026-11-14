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
 * Index of the first message to send, given where the previous turn started.
 *
 * The trim is STICKY: a conversation that was cut once stays over budget when
 * measured from message 0 forever after, so a stateless trim re-cuts it on
 * every following turn — each time from a slightly later message, each time
 * invalidating the whole KV prefix. Measuring from `prevStart` instead means a
 * cut happens once and the following turns extend a byte-stable prompt until
 * the window genuinely fills again.
 *
 * The newest message is always kept, even if it alone exceeds the budget (the
 * engine's ctx_shift backstop handles that pathological case).
 */
export function trimStart<T>(
  counted: CountedMessage<T>[],
  budget: number,
  prevStart = 0,
): number {
  const cost = (c: CountedMessage<T>) => c.tokens + MESSAGE_OVERHEAD;
  let start = Math.min(Math.max(prevStart, 0), Math.max(counted.length - 1, 0));
  let total = 0;
  for (let i = start; i < counted.length; i++) total += cost(counted[i]!);
  if (total <= budget) return start;

  const target = Math.floor(budget * TRIM_TARGET);
  while (start < counted.length - 1 && total > target) {
    total -= cost(counted[start]!);
    start++;
  }
  return start;
}

/** Stateless form: the newest messages that fit `budget` tokens. */
export function trimToBudget<T>(counted: CountedMessage<T>[], budget: number): T[] {
  return counted.slice(trimStart(counted, budget)).map((c) => c.message);
}
