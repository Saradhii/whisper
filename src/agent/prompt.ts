// Everything the agent SAYS to the model, in one place.
//
// This used to be interleaved with the orchestration in loop.ts, which made
// both hard to read and the prompt impossible to test on its own. The loop now
// only decides WHEN to speak; this module decides WHAT is said. Pure strings —
// no engine, no Expo — so the whole prompt is asserted in Node.
//
// Two constraints shape the layout:
//   * KV-cache reuse. llama.cpp reprefills from the first byte that differs, so
//     everything stable (identity, tool catalog, examples) lives in the system
//     message and everything that ticks (the wall clock, what has run so far)
//     goes in a note appended AFTER the history.
//   * The model is 1-2B. It gets a worked transcript for each behaviour we
//     care about, and rules phrased as consequences ("it happens TWICE") rather
//     than as policy.
import type { AgentMessage } from '@/src/engines/types';

import { renderExamples } from './examples';
import type { AnyTool } from './types';

/**
 * Context tokens the chat screen holds back for an agent turn, leaving the rest
 * for conversation history. It has to cover the whole of this module's output —
 * the system message (~1900 tokens with the full catalog and examples), the
 * per-turn note, the decisions and results the loop appends as it runs, and the
 * bounded final answer. Under-reserving doesn't fail loudly; it silently evicts
 * the user's own messages from the front of the history. prompt.test.ts pins
 * the system message against it.
 */
export const TOOL_PROMPT_RESERVE = 2816;

/**
 * Each tool as name + description + argument list (`?` marks optional).
 *
 * Argument descriptions are included, and that is not cosmetic: this used to
 * render `hour: integer` and nothing else, so every `.describe()` in
 * toolDefs.ts — "1pm is 13 and 6pm is 18", "0 unless a specific minute was
 * asked for" — was written, tested, and never shown to the model. "8pm today"
 * kept coming back as 8:53 PM, the minute copied off the wall clock, because
 * nothing had ever told it otherwise.
 */
export function toolCatalog(tools: AnyTool[]): string {
  return tools
    .map((t) => {
      const schema = t.jsonSchema as {
        properties?: Record<string, { type?: string; description?: string }>;
        required?: string[];
      };
      const required = new Set(schema.required ?? []);
      const args = Object.entries(schema.properties ?? {})
        .map(([k, v]) => {
          const head = `${k}${required.has(k) ? '' : '?'}: ${v.type ?? 'any'}`;
          return v.description ? `${head} (${v.description})` : head;
        })
        .join(', ');
      return `- ${t.name}: ${t.description} arguments: {${args}}`;
    })
    .join('\n');
}

/**
 * The stable prefix: identity, the protocol, the tool catalog, the rules, and
 * the worked examples. Carries the DATE but not the time of day — a clock in
 * here would invalidate the cached prefix on every single turn.
 */
export function systemPrompt(tools: AnyTool[], now: Date): string {
  return [
    `You are Whisper, a helpful assistant running fully on the user's phone.`,
    `Today's date is ${localDate(now)}.`,
    ``,
    `You do real things on this phone by calling tools. On each planning turn,`,
    `reply with EXACTLY ONE JSON object and nothing else:`,
    `  {"tool": "<name>", "arguments": {...}}   call a tool`,
    `  {"respond": true}                        you are ready to answer in words`,
    ``,
    `Tools:`,
    toolCatalog(tools),
    ``,
    `How a turn goes:`,
    `1. The user asks for something.`,
    `2. You emit one tool call. It runs, and the result comes back to you as`,
    `   "Result of <name>: ...".`,
    `3. You emit {"respond": true}, and then you get to reply in plain words.`,
    ``,
    `Rules:`,
    `- Promising to do something does NOT do it. Only a tool call does.`,
    `- One call per request. Once a tool has returned, you have its answer —`,
    `  calling it again returns the same thing, and for actions like set_alarm`,
    `  or create_calendar_event it really happens a second time.`,
    `- Call a second tool only when it does something DIFFERENT and necessary,`,
    `  such as looking up a number before texting it.`,
    `- An empty or disappointing result ("No events in that range.") is still`,
    `  the answer. Report it. Do not look again.`,
    `- Never work out a date yourself: copy it from the date list in the note`,
    `  below the conversation, and never copy one out of these examples. Hours`,
    `  are on a 24-hour clock, so 1pm is 13 and 6pm is 18.`,
    `- If no tool does what was asked — there is no way to delete or edit`,
    `  anything — say so plainly. Never substitute a tool that does something`,
    `  else, and never one that does the opposite of what was asked.`,
    `- Do not call a tool to check on something you have just done, and do not`,
    `  search the web for something you already know.`,
    `- If the user denied an action, do not attempt it again.`,
    `- MOST turns need no tool at all. Greetings, thanks, small talk, opinions,`,
    `  follow-up chat, and any question you can answer from your own knowledge`,
    `  are all {"respond": true}. Reach for a tool only when the user wants`,
    `  something done on the phone, or wants information only the phone or the`,
    `  web can supply. When in doubt, answer.`,
    ``,
    `Worked examples:`,
    renderExamples(tools),
  ].join('\n');
}

/**
 * The trailing instruction for a planning turn: the wall clock the system
 * prompt deliberately omits, plus what has already run this turn.
 *
 * Listing the calls already made is the prompt-side half of the loop's repeat
 * suppression. On device the planner would decide `list_calendar_events`, read
 * its own result, and — the context still looking exactly like a request to
 * read the calendar — decide it again, five times over. Naming the spent calls
 * right before the decision point is what breaks that symmetry.
 */
export function planNote(
  now: Date,
  calledTools: string[] = [],
  request = '',
): AgentMessage {
  const clock = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
  const spent = [...new Set(calledTools)];
  // The note is a USER message, and once the date table went in it became the
  // longest and most recent user text in the window — so the planner started
  // answering the note instead of the person. "Thanks that is all for now" was
  // met with a web search for "current time", lifted straight out of "It is
  // currently…". Hence both halves of the fix: the clock is labelled as
  // reference material, and the real request is repeated last, right where the
  // decision gets made.
  const asked = request.trim().slice(0, 300);
  return {
    role: 'user',
    content:
      `[Reference, not a request — it is ${clock} on ${weekday}, ${localDate(now)}. ` +
      `${anchors(now)}]\n` +
      (spent.length
        ? `You have already called ${spent.join(' and ')} this turn and the ` +
          `result is above — do not call it again.\n`
        : '') +
      (asked ? `What I actually asked you: "${asked}"\n` : '') +
      `Reply with exactly one JSON object: a tool call, or {"respond": true}.`,
  };
}

/**
 * A lookup table in place of arithmetic.
 *
 * Qwen3 1.7B cannot do clock or calendar maths. On device: "in an hour" at
 * 13:09 came back as 13:09; "6pm today" became 16:00; "Friday at 1pm" landed on
 * Monday at noon. A first attempt at this shipped only "Tomorrow is <date>",
 * which made things worse — it was the single most salient date in the note, so
 * "this week" collapsed to today→tomorrow and stray events landed on tomorrow.
 *
 * The fix is to give every date the model might need, as a list it can copy
 * from, plus the two or three relative clock times people actually say. Copying
 * from a table is the one thing a small model does reliably. This lives in the
 * volatile note, so it costs nothing in KV-cache terms.
 */
function anchors(now: Date): string {
  const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const plus = (minutes: number) => hhmm(new Date(+now + minutes * 60_000));
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = new Date(+now + i * 86_400_000);
    const name = d.toLocaleDateString(undefined, { weekday: 'long' });
    const tag = i === 0 ? 'today' : i === 1 ? 'tomorrow' : name;
    return `${tag} ${localDate(d)}`;
  });
  // The relative times are fenced off behind "only if". Unfenced, they leak:
  // "in an hour 22:59" sitting in the note turned "remind me at 10pm" into
  // 10:59 PM — the same copying that made an earlier "Tomorrow is <date>" line
  // swallow every date range.
  return (
    `Dates: ${days.join(', ')}. This week means ${localDate(now)} to ${localDate(new Date(+now + 6 * 86_400_000))}. ` +
    `Use ONLY if I say "in N minutes/hours": in 30 minutes it is ${plus(30)}, in an hour ${plus(60)}, in three hours ${plus(180)}. ` +
    `If I name a time instead ("at 10pm", "at 7:30"), use exactly that, with minute 0 unless I said a minute.`
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The user's LOCAL calendar date — never `toISOString()`, which is UTC. In
 * IST (+05:30) those disagree between midnight and 05:30, so a UTC date would
 * tell the model it is still yesterday for the first five and a half hours of
 * every day, and every "tomorrow" computed from it would be today.
 */
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * The instruction that turns the final, UNCONSTRAINED generation into a reply
 * to a person. Which branch it takes is a safety property, not a style choice.
 *
 * Branch order is the safety property. A refusal outranks everything: the
 * model must never narrate an action the user just declined. Then failures — a
 * calendar read that threw was once answered with "There are no events in your
 * calendar this week", a failed read presented as an empty one. Only then the
 * ordinary split between something changed and something was looked up.
 */
export type TurnOutcome = {
  /** How many tools returned a result. */
  ran: number;
  /** True if any of them CHANGED something rather than only reporting. */
  acted: boolean;
  /** Error text from tools that threw. */
  failed: string[];
  /** Labels of actions the user refused at the confirmation card. */
  denied: string[];
};

export function answerNote(o: TurnOutcome): AgentMessage {
  // "Address me as you" is not politeness: a scheduled reminder came back as
  // "I reminded the user to call the plumber at 9 PM" — third person, and the
  // wrong verb for something that has not happened yet.
  const open = `Now reply to me directly, in one or two short sentences of plain language. Address me as "you", never as "the user". No JSON, no tool names. `;
  const why = o.failed[0] ? ` The reason was: ${o.failed[0]}` : '';

  // Refusal first, and unconditionally. Observed on device: the user tapped
  // Deny and the reply was "I already scheduled the reminder for 6 pm today."
  // Nothing else this function says matters if a refusal can be narrated as a
  // success, so this branch outranks every other.
  if (o.denied.length) {
    return {
      role: 'user',
      content:
        open +
        `I REFUSED this action: "${o.denied[0]}". It did NOT happen — nothing was ` +
        `created, set, or scheduled. Confirm that you did not do it, and ask what ` +
        `I would like instead. Never say you already did it.`,
    };
  }
  if (o.failed.length && !o.ran) {
    return {
      role: 'user',
      content:
        open +
        `Everything you tried this turn FAILED, so you have no result at all. ` +
        `Say plainly that it did not work and why.${why} Do NOT state an outcome — ` +
        `"nothing found" and "could not look" are different things, and this was ` +
        `the second one.`,
    };
  }
  // A read wants the ANSWER, not a travelogue of the search: the results are
  // already in the context above, and the job is to use them. Observed without
  // this split: "I searched for stretches and found several resources,
  // including articles" — and "The battery WAS at 100%".
  const body = o.acted
    ? `Tell me what you did, in the past tense, with the detail that matters (the time, the title, or how many there were).`
    : o.ran
      ? `Answer my question directly from what the tool returned above: the actual facts, in the present tense. Do not describe your search and do not say you "found some results".`
      // Phrased as an instruction the model can follow rather than one it can
      // repeat: "You did NOT perform any action this turn" came back out as
      // "You didn't need to do anything, and I'm ready to end the conversation."
      : `Just reply to what I said, naturally. You did not do anything on the phone this turn, so do not claim or promise that you did anything or will do anything.`;
  return {
    role: 'user',
    content: o.failed.length ? `${open}${body} Also say which part failed.${why}` : open + body,
  };
}
