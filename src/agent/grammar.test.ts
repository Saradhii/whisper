import { describe, expect, it } from 'vitest';

import { buildToolGrammar, parseDecision } from './grammar';

describe('buildToolGrammar', () => {
  it('pins the tool name to an enum of the real tools', () => {
    const g = buildToolGrammar(['set_alarm', 'web_search']);
    expect(g).toContain('toolname    ::= "set_alarm" | "web_search"');
    expect(g).toContain('root        ::= toolcall | respond');
    // No PCRE shorthands that llama.rn's GBNF converter mishandles.
    expect(g).not.toMatch(/\\[dws]/);
  });
});

describe('parseDecision', () => {
  it('parses a tool call with arguments', () => {
    expect(parseDecision('{"tool": "set_alarm", "arguments": {"hour": 7, "minute": 0}}')).toEqual({
      kind: 'tool',
      name: 'set_alarm',
      arguments: { hour: 7, minute: 0 },
    });
  });

  it('parses a respond decision', () => {
    expect(parseDecision('{"respond": true}')).toEqual({ kind: 'respond' });
  });

  it('tolerates leading text before the JSON', () => {
    expect(parseDecision('  \n{"tool": "x", "arguments": {}}')).toEqual({
      kind: 'tool',
      name: 'x',
      arguments: {},
    });
  });

  it('defaults to respond on malformed or missing JSON', () => {
    expect(parseDecision('not json at all')).toEqual({ kind: 'respond' });
    expect(parseDecision('{"tool": 42}')).toEqual({ kind: 'respond' });
    expect(parseDecision('')).toEqual({ kind: 'respond' });
  });

  it('coerces a non-object arguments field to an empty object', () => {
    expect(parseDecision('{"tool": "x", "arguments": "oops"}')).toEqual({
      kind: 'tool',
      name: 'x',
      arguments: {},
    });
  });
});
