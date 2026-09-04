// The conversational fast path: skip the planning generation entirely for
// turns that cannot possibly need a tool.
//
// WHY THIS EXISTS — measured on the test AVD, Qwen3 1.7B, a warm "hi":
//   plan   : 305 prompt tokens re-evaluated at 38 tok/s = 8.1s, to emit the
//            five tokens {"respond": true}
//   answer :  79 prompt tokens + 22 generated              = 3.7s
// Two thirds of a greeting's latency is a grammar-constrained generation whose
// only possible useful output is "no tool needed". The turn is ALL prefill —
// decode runs at a healthy 16-17 tok/s — so the only way to remove the cost is
// to not run the generation.
//
// WHY IT IS AN ALLOWLIST, AND WHY IT IS SO NARROW.
// The worst regression this app has shipped is narrating an action instead of
// performing it: "I will set an alarm for 7" and no alarm (see loop.ts on the
// removed "recover" phase, and agent-tool-test-sheet.md). Anything that routes
// a real request away from the planner reintroduces exactly that failure, and
// it fails SILENTLY — the user is told their alarm is set.
//
// So the gate is built to fail in the safe direction. It does not try to
// recognise requests that need a tool and skip the rest; that inverts the risk,
// because the set of ways to ask for an alarm is open-ended ("wake me at 7")
// while the set of greetings is not. Instead EVERY word must appear in a closed
// pleasantry vocabulary, and at least one must be a real conversational anchor.
// A message containing one unrecognised word — "calendar", "alarm", "wake",
// "search", or anything else — plans exactly as it does today. The cost of a
// miss is the status quo; the cost of a false skip is a lie to the user.
//
// fastPath.test.ts asserts zero false skips across every corpus scenario that
// expects a tool call. That test is the real specification: widen the
// vocabulary only with it green.

/** Words that may appear in a message that is certainly just conversation. */
const SAFE_WORDS = new Set([
  // greetings
  'hi', 'hii', 'hiya', 'hello', 'helo', 'hey', 'heya', 'yo', 'howdy', 'sup',
  'morning', 'afternoon', 'evening', 'night', 'good', 'goodmorning',
  // gratitude
  'thanks', 'thank', 'thankyou', 'thx', 'ty', 'cheers', 'appreciate', 'appreciated',
  // acknowledgement / assent
  'ok', 'okay', 'k', 'kk', 'sure', 'yes', 'yeah', 'yep', 'yup', 'no', 'nope',
  'nah', 'right', 'alright', 'indeed', 'exactly', 'agreed', 'understood', 'noted',
  // praise / reaction
  'cool', 'nice', 'great', 'awesome', 'perfect', 'lovely', 'sweet', 'brilliant',
  'excellent', 'wonderful', 'amazing', 'wow', 'haha', 'hah', 'lol', 'hmm', 'oh',
  'well', 'done', 'glad', 'welcome',
  // farewells
  'bye', 'byebye', 'goodbye', 'goodnight', 'see', 'ya', 'you', 'later', 'soon',
  // connective filler that shows up inside the phrases above
  'a', 'all', 'am', 'and', 'are', 'as', 'be', 'been', 'doing', 'fine', 'for',
  'friend', 'go', 'going', 'got', 'how', 'hows', 'i', 'im', 'is', 'it', 'its',
  'lot', 'm', 'mate', 'much', 'my', 'now', 'really', 'so', 'thats', 'that',
  'the', 'then', 'there', 'this', 'to', 'today', 'too', 'up', 'very', 'was',
  'were', 'whats', 'work', 'youre', 'your',
]);

/**
 * At least one of these must be present. Without it a message made only of
 * filler ("is that all for now") would pass the vocabulary test while actually
 * being a question the planner should see.
 */
const ANCHOR_WORDS = new Set([
  'hi', 'hii', 'hiya', 'hello', 'helo', 'hey', 'heya', 'yo', 'howdy', 'sup',
  'morning', 'afternoon', 'evening', 'goodmorning', 'goodnight',
  'thanks', 'thank', 'thankyou', 'thx', 'ty', 'cheers', 'appreciate', 'appreciated',
  'ok', 'okay', 'kk', 'sure', 'yes', 'yeah', 'yep', 'yup', 'nope', 'nah',
  'cool', 'nice', 'great', 'awesome', 'perfect', 'lovely', 'sweet', 'brilliant',
  'excellent', 'wonderful', 'amazing', 'wow', 'haha', 'lol', 'welcome',
  'bye', 'byebye', 'goodbye', 'alright', 'agreed', 'understood', 'noted',
]);

/**
 * Long messages plan, whatever they contain. A real pleasantry is short, and
 * the longer a message is the more room it has to carry a request that the
 * vocabulary check would have to catch on every single word.
 */
const MAX_WORDS = 8;

/**
 * True when `text` is certainly conversation and needs no planning turn.
 *
 * Conservative by construction: unknown word, digit, or length ⇒ false ⇒ the
 * turn plans exactly as before. False is always safe; true must be earned.
 */
export function skipsPlanning(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // A digit is a time, a date, a quantity or an address — never a pleasantry,
  // and always the sort of thing a tool takes as an argument.
  if (/\d/.test(trimmed)) return false;

  const words = trimmed
    .toLowerCase()
    // Keep letters only; apostrophes collapse so "what's" -> "whats" and
    // "i'm" -> "im", which is how they are spelled in the vocabulary.
    .replace(/['’]/g, '')
    .split(/[^a-z]+/)
    .filter(Boolean);

  if (words.length === 0 || words.length > MAX_WORDS) return false;
  if (!words.every((w) => SAFE_WORDS.has(w))) return false;
  return words.some((w) => ANCHOR_WORDS.has(w));
}
