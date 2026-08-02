// Tool definition core. Each tool declares its parameters ONCE as a zod
// schema: z.toJSONSchema() derives the declaration the model sees, and
// run() parses incoming arguments through the same schema before executing —
// so model-produced args are validated at the boundary, never trusted.
// Pure module (no Expo imports) so the agent loop is unit-testable in Node.
import { z } from 'zod';

/**
 * Categories of agent step recorded by the trace buffer.
 *   plan   — a grammar-constrained planning decision (raw JSON)
 *   tool   — a tool executed, denied, or failed
 *   answer — the final unconstrained reply
 *   warn   — the agent did something suspicious but recoverable (e.g. planned
 *            'respond' on a request that clearly wanted an action)
 *   error  — a step that failed outright
 */
export type AgentTraceKind = 'plan' | 'tool' | 'answer' | 'warn' | 'error';

/**
 * Thrown when the model's arguments don't match the tool's schema. Distinct
 * from an execution failure on purpose: a tool that threw might well work on a
 * second try, but the same bad arguments will always fail the same way, so the
 * loop must spend its retry on the former and never on the latter.
 */
export class InvalidArguments extends Error {}

/** Type-erased tool, safe to hold in a heterogeneous registry. */
export type AnyTool = {
  name: string;
  description: string;
  /** JSON Schema for the model's tool declaration (derived from zod). */
  jsonSchema: object;
  /** Human-readable one-liner for chips and confirmation prompts. */
  label: (args: unknown) => string;
  requiresConfirmation?: boolean;
  /**
   * True when the tool CHANGES something (sets an alarm, opens a composer,
   * writes the clipboard) rather than just reporting. It decides how the final
   * answer is framed: an action wants "I set the alarm for 7", a read wants the
   * answer to the question. Without the split, reads came back as "The battery
   * WAS at 100%" and, worse, "I searched and found several resources" — the
   * results sitting unused in context while the model described its own search.
   */
  mutates?: boolean;
  /** Validate args and execute. Rejects on bad arguments as well as on a real
   *  execution failure — both mean the call produced nothing, and the loop
   *  needs to tell those apart from a call that returned a result. */
  run: (args: unknown) => Promise<string>;
};

/**
 * Derive the model-facing JSON Schema from a params schema. `io: 'input'`
 * describes what the model SENDS (e.g. ISO strings), not the transformed
 * output (e.g. Date) — and without it zod THROWS on schemas containing
 * .transform(), which is a startup crash since registries build at import
 * time. Shared with tests so every registered schema is proven convertible.
 */
export function paramsToJsonSchema(params: z.ZodType): object {
  return z.toJSONSchema(params, { io: 'input' });
}

export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  params: z.ZodObject<S>;
  label: (args: z.infer<z.ZodObject<S>>) => string;
  requiresConfirmation?: boolean;
  mutates?: boolean;
  execute: (args: z.infer<z.ZodObject<S>>) => Promise<string>;
}): AnyTool {
  return {
    name: def.name,
    description: def.description,
    jsonSchema: paramsToJsonSchema(def.params),
    requiresConfirmation: def.requiresConfirmation,
    mutates: def.mutates,
    label: (args) => {
      const parsed = def.params.safeParse(args ?? {});
      return parsed.success ? def.label(parsed.data) : def.name;
    },
    run: async (args) => {
      const parsed = def.params.safeParse(args ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.') || 'args'}: ${i.message}`)
          .join('; ');
        // Thrown, not returned. Returning it read as a successful call to the
        // loop: the chip went green, the run was counted, and the answer turn
        // was told to describe in the past tense something that never ran.
        throw new InvalidArguments(
          `Invalid arguments (${issues}). Fix them and call the tool again.`,
        );
      }
      return def.execute(parsed.data);
    },
  };
}

