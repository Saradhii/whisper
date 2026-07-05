// Split a (possibly still-streaming) assistant message into hidden reasoning
// and the user-facing answer. Small local models emit thinking in several
// ad-hoc formats; normalize the common ones:
//   <think>…</think> answer                        (Qwen, DeepSeek-R1 style)
//   <|channel|>thought …<|channel|>answer           (Gemma 4 edge GGUFs)
//   <|channel|>analysis …<|channel|>final answer    (Harmony style)

export type SplitMessage = {
  /** Reasoning text, or null if this message has no thinking section. */
  thinking: string | null;
  /** User-facing answer; empty while the model is still thinking. */
  answer: string;
};

const PATTERNS: { open: RegExp; close: RegExp }[] = [
  { open: /^\s*<think>/, close: /<\/think>/ },
  {
    open: /^\s*<\|channel\|>\s*(?:thought|thinking|analysis)\b:?\s*/i,
    close: /<\|channel\|>\s*(?:(?:final|response)\b)?:?\s*/i,
  },
];

export function splitThinking(content: string): SplitMessage {
  for (const { open, close } of PATTERNS) {
    const openMatch = content.match(open);
    if (!openMatch) continue;
    const rest = content.slice(openMatch[0].length);
    const closeMatch = rest.match(close);
    if (!closeMatch || closeMatch.index === undefined) {
      return { thinking: stripSpecialTokens(rest), answer: '' }; // still thinking
    }
    return {
      thinking: stripSpecialTokens(rest.slice(0, closeMatch.index)),
      answer: stripSpecialTokens(rest.slice(closeMatch.index + closeMatch[0].length)),
    };
  }
  return { thinking: null, answer: stripSpecialTokens(content) };
}

/** Remove stray special tokens (<|…|>) the chat template didn't consume. */
export function stripSpecialTokens(text: string): string {
  return text.replace(/<\|[^|<>]{0,32}\|>/g, '').trim();
}
