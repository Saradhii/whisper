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

/**
 * Build a GBNF grammar constraining output to a tool call or a respond signal.
 *
 * `allowRespond: false` removes the escape hatch entirely, so the sampler has
 * no legal path to "answer without acting" — the model MUST name a tool. That
 * variant is the recovery step: when the planner chose to respond but the user
 * plainly asked for an action, re-planning under this grammar is what turns
 * "I will set an alarm" into an alarm that exists.
 */
export function buildToolGrammar(
  toolNames: string[],
  opts: { allowRespond?: boolean } = {},
): string {
  const { allowRespond = true } = opts;
  // In GBNF the double quotes DELIMIT a literal — they are not part of what it
  // matches. So `"set_alarm"` constrains the model to emit the bare characters
  // set_alarm, producing {"tool":  set_alarm, ...}, which is not JSON. That one
  // missing level of quoting broke every single tool call: JSON.parse threw,
  // parseDecision fell back to 'respond', and the model narrated the action it
  // had correctly decided to take. The name must be a quoted JSON string, so
  // the quote characters themselves have to be escaped into the literal.
  const names = toolNames.map((n) => `"\\"${n}\\""`).join(' | ');
  return `
root        ::= ${allowRespond ? 'toolcall | respond' : 'toolcall'}
toolcall    ::= "{" ws "\\"tool\\"" ws ":" ws toolname ws "," ws "\\"arguments\\"" ws ":" ws object ws "}"${
    // Emitted only when reachable — llama.cpp's GBNF parser rejects a grammar
    // that declares a rule nothing references.
    allowRespond ? '\nrespond     ::= "{" ws "\\"respond\\"" ws ":" ws "true" ws "}"' : ''
  }
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
  /** `malformed` distinguishes "the model chose to answer" from "we could not
   *  read the decision at all". Both end the planning loop the same way, but
   *  only the second means the grammar isn't doing its job — and that used to
   *  be completely invisible. The loop traces it. */
  | { kind: 'respond'; malformed?: boolean };

/** Parse a grammar-constrained decision. Defensive despite the grammar: any
 *  unparseable/unexpected shape falls back to 'respond' so the loop ends
 *  cleanly rather than hanging. */
export function parseDecision(text: string): ToolDecision {
  const start = text.indexOf('{');
  if (start < 0) return { kind: 'respond', malformed: true };
  let obj: unknown;
  try {
    // Grammar-constrained output is one bare object, but a model that slipped
    // the grammar can trail prose after it — parse the object and ignore the
    // rest rather than throwing the whole decision away.
    obj = JSON.parse(text.slice(start, matchingBrace(text, start) + 1));
  } catch {
    return { kind: 'respond', malformed: true };
  }
  if (!obj || typeof obj !== 'object') return { kind: 'respond', malformed: true };
  const rec = obj as Record<string, unknown>;
  if (typeof rec.tool === 'string') {
    const args =
      rec.arguments && typeof rec.arguments === 'object' && !Array.isArray(rec.arguments)
        ? (rec.arguments as Record<string, unknown>)
        : {};
    return { kind: 'tool', name: rec.tool, arguments: args };
  }
  // A bare {"respond": true} is the model deliberately choosing to answer.
  // Any other object shape means the grammar let something through.
  return rec.respond === true ? { kind: 'respond' } : { kind: 'respond', malformed: true };
}

/** Index of the `}` closing the object that starts at `from`, or the last index
 *  of the string if it never closes (truncated output). String literals are
 *  skipped so a brace inside an argument value doesn't end the scan early. */
function matchingBrace(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return text.length - 1;
}
