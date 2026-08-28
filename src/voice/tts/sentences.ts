// Sentence splitting for the speech queue. Pure, and deliberately outside
// TtsService.ts: that file imports expo-audio, so vitest cannot load it, and
// this logic — a string in, strings out — had no business inheriting that.
// It went untested for exactly that reason, and carried two defects.

/** Speak an unterminated run once it passes this many characters, so a model
 *  that forgets punctuation still produces audio. */
export const BREAK_AFTER = 160;

const TERMINATORS = '.!?\n';

/**
 * Where the first speakable chunk of `s` ends, or -1 to keep buffering.
 *
 * Replaces `/^[\s\S]*?(?:[.!?\n]+|.{160,}?\s)/`, which had two problems.
 *
 * SLOW: the lazy prefix could exchange characters with `.{160,}?`, giving
 * polynomial backtracking — measured quadratic, 161 ms on a 16 KB buffer with
 * no terminator.
 *
 * WRONG, and the reason this is not a pure refactor: a lazy prefix tries the
 * SHORTEST prefix first, so at k=0 the 160-character alternative was tested
 * before the engine ever advanced to a terminator sitting at k=2. Given
 * `"Hi. " + "x".repeat(200) + " end"` the old splitter returned ONE 204-char
 * chunk and swallowed the break after "Hi.". Token-by-token streaming mostly
 * hid it, because the buffer is re-tested before it can grow past 160 — but
 * `loop.ts` emits a whole reply as a single token on the grammar and salvage
 * fallbacks, and those hit it squarely, delaying the first audio of the reply.
 *
 * A terminator now always wins over the length fallback, which is what the
 * original comment said the function was for.
 */
function firstBreak(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (TERMINATORS.includes(s[i] as string)) {
      let end = i + 1;
      while (end < s.length && TERMINATORS.includes(s[end] as string)) end++;
      return end; // the whole run: "Wait..." is one chunk, not three
    }
  }
  for (let i = from + BREAK_AFTER; i < s.length; i++) {
    if (/\s/.test(s[i] as string)) return i + 1; // the space belongs to the chunk
  }
  return -1;
}

/**
 * Pull complete sentences out of a running buffer. Anything after the last
 * terminator stays buffered until more text arrives (or end()).
 *
 * Walks an index instead of re-slicing, so N chunks cost O(len), not O(len·N).
 */
export function takeSentences(buf: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let at = 0;
  for (;;) {
    const end = firstBreak(buf, at);
    if (end < 0) break;
    done.push(buf.slice(at, end));
    at = end;
  }
  return { done, rest: buf.slice(at) };
}
