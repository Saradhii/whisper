import { describe, expect, it } from 'vitest';

import { normalizeToolCalls, toolCallReplay } from './toolcalls';

describe('normalizeToolCalls', () => {
  it('fills a null id (the RN-bridge shape that crashed llama.cpp on replay)', () => {
    // Regression: Qwen emits no call ids; llama.rn returns undefined, the RN
    // bridge serializes it to null, and llama.cpp's strict parser threw
    // [json.exception.type_error.302] when the null was replayed.
    const calls = normalizeToolCalls([
      { id: null, function: { name: 'list_calendar_events', arguments: '{"start":"2026-07-01"}' } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe('call_0');
    expect(calls[0]!.arguments).toEqual({ start: '2026-07-01' });
  });

  it('keeps provided string ids', () => {
    const calls = normalizeToolCalls([
      { id: 'abc', function: { name: 't', arguments: '{}' } },
    ]);
    expect(calls[0]!.id).toBe('abc');
  });

  it('tolerates object arguments, malformed JSON, and null arguments', () => {
    const calls = normalizeToolCalls([
      { function: { name: 'a', arguments: { x: 1 } } },
      { function: { name: 'b', arguments: '{not json' } },
      { function: { name: 'c', arguments: null } },
    ]);
    expect(calls.map((c) => c.arguments)).toEqual([{ x: 1 }, {}, {}]);
    expect(calls.map((c) => c.id)).toEqual(['call_0', 'call_1', 'call_2']);
  });

  it('drops entries without a function name and non-array input', () => {
    expect(normalizeToolCalls([{ function: { name: 42, arguments: '{}' } }])).toEqual([]);
    expect(normalizeToolCalls(null)).toEqual([]);
    expect(normalizeToolCalls('nope')).toEqual([]);
  });
});

describe('toolCallReplay', () => {
  it('rebuilds an all-string OpenAI entry — no nulls can reach the native parser', () => {
    const call = normalizeToolCalls([
      { id: null, function: { name: 'x', arguments: '{"a":1}' } },
    ])[0]!;
    const replay = toolCallReplay(call);
    expect(replay).toEqual({
      type: 'function',
      id: 'call_0',
      function: { name: 'x', arguments: '{"a":1}' },
    });
    // Structural guarantee: serialized form contains no null anywhere.
    expect(JSON.stringify(replay)).not.toContain('null');
  });
});
