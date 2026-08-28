import { describe, expect, it } from 'vitest';

import { BREAK_AFTER, takeSentences } from './sentences';

describe('takeSentences', () => {
  it('splits on sentence terminators and keeps the tail buffered', () => {
    expect(takeSentences('One. Two! Three? Four')).toEqual({
      done: ['One.', ' Two!', ' Three?'],
      rest: ' Four',
    });
  });

  it('treats a newline as a terminator', () => {
    expect(takeSentences('a\nb.')).toEqual({ done: ['a\n', 'b.'], rest: '' });
  });

  it('keeps a run of terminators together', () => {
    expect(takeSentences('Wait...  Yes!!  No')).toEqual({
      done: ['Wait...', '  Yes!!'],
      rest: '  No',
    });
  });

  // BEHAVIOUR CHANGE, deliberate. The regex this replaced returned a single
  // 204-character chunk here: its lazy prefix tested the 160-char fallback at
  // offset 0 before it ever reached the '.' at offset 2, so the sentence break
  // was swallowed and the first audio of the reply was delayed. A terminator
  // must win over the length fallback.
  it('prefers an early terminator over the length fallback', () => {
    const { done, rest } = takeSentences(`Hi. ${'x'.repeat(200)} end`);
    expect(done[0]).toBe('Hi.');
    expect(rest).toBe('end');
  });

  it('breaks unterminated text at the first space past the threshold', () => {
    const { done, rest } = takeSentences(`${'y'.repeat(170)} tail`);
    expect(done).toHaveLength(1);
    expect(done[0]).toBe(`${'y'.repeat(170)} `);
    expect(done[0]!.length).toBeGreaterThan(BREAK_AFTER);
    expect(rest).toBe('tail');
  });

  it('buffers rather than breaking mid-word when there is nowhere to break', () => {
    const long = 'z'.repeat(300);
    expect(takeSentences(long)).toEqual({ done: [], rest: long });
  });

  it('handles the empty buffer', () => {
    expect(takeSentences('')).toEqual({ done: [], rest: '' });
  });

  // Streaming feeds one token at a time; the result must not depend on how the
  // text was chopped up on the way in.
  it('gives the same sentences however the text is chunked', () => {
    const text = 'First one. Second one! A third; still going? Trailing bit';
    let buffer = '';
    const spoken: string[] = [];
    for (const ch of text) {
      buffer += ch;
      const { done, rest } = takeSentences(buffer);
      spoken.push(...done);
      buffer = rest;
    }
    const atOnce = takeSentences(text);
    expect(spoken).toEqual(atOnce.done);
    expect(buffer).toEqual(atOnce.rest);
  });

  // The old regex was quadratic: 161 ms at 16 KB with no terminator, and this
  // runs on the JS thread that is also feeding audio.
  it('stays linear on a large unterminated buffer', () => {
    const started = Date.now();
    expect(takeSentences('q'.repeat(400_000)).done).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
