// Everything the agent SAYS to the model, in one place.
//
// This used to be interleaved with the orchestration in loop.ts, which made
// both hard to read and the prompt impossible to test on its own. The loop now
// only decides WHEN to speak; this module decides WHAT is said. Pure strings —
// no engine, no Expo — so the whole prompt is asserted in Node.
//
// Two constraints shape the layout:
//   * KV-cache reuse. llama.cpp reprefills from the first byte that differs, and
//     a single turn runs two to five generations against the same context — so
//     the prompt is built in THREE bands, each rewritten less often than the one
//     after it:
//
//       systemPrompt      once a day   identity, catalog, examples, date table
//       turnReference     once a turn  the wall clock and the relative times
//       (decisions/results)            appended as the turn runs
//       planInstruction   every step   the smallest thing that steers a decision
//
//     Only the last band is re-evaluated between planning steps. It was not
//     always this way: the clock, the date table and the echoed request used to
//     be rendered fresh into a note that trailed every planning prompt, so step
//     2 diverged from step 1's cache where step 1's note began and paid for the
//     decision, the result AND a new ~620-character note. `adb logcat` on the
//     test AVD showed single generations re-evaluating 365, 378, 492 and once
//     1079 prompt tokens — about 20 seconds at 65-73 tok/s — to emit five tokens
//     of JSON. eval/appendOnly.test.ts is the specification that keeps the bands
//     separate; eval/promptSize.ts is how it is measured.
//   * The model is 1-2B. It gets a worked transcript for each behaviour we
//     care about, and rules phrased as consequences ("it happens TWICE") rather
//     than as policy.
import type { AgentMessage } from '@/src/engines/types';

import { renderExamples } from './examples';
import type { AnyTool } from './types';

/**
 * Everything an agent turn accumulates BETWEEN the reference block and the
 * answer: the decisions the planner emits and the results the loop feeds back,
 * plus their per-message template wrappers.
 *
 * A bound, not a measurement, because it depends on what the turn does. The
 * figures are loop.ts's own: TURN_RESULT_TOKENS caps results at 320 tokens per
 * turn, and its budget comment allows ~140 more for decisions and wrappers
 * across four steps.
 */
const TOOL_TRAFFIC_TOKENS = 460;

/** ANSWER_MAX_TOKENS in loop.ts — the generated reply the window must hold. */
const ANSWER_TOKENS = 320;

/** Headroom, so a small prompt edit does not silently start evicting history. */
const RESERVE_MARGIN_TOKENS = 64;

/**
 * The same ~3.5 chars/token ruler historyBudget.ts budgets with.
 *
 * NOT promptSize.ts's calibrated 3.85. The reserve and the history budget
 * partition one context window, so they must be measured with the same ruler
 * or the split does not add up; and 3.5 over-states tokens against the 3.70
 * measured for this prompt, which is the safe direction for a reserve — it
 * holds back slightly too much rather than silently evicting the user.
 */
const estimate = (chars: number) => Math.ceil(chars / 3.5);

/** The longest a turn's trailing band can be. A planning step ends with
 *  planInstruction; the answer generation ends with answerNote plus the reply
 *  itself, and that is always the larger of the two. */
function trailingBandTokens(): number {
  const answer = Math.max(
    ...(
      [
        { ran: 0, acted: false, failed: [], denied: ['Set alarm 7:00'] },
        { ran: 0, acted: false, failed: ['the calendar could not be read'], denied: [] },
        { ran: 1, acted: true, failed: [], denied: [] },
        { ran: 1, acted: false, failed: [], denied: [] },
        { ran: 0, acted: false, failed: [], denied: [] },
      ] as TurnOutcome[]
    ).map((o) => estimate(answerNote(o).content.length)),
  );
  return answer + ANSWER_TOKENS;
}

/**
 * Context tokens to hold back for an agent turn, DERIVED from the prompt that
 * will actually be sent.
 *
 * This used to be a hand-tuned constant, and the problem with a constant is
 * that nothing connects it to the thing it is meant to cover. It was set once
 * against a system message that has grown every time a tool or a rule was
 * added — and then the append-only layout moved the seven-day date table INTO
 * that system message, so it grew again in a direction nobody re-measured. By
 * then the static margin was under 100 tokens and the next tool would have
 * failed the build with an assertion about a number, rather than the prompt
 * simply costing what it costs. Deriving it also means every token trimmed out
 * of the prefix turns into conversation history on its own, instead of waiting
 * for someone to notice and edit a second constant.
 *
 * The bands are the ones loop.ts assembles, and the peak is the ANSWER
 * generation — system + history + reference + everything the turn accumulated
 * + the answer note + the reply. A planning step is strictly smaller, because
 * planInstruction is one sentence where the answer band is a note plus 320
 * generated tokens.
 *
 * Under-reserving does not fail loudly: it silently evicts the user's own
 * messages from the front of the history, and `ctx_shift` discards from the
 * FRONT, so an overflow eats the tool catalog while the grammar keeps the
 * output looking well-formed.
 */
export function toolPromptReserve(tools: AnyTool[], now: Date = new Date()): number {
  // A 300-character request, because turnReference slices the echoed request
  // to exactly that and the reserve has to cover the longest one.
  const reference = turnReference(now, 'x'.repeat(300));
  return (
    estimate(systemPrompt(tools, now).length) +
    estimate(reference.content.length) +
    TOOL_TRAFFIC_TOKENS +
    trailingBandTokens() +
    RESERVE_MARGIN_TOKENS
  );
}

/**
 * The ceiling the derived reserve must stay under. A RATCHET on the prefix:
 * prompt.test.ts asserts the real reserve is below it, so growing the prompt
 * past what the app reserves has to be a deliberate act rather than a silent
 * eviction of the user's messages.
 *
 * RAISED from 2816 to 3200, and that is a bug fix rather than a concession.
 * 2816 was hand-tuned against a system message that has since grown twice —
 * once with each tool and rule added, and again when the append-only layout
 * moved the seven-day date table INTO the system prefix. It was no longer
 * covering the turn it was meant to cover. Measured on promptSize.ts's
 * calibrated 3.85 ruler, which is the least conservative one available:
 *
 *   system + reference(300-char request) + answerNote, wrapped  2073 tok
 *   + history 1280 (what 2816 leaves) + traffic 460 + generate 320
 *   = 4133 against nCtx 4096 — an overflow of 37 tokens.
 *
 * That overflow is not soft. `ctx_shift` discards from the FRONT and llama.rn
 * pins `n_keep` at 0, so the first thing evicted is the system prompt: the
 * model goes on emitting well-formed tool calls, chosen by a grammar, from a
 * catalog it can no longer see. loop.ts bounds tool results specifically to
 * keep that unreachable, and a reserve that under-counts by 329 tokens walks
 * straight back into it.
 *
 * The cost is real and belongs on the record: at nCtx 4096 this takes history
 * from 1280 tokens to 951. That is the honest price of the current prefix, and
 * it is the strongest argument for raising nCtx rather than for trimming more
 * teaching out of the prompt.
 */
export const TOOL_PROMPT_RESERVE = 3200;

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
      // `args:` not `arguments:`, and omitted entirely when a tool takes none.
      // Pure rendering, no teaching removed: all 18 tools paid for that word
      // and the three zero-argument tools were rendering a literal `{}`.
      return args ? `- ${t.name}: ${t.description} args: {${args}}` : `- ${t.name}: ${t.description}`;
    })
    .join('\n');
}

/**
 * The stable prefix: identity, the protocol, the tool catalog, the rules, the
 * worked examples, and the seven-day date table.
 *
 * Carries every DATE the turn could need but not the time of day. That split is
 * the whole point: a date table changes once a day, so it costs one re-prefill
 * a day sitting here and one per TURN sitting anywhere else — and the prewarm
 * (see agentPrefix) warms it for free along with the catalog. A clock in here
 * would invalidate the cached prefix on every single turn, which is why the
 * wall clock and the relative times live in turnReference() instead.
 */
export function systemPrompt(tools: AnyTool[], now: Date): string {
  return [
    `You are Whisper, a helpful assistant running fully on the user's phone.`,
    `Today's date is ${localDate(now)}.`,
    ``,
    `Dates (copy from this list, never work one out):`,
    dateAnchors(now),
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
    // A note for the next token-trimming pass, because this block looks like
    // the obvious place to save and three of these rules look like duplicates
    // of a worked example below. They are not. Each is the GENERALISATION over
    // its example: the chaining example is search_contacts→compose_sms, but the
    // corpus also has contacts→dial_number and contacts→compose_email; the
    // empty-result example is an empty calendar read, but web_search and
    // search_phone_media come back empty too. Delete the rule and keep the
    // example and you have kept the enumeration and thrown away the class —
    // which is the same scope error as the pre-bd9a9c6 "do not search THE WEB
    // for something you already know", the one the planner walked around by
    // calling search_contacts instead.
    //
    // This was tried. Removing those three rules left the eval at 79/79 and
    // all five `guarded` scenarios green, and it was still wrong. Replay
    // scripts canned decisions, so the corpus cannot see a planner getting
    // worse; the guards only pin the five specific strings they quote. Neither
    // gate covers this block, so a green run is not permission to cut it.
    `Rules:`,
    `- Promising to do something does NOT do it. Only a tool call does.`,
    `- One call per request. Once a tool has returned, you have its answer —`,
    `  calling it again returns the same thing, and for actions like set_alarm`,
    `  or create_calendar_event it really happens a second time.`,
    `- Call a second tool only when it does something DIFFERENT and necessary,`,
    `  such as looking up a number before texting it.`,
    `- An empty or disappointing result ("No events in that range.") is still`,
    `  the answer. Report it. Do not look again.`,
    `- Never work out a date yourself: copy it from the date list near the top`,
    `  of this message, and never copy one out of these examples. Hours are on a`,
    `  24-hour clock, so 1pm is 13 and 6pm is 18.`,
    `- If no tool does what was asked — there is no way to delete or edit`,
    `  anything — say so plainly. Never substitute a tool that does something`,
    `  else, and never one that does the opposite of what was asked.`,
    // The second half used to read "do not search the web for something you
    // already know", and the planner went around it: asked "what is the capital
    // of France" it called search_contacts, which is not the web. A rule that
    // names one tool only forbids that tool, so this one names the property —
    // a fact you already know — instead of the mechanism.
    `- Do not call a tool to check on something you have just done. Never search`,
    `  ANYTHING — the web, your contacts, your files — for a fact you already`,
    `  know. Looking it up cannot make it more true, and it makes you slower.`,
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
 * The stable head of every agent turn, as its own message list.
 *
 * Exists so the prewarm and the real turn are built by the SAME code: a
 * prewarm that renders even one byte differently warms a prefix llama.cpp
 * will not match, and the failure is silent — the turn is simply as slow as it
 * always was, with nothing to show that the optimization stopped working.
 *
 * That contract now covers the date table too. Warming this prefix costs ~1804
 * prompt tokens and ~28 seconds of wall clock on the test AVD; anything moved
 * INTO it is warmed for free, and anything that renders differently here than
 * it does in the turn throws all 28 seconds away without saying so.
 */
export function agentPrefix(tools: AnyTool[], now: Date = new Date()): AgentMessage[] {
  return [{ role: 'system', content: systemPrompt(tools, now) }];
}

/**
 * The per-turn reference block: the wall clock the system prefix deliberately
 * omits, the relative times computed off it, and the user's own request.
 *
 * Placed ONCE, immediately after the history, and never re-rendered while the
 * turn runs. That position is chosen deliberately and both halves of it matter:
 *
 *   * after the history, not before it, because the history is the LARGEST
 *     stable region in the prompt (up to 1280 tokens — see historyBudget.ts).
 *     A clock rendered ahead of it would move every byte of it on every turn
 *     and force a full re-prefill of the conversation, which is a far bigger
 *     loss than anything this reorganisation wins back.
 *   * once, not per step, because within a turn the clock does not usefully
 *     tick and the request does not change. Everything the loop appends after
 *     this message — decisions, results — then extends the cache instead of
 *     invalidating it.
 *
 * It is a USER message, and it used to be the longest and most recent user text
 * in the window — so the planner started answering IT instead of the person.
 * "Thanks that is all for now" was met with a web search for "current time",
 * lifted straight out of "It is currently…". Both halves of that fix survive
 * here: the clock is labelled as reference material, and the real request is
 * repeated after it. What has changed is that this is no longer the last thing
 * the model reads — planInstruction() is, and it is one sentence long — so the
 * note is materially LESS salient at the decision point than it was when the
 * failure was observed, not more.
 */
export function turnReference(now: Date, request = ''): AgentMessage {
  const clock = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
  const asked = request.trim().slice(0, 300);
  return {
    role: 'user',
    content:
      `[Reference, not a request — it is ${clock} on ${weekday}, ${localDate(now)}. ` +
      `${relativeTimes(now)}]` +
      (asked ? `\nWhat I actually asked you: "${asked}"` : ''),
  };
}

/**
 * The trailing instruction for one planning step, and nothing else.
 *
 * This is the only part of a planning prompt that is rewritten between steps,
 * so every character in it is re-evaluated once per generation at 65-73 tok/s.
 * It is kept to a spent-calls line and one sentence of protocol; the budget is
 * asserted in eval/appendOnly.test.ts.
 *
 * Listing the calls already made is the prompt-side half of the loop's repeat
 * suppression, and it has to be HERE rather than in the reference block because
 * it is the one thing that genuinely changes from step to step. On device the
 * planner would decide `list_calendar_events`, read its own result, and — the
 * context still looking exactly like a request to read the calendar — decide it
 * again, five times over. Naming the spent calls right before the decision
 * point is what breaks that symmetry.
 */
export function planInstruction(calledTools: string[] = []): AgentMessage {
  const spent = [...new Set(calledTools)];
  return {
    role: 'user',
    content:
      (spent.length
        ? `You have already called ${spent.join(' and ')} this turn and the ` +
          `result is above — do not call it again.\n`
        : '') + `Reply with exactly one JSON object: a tool call, or {"respond": true}.`,
  };
}

/**
 * The PRE-append-only layout: one note carrying the clock, the date table, the
 * spent calls, the echoed request and the protocol line, rendered fresh after
 * the history on every planning step.
 *
 * Kept, and exported, for one reason: the eval corpus replays SCRIPTED model
 * responses, so it can prove the new layout is structurally append-only and it
 * cannot prove a real planner still gets dates right when the table moved into
 * the system prefix. That has to be settled by a harness running the real GGUF
 * against real rendered prompts, and such a harness needs BOTH layouts to
 * compare. This is the seam it renders the old one through — nothing in the app
 * calls it, and when the A/B has a verdict it should be deleted.
 *
 * It is composed from the same pieces the live layout uses so the two cannot
 * drift apart on wording while the comparison is still open.
 */
export function legacyPlanNote(
  now: Date,
  calledTools: string[] = [],
  request = '',
): AgentMessage {
  const clock = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
  const spent = [...new Set(calledTools)];
  const asked = request.trim().slice(0, 300);
  return {
    role: 'user',
    content:
      `[Reference, not a request — it is ${clock} on ${weekday}, ${localDate(now)}. ` +
      `Dates: ${dateAnchors(now)} ${relativeTimes(now)}]\n` +
      (spent.length
        ? `You have already called ${spent.join(' and ')} this turn and the ` +
          `result is above — do not call it again.\n`
        : '') +
      (asked ? `What I actually asked you: "${asked}"\n` : '') +
      `Reply with exactly one JSON object: a tool call, or {"respond": true}.`,
  };
}

/**
 * A lookup table in place of arithmetic — the half of it that ticks.
 *
 * Qwen3 1.7B cannot do clock or calendar maths. On device: "in an hour" at
 * 13:09 came back as 13:09; "6pm today" became 16:00; "Friday at 1pm" landed on
 * Monday at noon. The dates are the other half and live in systemPrompt(),
 * because they only change at midnight; these three offsets move with the clock
 * and so cannot.
 *
 * The relative times are fenced off behind "only if". Unfenced, they leak:
 * "in an hour 22:59" sitting in the note turned "remind me at 10pm" into
 * 10:59 PM. The fence and the values it fences stay in the same sentence, and
 * in the same message, for that reason — splitting them to save a few tokens
 * would be saving tokens out of the thing that stops the leak.
 */
function relativeTimes(now: Date): string {
  const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const plus = (minutes: number) => hhmm(new Date(+now + minutes * 60_000));
  return (
    `Use ONLY if I say "in N minutes/hours": in 30 minutes it is ${plus(30)}, in an hour ${plus(60)}, in three hours ${plus(180)}. ` +
    `If I name a time instead ("at 10pm", "at 7:30"), use exactly that, with minute 0 unless I said a minute.`
  );
}

/**
 * Every date a request might name, as a list to copy from.
 *
 * A first attempt at this shipped only "Tomorrow is <date>", which made things
 * WORSE — it was the single most salient date in the prompt, so "this week"
 * collapsed to today→tomorrow and stray events landed on tomorrow. The full
 * table is the fix, and it is a table because copying from one is the single
 * thing a small model does reliably. It is moved here from the per-turn note,
 * not trimmed: every line of it is still rendered.
 */
function dateAnchors(now: Date): string {
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const d = new Date(+now + i * 86_400_000);
    const name = d.toLocaleDateString(undefined, { weekday: 'long' });
    const tag = i === 0 ? 'today' : i === 1 ? 'tomorrow' : name;
    return `${tag} ${localDate(d)}`;
  });
  return (
    `${days.join(', ')}. ` +
    `This week means ${localDate(now)} to ${localDate(new Date(+now + 6 * 86_400_000))}.`
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The user's LOCAL calendar date — never `toISOString()`, which is UTC. In
 * IST (+05:30) those disagree between midnight and 05:30, so a UTC date would
 * tell the model it is still yesterday for the first five and a half hours of
 * every day, and every "tomorrow" computed from it would be today.
 */
export const localDate = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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
