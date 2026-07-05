import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentMessage, Engine, GenerateResult } from '@/src/engines/types';
import { runAgent, type AgentEvent } from './loop';
import { defineTool } from './types';

// Fake engine: replays a scripted list of decision/answer texts and records
// every message list + options it receives. Planning turns are grammar-
// constrained (opts.grammar set); the final turn streams (onToken).
function fakeEngine(script: string[]) {
  const seen: { messages: AgentMessage[]; grammar: boolean }[] = [];
  let turn = 0;
  const engine: Engine = {
    load: async () => {},
    stop: async () => {},
    unload: async () => {},
    generate: async (messages, onToken, opts) => {
      seen.push({ messages: JSON.parse(JSON.stringify(messages)), grammar: !!opts?.grammar });
      const text = script[Math.min(turn++, script.length - 1)]!;
      if (!opts?.grammar && text) onToken(text); // final turn streams
      const res: GenerateResult = { text, toolCalls: [] };
      return res;
    },
  };
  return { engine, seen };
}

const echoTool = defineTool({
  name: 'echo',
  description: 'echo',
  params: z.object({ text: z.string() }),
  label: (a) => `Echo ${a.text}`,
  execute: async (a) => `echoed: ${a.text}`,
});

const guardedTool = defineTool({
  name: 'guarded',
  description: 'needs confirmation',
  params: z.object({}),
  label: () => 'Guarded action',
  requiresConfirmation: true,
  execute: async () => 'did the thing',
});

const cb = (events: AgentEvent[], allow = true) => ({
  onEvent: (e: AgentEvent) => events.push(e),
  confirm: async () => allow,
});

describe('runAgent (grammar-constrained)', () => {
  it('answers directly when the model responds without a tool', async () => {
    const { engine, seen } = fakeEngine(['{"respond": true}', 'hi there']);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'hi' }], cb(events));
    // Turn 1 = grammar-constrained decision, turn 2 = streamed answer.
    expect(seen[0]!.grammar).toBe(true);
    expect(seen[1]!.grammar).toBe(false);
    expect(events).toContainEqual({ type: 'token', token: 'hi there' });
  });

  it('executes a tool then streams a final answer', async () => {
    const { engine, seen } = fakeEngine([
      '{"tool": "echo", "arguments": {"text": "yo"}}',
      '{"respond": true}',
      'I echoed yo.',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'echo yo' }], cb(events));
    expect(events).toContainEqual({ type: 'tool', label: 'Echo yo', status: 'running' });
    expect(events).toContainEqual({ type: 'tool', label: 'Echo yo', status: 'done' });
    // The tool result is fed back into the conversation for the model.
    const withResult = seen.find((s) =>
      s.messages.some((m) => m.role === 'user' && m.content.startsWith('Result of echo:')),
    );
    expect(withResult).toBeDefined();
    expect(events).toContainEqual({ type: 'token', token: 'I echoed yo.' });
  });

  it('feeds invalid model arguments back as a validation message', async () => {
    const { engine, seen } = fakeEngine([
      '{"tool": "echo", "arguments": {"wrong": 1}}',
      '{"respond": true}',
      'ok',
    ]);
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'x' }], cb([]));
    const toolResult = seen
      .flatMap((s) => s.messages)
      .find((m) => m.role === 'user' && m.content.includes('Result of echo:'));
    expect(toolResult?.content).toMatch(/Invalid arguments/);
  });

  it('denied confirmation skips execution and tells the model', async () => {
    const { engine, seen } = fakeEngine([
      '{"tool": "guarded", "arguments": {}}',
      '{"respond": true}',
      'understood',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [guardedTool], [{ role: 'user', content: 'x' }], cb(events, false));
    expect(events).toContainEqual({ type: 'tool', label: 'Guarded action', status: 'denied' });
    expect(
      seen.flatMap((s) => s.messages).find((m) => m.content.includes('Result of guarded:'))
        ?.content,
    ).toMatch(/denied/);
  });

  it('reports unknown tools instead of crashing', async () => {
    const { engine, seen } = fakeEngine([
      '{"tool": "nope", "arguments": {}}',
      '{"respond": true}',
      'sorry',
    ]);
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'x' }], cb([]));
    expect(
      seen.flatMap((s) => s.messages).find((m) => m.content.includes('does not exist')),
    ).toBeDefined();
  });

  it('surfaces a tool execution error as a result, not an exception', async () => {
    const boom = defineTool({
      name: 'boom',
      description: 'throws',
      params: z.object({}),
      label: () => 'Boom',
      execute: async () => {
        throw new Error('kapow');
      },
    });
    const { engine, seen } = fakeEngine([
      '{"tool": "boom", "arguments": {}}',
      '{"respond": true}',
      'oh no',
    ]);
    const events: AgentEvent[] = [];
    await runAgent(engine, [boom], [{ role: 'user', content: 'x' }], cb(events));
    expect(events).toContainEqual({ type: 'tool', label: 'Boom', status: 'error' });
    expect(
      seen.flatMap((s) => s.messages).find((m) => m.content.includes('Result of boom:'))?.content,
    ).toBe('Result of boom: Tool error: kapow');
  });

  it('stops after MAX_STEPS of repeated tool calls and still answers', async () => {
    // Model always wants the tool → loop must bail and produce a final answer.
    const { engine, seen } = fakeEngine(['{"tool": "echo", "arguments": {"text": "again"}}']);
    const events: AgentEvent[] = [];
    await runAgent(engine, [echoTool], [{ role: 'user', content: 'x' }], cb(events));
    // 5 planning turns + 1 final streamed turn.
    expect(seen).toHaveLength(6);
    expect(seen[5]!.grammar).toBe(false);
  });
});
