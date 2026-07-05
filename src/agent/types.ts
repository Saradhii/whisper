// Tool definition core. Each tool declares its parameters ONCE as a zod
// schema: z.toJSONSchema() derives the declaration the model sees, and
// run() parses incoming arguments through the same schema before executing —
// so model-produced args are validated at the boundary, never trusted.
// Pure module (no Expo imports) so the agent loop is unit-testable in Node.
import { z } from 'zod';

/** Type-erased tool, safe to hold in a heterogeneous registry. */
export type AnyTool = {
  name: string;
  description: string;
  /** JSON Schema for the model's tool declaration (derived from zod). */
  jsonSchema: object;
  /** Human-readable one-liner for chips and confirmation prompts. */
  label: (args: unknown) => string;
  requiresConfirmation?: boolean;
  /** Validate args and execute; validation failures return an error string
   * the model can react to instead of throwing. */
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
  execute: (args: z.infer<z.ZodObject<S>>) => Promise<string>;
}): AnyTool {
  return {
    name: def.name,
    description: def.description,
    jsonSchema: paramsToJsonSchema(def.params),
    requiresConfirmation: def.requiresConfirmation,
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
        return `Invalid arguments (${issues}). Fix the arguments and call the tool again.`;
      }
      return def.execute(parsed.data);
    },
  };
}

/** OpenAI-style declarations for a tool list, to pass to the engine. */
export function toolSchemas(tools: AnyTool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.jsonSchema },
  }));
}
