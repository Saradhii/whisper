import { describe, expect, it } from 'vitest';

import { buildToolGrammar, parseDecision } from './grammar';

describe('buildToolGrammar', () => {
  it('pins the tool name to an enum of the real tools', () => {
    const g = buildToolGrammar(['set_alarm', 'web_search']);
    // Each alternative is a GBNF literal for a QUOTED name — see the regression
    // test below. This assertion previously omitted the escaped quotes, which
    // is how the broken grammar shipped: the test pinned the bug in place.
    expect(g).toContain('toolname    ::= "\\"set_alarm\\"" | "\\"web_search\\""');
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

  it('constrains the tool name to a QUOTED json string', () => {
    // Regression: GBNF quotes delimit a literal rather than being part of it,
    // so `toolname ::= "set_alarm"` emitted a bare identifier and every
    // decision came out as {"tool":  set_alarm, ...} — not JSON. Verified
    // against a real Qwen3 1.7B run, which produced exactly that.
    const g = buildToolGrammar(['set_alarm', 'web_search']);
    expect(g).toContain('toolname    ::= "\\"set_alarm\\"" | "\\"web_search\\""');
  });

  it('produces decisions that survive a JSON round trip', () => {
    // Ties the grammar to the parser: whatever the grammar permits for the
    // name must be readable by parseDecision.
    const g = buildToolGrammar(['set_alarm']);
    const literal = g.split('\n').find((l) => l.startsWith('toolname'))!.split('::=')[1]!.trim();
    // Unescape the GBNF literal to the text the sampler is allowed to emit.
    const emitted = literal.slice(1, -1).replace(/\\"/g, '"');
    expect(emitted).toBe('"set_alarm"');
    expect(parseDecision(`{"tool": ${emitted}, "arguments": {"hour": 7}}`)).toEqual({
      kind: 'tool',
      name: 'set_alarm',
      arguments: { hour: 7 },
    });
  });

  it('escapes the respond rule exactly like the toolcall rule', () => {
    // This rule is assembled outside the template literal, so it is one stray
    // backslash away from requiring a literal \ before every quote — which
    // would make {"respond": true} unemittable and force a tool call on every
    // single turn. Both rules must quote JSON keys the same way.
    const g = buildToolGrammar(['a']);
    expect(g).toContain('respond     ::= "{" ws "\\"respond\\"" ws ":" ws "true" ws "}"');
    // Compare the two rules directly rather than scanning the whole grammar —
    // the `char` rule contains a legitimate \\" escape.
    const keyQuoting = (rule: string) =>
      g.split('\n').find((l) => l.startsWith(rule))?.match(/"\\+"/)?.[0];
    expect(keyQuoting('respond')).toBe(keyQuoting('toolcall'));
  });

  it('omits the respond rule entirely when tool use is forced', () => {
    // llama.cpp rejects a grammar declaring a rule nothing references.
    const forced = buildToolGrammar(['a'], { allowRespond: false });
    expect(forced).toContain('root        ::= toolcall');
    expect(forced).not.toContain('respond');
  });

  it('defaults to respond on malformed or missing JSON, and flags it', () => {
    // `malformed` is what separates "the model chose to answer" from "the
    // grammar isn't holding" — the loop traces the second as an error.
    expect(parseDecision('not json at all')).toEqual({ kind: 'respond', malformed: true });
    expect(parseDecision('{"tool": 42}')).toEqual({ kind: 'respond', malformed: true });
    expect(parseDecision('')).toEqual({ kind: 'respond', malformed: true });
  });

  it('treats a clean respond decision as deliberate, not malformed', () => {
    expect(parseDecision('{"respond": true}')).toEqual({ kind: 'respond' });
  });

  it('reads a decision even when the model trails prose after it', () => {
    expect(parseDecision('{"tool": "x", "arguments": {}} — done!')).toEqual({
      kind: 'tool',
      name: 'x',
      arguments: {},
    });
  });

  it('is not fooled by braces inside string arguments', () => {
    expect(parseDecision('{"tool": "x", "arguments": {"q": "a } b"}}')).toEqual({
      kind: 'tool',
      name: 'x',
      arguments: { q: 'a } b' },
    });
  });

  it('coerces a non-object arguments field to an empty object', () => {
    expect(parseDecision('{"tool": "x", "arguments": "oops"}')).toEqual({
      kind: 'tool',
      name: 'x',
      arguments: {},
    });
  });
});
