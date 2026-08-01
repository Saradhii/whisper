import { describe, expect, it } from 'vitest';

import { estimateTokens, trimToBudget, type CountedMessage } from './historyBudget';

const msg = (id: string, tokens: number): CountedMessage<string> => ({ message: id, tokens });

describe('trimToBudget', () => {
  it('keeps everything when under budget', () => {
    const counted = [msg('a', 10), msg('b', 20), msg('c', 30)];
    expect(trimToBudget(counted, 1000)).toEqual(['a', 'b', 'c']);
  });

  it('drops oldest messages first when over budget', () => {
    const counted = [msg('a', 400), msg('b', 400), msg('c', 400)];
    const kept = trimToBudget(counted, 900);
    expect(kept[kept.length - 1]).toBe('c');
    expect(kept).not.toContain('a');
  });

  it('trims below budget to a headroom target, not just barely under', () => {
    // 10 messages × ~108 tokens = ~1080; budget 1000 → target 750.
    const counted = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, 100));
    const kept = trimToBudget(counted, 1000);
    const keptTotal = kept.length * 108;
    expect(keptTotal).toBeLessThanOrEqual(750);
    // and it kept the NEWEST ones
    expect(kept[kept.length - 1]).toBe('m9');
  });

  it('always keeps the newest message even when it alone exceeds the budget', () => {
    const counted = [msg('old', 50), msg('huge', 5000)];
    expect(trimToBudget(counted, 100)).toEqual(['huge']);
  });

  it('handles an empty history', () => {
    expect(trimToBudget([], 100)).toEqual([]);
  });

  it('is stable (no trim) on repeated calls under budget — cache-friendly', () => {
    const counted = [msg('a', 100), msg('b', 100)];
    expect(trimToBudget(counted, 500)).toEqual(trimToBudget(counted, 500));
  });
});

describe('estimateTokens', () => {
  it('scales with text length and is never zero for non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hi')).toBeGreaterThan(0);
    expect(estimateTokens('a'.repeat(350))).toBe(100);
  });
});
