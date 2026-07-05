// Grammar-constrained tool calling. Small models hallucinate tool use — they
// narrate "the alarm is set" instead of emitting a call. The fix (the same
// mechanism LiteRT-LM / AI Edge Gallery use) is constrained decoding: mask the
// sampler so the model can ONLY emit a syntactically valid decision. We force
// each planning turn to be exactly one JSON object:
//   {"tool": "<one of the real tool names>", "arguments": { ... }}   — call a tool
//   {"respond": true}                                                — answer the user
// The tool name is pinned to an enum so the model can't invent tools; arguments
// are then zod-validated at execution. Char classes are hand-written (no PCRE
// \d\w\s shorthands, which llama.rn's converter mishandles — llama.cpp #22314).

/** Build a GBNF grammar constraining output to a tool call or a respond signal. */
export function buildToolGrammar(toolNames: string[]): string {
  const names = toolNames.map((n) => JSON.stringify(n)).join(' | ');
  return `
root        ::= toolcall | respond
toolcall    ::= "{" ws "\\"tool\\"" ws ":" ws toolname ws "," ws "\\"arguments\\"" ws ":" ws object ws "}"
respond     ::= "{" ws "\\"respond\\"" ws ":" ws "true" ws "}"
toolname    ::= ${names}
object      ::= "{" ws ( member ( ws "," ws member )* )? ws "}"
member      ::= string ws ":" ws value
array       ::= "[" ws ( value ( ws "," ws value )* )? ws "]"
value       ::= object | array | string | number | "true" | "false" | "null"
string      ::= "\\"" char* "\\""
char        ::= [^"\\\\] | "\\\\" (["\\\\/bfnrt] | "u" hex hex hex hex)
hex         ::= [0-9a-fA-F]
number      ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?
ws          ::= [ \\t\\n]*
`.trim();
}

export type ToolDecision =
  | { kind: 'tool'; name: string; arguments: Record<string, unknown> }
  | { kind: 'respond' };

/** Parse a grammar-constrained decision. Defensive despite the grammar: any
 *  unparseable/unexpected shape falls back to 'respond' so the loop ends
 *  cleanly rather than hanging. */
export function parseDecision(text: string): ToolDecision {
  const start = text.indexOf('{');
  if (start < 0) return { kind: 'respond' };
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start));
  } catch {
    return { kind: 'respond' };
  }
  if (!obj || typeof obj !== 'object') return { kind: 'respond' };
  const rec = obj as Record<string, unknown>;
  if (typeof rec.tool === 'string') {
    const args =
      rec.arguments && typeof rec.arguments === 'object' && !Array.isArray(rec.arguments)
        ? (rec.arguments as Record<string, unknown>)
        : {};
    return { kind: 'tool', name: rec.tool, arguments: args };
  }
  return { kind: 'respond' };
}
