// Boundary guard for tool calls crossing the native bridge. Native results
// arrive with nullable/absent fields (e.g. Qwen produces no call ids, and the
// RN bridge turns undefined into null); llama.cpp's message parser is strict
// on replay (a present-but-null field throws deep in C++). So: parse whatever
// the engine returns into a fully-populated CleanToolCall here, and rebuild
// replay messages ONLY from these clean values — raw native objects must
// never be echoed back into a completion request.
// Pure module (zod only) so it is unit-testable in Node.
import { z } from 'zod';

const RawToolCall = z.object({
  id: z.string().nullish(),
  function: z.object({
    name: z.string(),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
  }),
});

export type CleanToolCall = {
  id: string;
  name: string;
  /** Parsed arguments object ({} if the model emitted invalid JSON). */
  arguments: Record<string, unknown>;
  /** Canonical JSON string of `arguments`, for replay. */
  argumentsJson: string;
};

/** Normalize an engine's raw tool_calls array; invalid entries are dropped. */
export function normalizeToolCalls(raw: unknown): CleanToolCall[] {
  const list = Array.isArray(raw) ? raw : [];
  const clean: CleanToolCall[] = [];
  for (const item of list) {
    const parsed = RawToolCall.safeParse(item);
    if (!parsed.success) continue;
    let args: Record<string, unknown> = {};
    const rawArgs = parsed.data.function.arguments;
    if (typeof rawArgs === 'string') {
      try {
        const obj: unknown = JSON.parse(rawArgs);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          args = obj as Record<string, unknown>;
        }
      } catch {
        // model emitted malformed JSON — keep {} and let arg validation report it
      }
    } else if (rawArgs) {
      args = rawArgs;
    }
    clean.push({
      id: parsed.data.id ?? `call_${clean.length}`,
      name: parsed.data.function.name,
      arguments: args,
      argumentsJson: JSON.stringify(args),
    });
  }
  return clean;
}

/** Rebuild an OpenAI-style tool_calls entry from clean values (all strings —
 * structurally incapable of carrying a null back to the native parser). */
export function toolCallReplay(c: CleanToolCall): {
  type: 'function';
  id: string;
  function: { name: string; arguments: string };
} {
  return { type: 'function', id: c.id, function: { name: c.name, arguments: c.argumentsJson } };
}
