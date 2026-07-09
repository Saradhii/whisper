// The agent loop, grammar-constrained. Each planning turn is forced (via GBNF)
// to emit exactly one decision: call a named tool, or respond to the user.
// This is the mechanism behind reliable on-device tool use (LiteRT-LM / AI Edge
// Gallery do the same) — the model literally cannot narrate fake success where
// a structured decision is required. Once planning is done, a final UNCONSTRAINED
// turn streams a natural-language answer to the user.
//
// Pure orchestration (engine + tools injected) so it is unit-tested in Node.
import type { AgentMessage, ChatMessage, Engine } from '@/src/engines/types';
import { buildToolGrammar, parseDecision } from './grammar';
import type { AnyTool } from './types';

const MAX_STEPS = 5;

export type AgentEvent =
  | { type: 'token'; token: string }
  | { type: 'tool'; label: string; status: 'running' | 'done' | 'denied' | 'error' };

export type AgentCallbacks = {
  onEvent: (e: AgentEvent) => void;
  /** Ask the user to approve a side-effecting action. */
  confirm: (summary: string) => Promise<boolean>;
};

/** Render each tool as name + description + argument keys for the prompt. */
function toolCatalog(tools: AnyTool[]): string {
  return tools
    .map((t) => {
      const schema = t.jsonSchema as {
        properties?: Record<string, { type?: string; description?: string }>;
        required?: string[];
      };
      const props = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const args = Object.entries(props)
        .map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${v.type ?? 'any'}`)
        .join(', ');
      return `- ${t.name}: ${t.description} arguments: {${args}}`;
    })
    .join('\n');
}

function systemPrompt(tools: AnyTool[], now: Date): string {
  // Date only (no time-of-day) so the prompt prefix is stable across turns and
  // llama.cpp's KV cache can be reused instead of re-prefilling every message.
  const date = now.toISOString().slice(0, 10);
  return (
    `You are Whisper, a helpful assistant running fully on the user's phone. ` +
    `Today's date is ${date}.\n\n` +
    `You perform real phone actions by calling tools. On each turn reply with ` +
    `EXACTLY ONE JSON object and nothing else:\n` +
    `- To call a tool: {"tool": "<name>", "arguments": { ... }}\n` +
    `- When no tool is needed, or you already have everything to answer: {"respond": true}\n\n` +
    `Available tools:\n${toolCatalog(tools)}\n\n` +
    `Rules: Use a tool whenever the user asks you to DO something (set an alarm, ` +
    `create an event, search, etc.). Only emit {"respond": true} once you are ready ` +
    `to answer. Never pretend an action happened — actions happen only via tools.`
  );
}

export async function runAgent(
  engine: Engine,
  tools: AnyTool[],
  history: ChatMessage[],
  { onEvent, confirm }: AgentCallbacks,
  now: Date = new Date(),
): Promise<void> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const grammar = buildToolGrammar(tools.map((t) => t.name));
  const messages: AgentMessage[] = [
    { role: 'system', content: systemPrompt(tools, now) },
    ...history,
  ];

  // Planning: constrained decisions, no streaming (output is control JSON).
  // A single decision object is tiny — cap it so a stray token stream can't run.
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await engine.generate(messages, () => {}, {
      grammar,
      disableThinking: true,
      maxTokens: 256,
    });
    const decision = parseDecision(res.text);
    if (decision.kind === 'respond') break;

    const tool = byName.get(decision.name);
    if (!tool) {
      messages.push({ role: 'assistant', content: res.text });
      messages.push({ role: 'user', content: `Tool "${decision.name}" does not exist.` });
      continue;
    }

    const label = tool.label(decision.arguments);
    let result: string;
    if (tool.requiresConfirmation && !(await confirm(label))) {
      onEvent({ type: 'tool', label, status: 'denied' });
      result = 'The user denied this action. Do not retry it; ask what they want instead.';
    } else {
      onEvent({ type: 'tool', label, status: 'running' });
      try {
        result = await tool.run(decision.arguments);
        onEvent({ type: 'tool', label, status: 'done' });
      } catch (e) {
        result = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
        onEvent({ type: 'tool', label, status: 'error' });
      }
    }
    messages.push({ role: 'assistant', content: res.text });
    messages.push({ role: 'user', content: `Result of ${decision.name}: ${result}` });
  }

  // Final answer: unconstrained, streamed to the user in natural language.
  messages.push({
    role: 'user',
    content:
      'Now reply to me directly in plain, natural language. If you used tools, ' +
      'briefly tell me what actually happened. Do not output JSON.',
  });
  await engine.generate(messages, (token) => onEvent({ type: 'token', token }), {
    disableThinking: true,
  });
}
