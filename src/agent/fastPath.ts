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
// WHY IT FAILS TOWARD PLANNING.
// The worst regression this app has shipped is narrating an action instead of
// performing it: "I will set an alarm for 7" and no alarm (see loop.ts on the
// removed "recover" phase, and agent-tool-test-sheet.md). Anything that routes
// a real request away from the planner reintroduces that failure, and it fails
// SILENTLY — the user is told their alarm is set. So a miss here costs one slow
// turn; a false skip costs a lie. The gate is built to be wrong in the first
// direction only.
//
// WHY WHOLE PHRASES, NOT A VOCABULARY — this is the second design, and the
// first one was wrong in a way worth recording.
//
// The original gate was a bag of words: every word had to be in a "safe"
// vocabulary and at least one had to be a conversational anchor. Each word was
// defensible in isolation. The rule ignored ORDER, and safe words compose into
// unsafe sentences:
//
//     "hey how much work is there today"   -> SKIPPED planning
//     "how much work is there today"       -> planned correctly
//
// Every word there is innocent — `how`, `much`, `is`, `there` are pure filler —
// and together they are a question. The anchor requirement was working; what
// defeated it is that the greeting DONATES the anchor while the rest of the
// sentence happens to be built from whitelisted filler.
//
// Curating the vocabulary cannot fix this, and there is a proof rather than
// just a failed attempt: "thank you so much" is a real pleasantry this gate
// must accept, so `much` has to stay in any word list — and the moment it does,
// "hey how much is there" passes. The defect is the layer, not the contents.
//
// So the unit of matching is a whole pleasantry. The normalized message must be
// a sequence of complete recognised phrases and nothing else, anchored at both
// ends, so no unrecognised clause can ride along behind a greeting. Composing
// PHRASES is safe in a way composing WORDS is not: "morning" + "how are you
// doing today" is still a pleasantry, whereas "hey" + six filler words is a
// question.
//
// The cost is coverage: some real pleasantries phrased in ways not listed here
// will plan. That is the accepted trade — the gate exists to make the common
// pleasantries cheap, not to catch every one, and a phrasing that plans costs a
// single slow turn.
//
// fastPath.test.ts asserts zero false skips across every corpus scenario that
// expects a tool, AND pins the greeting-prefix CLASS that broke the first
// design. Widen PHRASES only with both green.

/**
 * Complete pleasantries, normalized (lowercase, no punctuation, single spaces).
 *
 * Each entry must stand alone as a whole utterance. Never add a bare filler
 * word — `today`, `work`, `much`, `now` were exactly what let a question
 * through last time. If an entry is not something a person could say on its own
 * and mean nothing by, it does not belong here.
 */
const PHRASES = [
  // greetings
  'hi', 'hii', 'hiya', 'hello', 'hey', 'heya', 'yo', 'howdy', 'sup',
  'hi there', 'hello there', 'hey there', 'hiya there',
  'good morning', 'good afternoon', 'good evening', 'good day',
  'morning', 'afternoon', 'evening',
  // how-are-you, as fixed sentences rather than assemblable parts
  'how are you', 'how are you doing', 'how are you doing today',
  'how are you today', 'hows it going', 'how is it going', 'hows things',
  'how have you been', 'you ok', 'you good',
  // gratitude
  'thanks', 'thank you', 'thanx', 'thx', 'ty', 'cheers',
  'thanks a lot', 'thanks so much', 'thank you so much', 'thanks a ton',
  'thanks very much', 'thank you very much', 'much appreciated',
  'appreciate it', 'i appreciate it',
  // acknowledgement and assent
  'ok', 'okay', 'kk', 'sure', 'yes', 'yeah', 'yep', 'yup', 'no', 'nope', 'nah',
  'right', 'alright', 'all right', 'got it', 'gotcha', 'understood', 'noted',
  'agreed', 'indeed', 'exactly', 'fair enough', 'sounds good', 'will do',
  // reactions and praise
  'cool', 'nice', 'great', 'awesome', 'perfect', 'lovely', 'sweet',
  'brilliant', 'excellent', 'wonderful', 'amazing', 'wow', 'haha', 'hah',
  'lol', 'nice one', 'nice work', 'well done', 'good job', 'good stuff',
  'that was perfect', 'that was great', 'that helps', 'that helped',
  'very helpful', 'super helpful',
  // closings
  'bye', 'byebye', 'goodbye', 'see you', 'see ya', 'see you later',
  'talk later', 'later', 'good night', 'goodnight', 'night', 'take care',
  'that is all', 'thats all', 'that is all for now', 'thats all for now',
  'that will be all', 'thatll be all', 'no more', 'im done', 'we are done',
  'were done', 'nothing else',
  // demurrals
  'no worries', 'no problem', 'np', 'its fine', 'it is fine', 'youre welcome',
  'my pleasure',
];

/**
 * `^phrase( phrase)*$` — the whole message, nothing left over.
 *
 * Longest alternatives first so the engine prefers "thank you so much" over
 * "thank you" and then failing on the remainder. Backtracking handles the rest.
 */
const PLEASANTRY = (() => {
  const alts = [...PHRASES]
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`^(?:${alts})(?: (?:${alts}))*$`);
})();

/**
 * Bound on the work the regex can be asked to do, and a second line of defence:
 * a real pleasantry is short. Generous enough for "perfect thanks that is all
 * for now" (eight words).
 */
const MAX_WORDS = 10;

/**
 * True when `text` is certainly conversation and needs no planning turn.
 *
 * False is always safe and is the default for anything unrecognised; true must
 * be earned by matching pleasantries end to end.
 */
export function skipsPlanning(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // A digit is a time, a date, a quantity or an address — never a pleasantry,
  // and always the sort of thing a tool takes as an argument. Checked BEFORE
  // normalization, which strips digits and would otherwise reduce "hi 7" to a
  // matching "hi".
  if (/\d/.test(trimmed)) return false;

  const normalized = trimmed
    .toLowerCase()
    .replace(/['’]/g, '') // "what's" -> "whats", "i'm" -> "im"
    .replace(/[^a-z]+/g, ' ')
    .trim();

  if (!normalized) return false;
  if (normalized.split(' ').length > MAX_WORDS) return false;
  return PLEASANTRY.test(normalized);
}
