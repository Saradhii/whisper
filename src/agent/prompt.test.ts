import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { renderExamples, WORKED_EXAMPLES } from './examples';
import {
  answerNote,
  legacyPlanNote,
  localDate,
  planInstruction,
  systemPrompt,
  TOOL_PROMPT_RESERVE,
  toolCatalog,
  toolPromptReserve,
  turnReference,
} from './prompt';
import { TOOL_DEFS } from './toolDefs';
import { defineTool, paramsToJsonSchema, type AnyTool } from './types';

/** ~3.5 chars per token, the same estimate historyBudget.ts uses. */
const estimateTokens = (chars: number) => Math.ceil(chars / 3.5);

const tool = (name: string, params: z.ZodObject<z.ZodRawShape> = z.object({})): AnyTool =>
  defineTool({
    name,
    description: `does ${name}`,
    params,
    label: () => name,
    execute: async () => 'ok',
  });

/** Every declared tool, built straight from the pure declarations — no Expo,
 *  so the shipped catalog is measurable in Node. */
const realTools: AnyTool[] = Object.entries(TOOL_DEFS).map(([name, d]) => ({
  name,
  description: d.description,
  jsonSchema: paramsToJsonSchema(d.params),
  label: () => name,
  run: async () => '',
}));

describe('toolCatalog', () => {
  it('shows each argument description to the model', () => {
    // These were silently dropped for the whole of the first pass: the hint
    // that 6pm is hour 18, and that the minute is 0 unless asked for, were
    // written and tested but never rendered, and the model kept guessing.
    const line = toolCatalog(realTools);
    expect(line).toContain('1pm is 13 and 6pm is 18');
    expect(line).toContain('0 unless a specific minute was asked for');
    expect(line).toContain('YYYY-MM-DD');
  });

  it('marks optional arguments with ?', () => {
    const line = toolCatalog([
      tool('ping', z.object({ host: z.string(), port: z.number().optional() })),
    ]);
    expect(line).toContain('host: string');
    expect(line).toContain('port?: number');
  });
});

describe('systemPrompt', () => {
  it('carries the date but never the time of day', () => {
    // A clock in the system message would change the cached prefix every turn
    // and force llama.cpp to re-prefill the whole thing.
    const text = systemPrompt(realTools, new Date('2026-08-02T12:42:00Z'));
    expect(text).toContain('2026-08-02');
    expect(text).not.toMatch(/12:42/);
  });

  it('lists every registered tool', () => {
    const text = systemPrompt(realTools, new Date());
    for (const t of realTools) expect(text).toContain(t.name);
  });

  it('states the one-call rule the repeat bug came from', () => {
    expect(systemPrompt(realTools, new Date())).toMatch(/calling it again returns the same thing/i);
  });
});

describe('worked examples', () => {
  it('renders in the same message shape the loop feeds back', () => {
    // The example transcript and the live conversation have to be one
    // continuous pattern, or the model is being shown a format it never sees.
    const text = renderExamples(realTools);
    expect(text).toContain('Result of set_alarm: Alarm set for 7:00.');
    expect(text).toContain('{"respond": true}');
  });

  it('ends every example with a decision to respond', () => {
    for (const ex of WORKED_EXAMPLES) {
      const rendered = renderExamples(realTools);
      if (!ex.tools.every((t) => realTools.some((a) => a.name === t))) continue;
      expect(rendered).toContain(ex.user);
    }
    // One respond per included example, and never two in a row.
    const responds = renderExamples(realTools).match(/\{"respond": true\}/g) ?? [];
    expect(responds).toHaveLength(WORKED_EXAMPLES.length);
  });

  it('hides examples whose tools are not registered', () => {
    // iOS has no set_alarm: demonstrating it would invite the model to call a
    // tool that is not in the catalog.
    const withoutAlarm = realTools.filter((t) => t.name !== 'set_alarm');
    expect(renderExamples(withoutAlarm)).not.toContain('set_alarm');
    expect(renderExamples(withoutAlarm)).toContain('list_calendar_events');
  });

  it('only calls tools it declares', () => {
    for (const ex of WORKED_EXAMPLES) {
      for (const step of ex.steps) {
        const name = /"tool": "([^"]+)"/.exec(step.call)?.[1];
        expect(ex.tools).toContain(name);
      }
    }
  });

  it('teaches chaining as well as stopping', () => {
    // Stop-after-one is the lesson; without a counterexample it overfits into
    // "never call a second tool", which breaks look-up-then-act requests.
    expect(WORKED_EXAMPLES.some((ex) => ex.steps.length > 1)).toBe(true);
  });

  it('keeps the derived reserve under its historical ceiling', () => {
    // Measured against the REAL registry, because the catalog grows every time
    // a tool is added and it is most of the prompt. The reserve now DERIVES
    // itself from that prompt (see toolPromptReserve), so this is no longer
    // "does the hand-tuned number still fit" — it is a ratchet on the prefix.
    // A prompt edit that pushes the reserve past what the app used to reserve
    // statically has taken conversation history away from the user, and should
    // have to be a deliberate act.
    //
    // If this fails: shrink the prefix, or raise the ceiling ONLY with a
    // decision recorded about the history the user loses in exchange.
    expect(toolPromptReserve(realTools, new Date())).toBeLessThanOrEqual(
      TOOL_PROMPT_RESERVE,
    );
  });

  it('spends the reserve on the prompt rather than on slack', () => {
    // The other direction, and why the ceiling is a ratchet and not a target:
    // a reserve far BELOW it means the app holds back context it does not need
    // and trims the user's messages for nothing. nCtx - reserve is the
    // conversation the user actually gets to keep.
    const reserve = toolPromptReserve(realTools, new Date());
    expect(reserve).toBeGreaterThan(
      estimateTokens(systemPrompt(realTools, new Date()).length),
    );
    expect(TOOL_PROMPT_RESERVE - reserve).toBeLessThan(400);
  });
});

describe('the date table', () => {
  // The table used to be rendered into the per-turn note. It moved into the
  // system prefix because it changes once a DAY and was costing a re-prefill
  // once a TURN — but it MOVED, it was not trimmed, so every assertion that
  // was written against it still has to hold.

  it('lists every date a request might name, so weekdays are a lookup', () => {
    // "Friday at 1pm" landed on Monday when the model had to work the date out
    // for itself. Sunday 2026-08-02 → Friday is 2026-08-07.
    const text = systemPrompt(realTools, new Date(2026, 7, 2, 13, 9));
    expect(text).toContain('today 2026-08-02');
    expect(text).toContain('tomorrow 2026-08-03');
    expect(text).toContain('Friday 2026-08-07');
    expect(text).toContain('This week means 2026-08-02 to 2026-08-08');
  });

  it('keeps all seven days, never just tomorrow', () => {
    // A first attempt shipped only "Tomorrow is <date>" and made things worse:
    // it was the single most salient date, so "this week" collapsed to
    // today→tomorrow. Seven entries, or the failure comes back.
    const text = systemPrompt(realTools, new Date(2026, 7, 2, 13, 9));
    const dates = text.match(/2026-08-0[2-8]/g) ?? [];
    expect(new Set(dates).size).toBe(7);
  });

  it('points the model at the table rather than at arithmetic', () => {
    const text = systemPrompt(realTools, new Date());
    expect(text).toMatch(/Never work out a date yourself/);
    expect(text).toMatch(/copy it from the date list/);
  });

  it('rolls to local dates, not UTC ones', () => {
    // The tools build a Date from these in the phone's zone; a UTC instant
    // would shift every reminder by the offset (5.5h where this was written).
    const text = systemPrompt(realTools, new Date(2026, 7, 2, 23, 30));
    expect(text).toContain('today 2026-08-02');
    expect(text).toContain('tomorrow 2026-08-03');
  });
});

describe('turnReference', () => {
  it('carries the wall clock, which the system prefix omits', () => {
    const note = turnReference(new Date('2026-08-02T09:30:00Z'));
    expect(note.content).toMatch(/Reference, not a request/);
    expect(note.content).toContain('Sunday');
  });

  it('repeats the request after the reference block', () => {
    // The block is a user message; once the date table went in it became the
    // most recent user text and the planner started answering IT — "thanks,
    // that is all" drew a web search for "current time". The request is
    // restated after the clock so the decision sits next to what was asked.
    const note = turnReference(new Date(), 'Set an alarm for 7').content;
    expect(note).toMatch(/Reference, not a request/);
    expect(note.indexOf('What I actually asked you')).toBeGreaterThan(
      note.indexOf('Reference, not a request'),
    );
    expect(note).toContain('"Set an alarm for 7"');
  });

  it('truncates a very long request rather than echoing an essay', () => {
    const note = turnReference(new Date(), 'x'.repeat(1000)).content;
    expect(note).toContain('x'.repeat(300));
    expect(note).not.toContain('x'.repeat(301));
  });

  it('pre-computes the relative clock times people actually say', () => {
    // Observed: at 13:09 the model answered "in an hour" with 13:09 — the
    // current time copied — and its retry moved it a day instead. It should
    // not be doing this arithmetic at all.
    const note = turnReference(new Date(2026, 7, 2, 13, 9)).content;
    expect(note).toContain('in 30 minutes it is 13:39');
    expect(note).toContain('in an hour 14:09');
    expect(note).toContain('in three hours 16:09');
    // Fenced, or the model copies the minutes into "at 10pm" requests. The
    // fence and the values it fences must stay in the SAME message: splitting
    // them is how "remind me at 10pm" became 10:59 PM.
    expect(note).toMatch(/Use ONLY if I say "in N minutes\/hours"/);
    expect(note).toMatch(/minute 0 unless I said a minute/);
  });

  it('rolls the clock past midnight in local time, not UTC', () => {
    expect(turnReference(new Date(2026, 7, 2, 23, 30)).content).toContain('in an hour 00:30');
  });

  it('never carries the date table, which the system prefix now owns', () => {
    // Rendering it in both places would pay for it once a turn AND once a day,
    // which is strictly worse than either — and would give the model two copies
    // to disagree about.
    expect(turnReference(new Date(2026, 7, 2, 13, 9)).content).not.toContain('Friday 2026-08-07');
  });
});

describe('planInstruction', () => {
  it('names the calls already spent this turn', () => {
    const note = planInstruction(['list_calendar_events']);
    expect(note.content).toContain('already called list_calendar_events');
    expect(note.content).toMatch(/do not call it again/i);
  });

  it('says nothing about spent calls on the first decision', () => {
    expect(planInstruction([]).content).not.toMatch(/already called/);
  });

  it('mentions a repeated tool once', () => {
    expect(planInstruction(['echo', 'echo']).content.match(/echo/g)).toHaveLength(1);
  });

  it('stays inside the volatile-tail budget', () => {
    // Re-evaluated by llama.cpp once per planning generation at 65-73 tok/s, so
    // this is a latency ceiling and not a style rule. 231 chars ≈ 60 estimated
    // tokens; eval/appendOnly.test.ts asserts the same bound end-to-end.
    expect(planInstruction([]).content.length).toBeLessThanOrEqual(231);
    expect(planInstruction(['list_calendar_events']).content.length).toBeLessThanOrEqual(231);
  });

  it('carries no clock, no dates and no echoed request', () => {
    // Everything that is stable for the whole turn belongs in turnReference,
    // which is rendered once. Anything that leaks back in here is paid again on
    // every planning step.
    const note = planInstruction(['echo']).content;
    expect(note).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(note).not.toMatch(/Reference, not a request/);
    expect(note).not.toMatch(/What I actually asked you/);
  });
});

describe('legacyPlanNote', () => {
  // The comparison seam. The corpus replays scripted responses, so it proves
  // the new layout is append-only and proves nothing about whether a real
  // planner still reads a date table that moved into the system prefix. That
  // needs a harness running the real GGUF over both layouts, and this is how it
  // renders the old one.

  it('reproduces the layout the restructure replaced, byte for byte', () => {
    expect(legacyPlanNote(new Date(2026, 7, 2, 13, 9), ['echo'], 'Set an alarm for 7').content)
      .toBe(
        '[Reference, not a request — it is 01:09 pm on Sunday, 2026-08-02. ' +
          'Dates: today 2026-08-02, tomorrow 2026-08-03, Tuesday 2026-08-04, ' +
          'Wednesday 2026-08-05, Thursday 2026-08-06, Friday 2026-08-07, ' +
          'Saturday 2026-08-08. This week means 2026-08-02 to 2026-08-08. ' +
          'Use ONLY if I say "in N minutes/hours": in 30 minutes it is 13:39, ' +
          'in an hour 14:09, in three hours 16:09. If I name a time instead ' +
          '("at 10pm", "at 7:30"), use exactly that, with minute 0 unless I said a minute.]\n' +
          'You have already called echo this turn and the result is above — do not call it again.\n' +
          'What I actually asked you: "Set an alarm for 7"\n' +
          'Reply with exactly one JSON object: a tool call, or {"respond": true}.',
      );
  });

  it('says nothing the new three-band layout does not also say', () => {
    // The restructure MOVED text between bands; it did not drop any. Anything
    // the old note told the model must still reach it, or this is a behaviour
    // change wearing a latency change's clothes.
    const at = new Date(2026, 7, 2, 13, 9);
    const old = legacyPlanNote(at, ['echo'], 'Set an alarm for 7').content;
    const now =
      systemPrompt(realTools, at) +
      '\n' +
      turnReference(at, 'Set an alarm for 7').content +
      '\n' +
      planInstruction(['echo']).content;
    // Sentence-level, because the pieces were re-punctuated when they split.
    for (const fragment of old.split(/(?<=\.)\s+|\n/).filter((s) => s.trim().length > 12)) {
      expect(now, `the new layout lost: ${fragment}`).toContain(
        fragment.replace(/^\[|\]$/g, '').replace(/^Dates: /, ''),
      );
    }
  });
});

describe('answerNote', () => {
  const outcome = (o: Partial<Parameters<typeof answerNote>[0]> = {}) =>
    answerNote({ ran: 0, acted: false, failed: [], denied: [], ...o }).content;

  it('asks for past tense when something was changed', () => {
    expect(outcome({ ran: 1, acted: true })).toMatch(/past tense/);
  });

  it('asks a read to answer the question, not narrate the search', () => {
    // Observed: "I searched for stretches and found several resources,
    // including articles" — the results were in context and went unused.
    const note = outcome({ ran: 1, acted: false });
    expect(note).toMatch(/Answer my question directly/);
    expect(note).toMatch(/present tense/);
    expect(note).not.toMatch(/past tense/);
  });

  it('forbids claiming an action when nothing ran', () => {
    expect(outcome()).toMatch(/do not claim or promise/);
  });

  it('forbids inventing a result when every call failed', () => {
    const note = outcome({ failed: ['Permission for calendar was denied by the user.'] });
    expect(note).toMatch(/FAILED/);
    expect(note).toContain('Permission for calendar was denied');
    expect(note).toMatch(/Do NOT state an outcome/);
  });

  it('reports a partial failure alongside what did work', () => {
    const note = outcome({ ran: 1, acted: true, failed: ['the network was unreachable'] });
    expect(note).toMatch(/past tense/);
    expect(note).toMatch(/which part failed/);
  });

  it('never lets a refused action be narrated as done', () => {
    // The worst thing observed on device: the user tapped Deny and the reply
    // was "I already scheduled the reminder for 6 pm today."
    const note = outcome({ denied: ['Remind “Call the plumber” · Sun, Aug 2, 4:00 PM'] });
    expect(note).toMatch(/REFUSED/);
    expect(note).toMatch(/did NOT happen/);
    expect(note).toMatch(/Never say you already did it/);
  });

  it('puts the refusal ahead of every other branch', () => {
    // A denial alongside a successful read must still lead with the refusal.
    const note = outcome({ ran: 1, acted: true, failed: ['boom'], denied: ['Set alarm 7:00'] });
    expect(note).toMatch(/REFUSED/);
    expect(note).not.toMatch(/past tense/);
  });

  it('always bans JSON in the reply', () => {
    for (const n of [
      outcome({ ran: 1, acted: true }),
      outcome({ ran: 1 }),
      outcome(),
      outcome({ failed: ['x'] }),
      outcome({ denied: ['x'] }),
    ]) {
      expect(n).toMatch(/No JSON/);
    }
  });
});


describe('localDate', () => {
  // Regression: the plain-chat path in app/index.tsx used
  // `now.toISOString().slice(0, 10)`, which is UTC. East of Greenwich the UTC
  // date is still yesterday for the first hours of every local day — in IST
  // (+05:30), until 05:30 — so the model was told the wrong date every night.
  // Constructed from LOCAL components so the assertion holds in any timezone.
  it('reports the local calendar date, not the UTC one', () => {
    // 00:30 local: east of UTC this instant is still the previous UTC day.
    expect(localDate(new Date(2026, 8, 5, 0, 30))).toBe('2026-09-05');
    // 23:30 local: west of UTC this instant is already the next UTC day.
    expect(localDate(new Date(2026, 8, 5, 23, 30))).toBe('2026-09-05');
  });

  it('zero-pads month and day', () => {
    expect(localDate(new Date(2026, 0, 3))).toBe('2026-01-03');
  });
});

describe('stable prefix', () => {
  // The prewarm (app/index.tsx) renders agentPrefix(TOOLS) at load time; the
  // turn (loop.ts) renders agentPrefix(tools, now) when the user sends. They
  // are the same function, so they agree — but ONLY if the system message
  // contains nothing that ticks faster than the value they can disagree about.
  //
  // That invariant is what the whole prewarm and the on-disk prefix KV snapshot
  // rest on, and prompt.ts warns that breaking it fails SILENTLY: the prefix is
  // simply never matched again, the turn is as slow as it always was, and
  // nothing says the optimization stopped working. A clock, a seconds field, or
  // anything derived from Date.now() landing in systemPrompt() would do it.
  //
  // So: the system message must be byte-identical for any two instants on the
  // same calendar day, and must differ across days (the date table is real).
  it('is byte-identical across a whole day, so a prewarm still matches the turn', () => {
    const justAfterMidnight = new Date(2026, 8, 5, 0, 0, 1);
    const midMorning = new Date(2026, 8, 5, 9, 41, 17);
    const justBeforeMidnight = new Date(2026, 8, 5, 23, 59, 59);
    const a = systemPrompt(realTools, justAfterMidnight);
    expect(systemPrompt(realTools, midMorning)).toBe(a);
    expect(systemPrompt(realTools, justBeforeMidnight)).toBe(a);
  });

  it('does change across days, so the date table is genuinely live', () => {
    const today = systemPrompt(realTools, new Date(2026, 8, 5, 12, 0));
    const tomorrow = systemPrompt(realTools, new Date(2026, 8, 6, 12, 0));
    expect(tomorrow).not.toBe(today);
  });

  // The volatile half is allowed — indeed required — to tick, and it lives
  // after the cached region precisely so it can.
  it('keeps the ticking clock OUT of the stable prefix and IN the turn note', () => {
    const t1 = new Date(2026, 8, 5, 9, 0);
    const t2 = new Date(2026, 8, 5, 17, 30);
    expect(turnReference(t1, 'hello').content).not.toBe(turnReference(t2, 'hello').content);
  });
});
