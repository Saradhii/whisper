import { describe, expect, it } from 'vitest';

import { splitThinking, stripSpecialTokens } from './thinking';

describe('splitThinking', () => {
  it('splits Gemma channel-style thinking (the screenshot case)', () => {
    const content = `<|channel|>thought\nThinking Process:\n1. **Analyze**...<|channel|>Hello! How can I help you today?`;
    expect(splitThinking(content)).toEqual({
      thinking: 'Thinking Process:\n1. **Analyze**...',
      answer: 'Hello! How can I help you today?',
    });
  });

  it('treats an unterminated channel block as still-thinking (streaming)', () => {
    expect(splitThinking('<|channel|>thought\nStill working on')).toEqual({
      thinking: 'Still working on',
      answer: '',
    });
  });

  it('handles explicit final channels and <think> tags', () => {
    expect(splitThinking('<|channel|>analysis\nhmm<|channel|>final\nThe answer is 4.')).toEqual({
      thinking: 'hmm',
      answer: 'The answer is 4.',
    });
    expect(splitThinking('<think>reasoning</think>\n**Bold** answer')).toEqual({
      thinking: 'reasoning',
      answer: '**Bold** answer',
    });
  });

  it('does not eat an answer starting with "Finally"', () => {
    expect(splitThinking('<|channel|>thought\nx<|channel|>Finally, we conclude 4.')).toEqual({
      thinking: 'x',
      answer: 'Finally, we conclude 4.',
    });
  });

  it('passes plain answers through, stripping stray special tokens', () => {
    expect(splitThinking('Just a **plain** answer, 2 < 3 and a<|eot|>stray token')).toEqual({
      thinking: null,
      answer: 'Just a **plain** answer, 2 < 3 and astray token',
    });
  });
});

describe('stripSpecialTokens', () => {
  it('removes <|…|> tokens but leaves math alone', () => {
    expect(stripSpecialTokens('a <|end|> b')).toBe('a  b');
    expect(stripSpecialTokens('2 < 3 || 4 > 1')).toBe('2 < 3 || 4 > 1');
  });
});
