import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { renderExamples, WORKED_EXAMPLES } from './examples';
import {
  answerNote,
  planNote,
  systemPrompt,
  TOOL_PROMPT_RESERVE,
  toolCatalog,
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

  it('leaves room for the rest of the turn inside the context reserve', () => {
    // Measured against the REAL registry, because the catalog grows every time
    // a tool is added and it is most of the prompt. The rest of the turn has to
    // fit alongside it: the planning note (clock, date table, echoed request),
    // the decisions and results the loop appends as it goes, and the capped
    // final answer. Over-running does not fail loudly — it silently evicts the
    // user's own messages from the front of the history.
    const PLAN_NOTE = 150;
    const TOOL_TRAFFIC = 250; // two decisions and their results
    const ANSWER = 320; // ANSWER_MAX_TOKENS in loop.ts
    const system = estimateTokens(systemPrompt(realTools, new Date()).length);
    expect(system + PLAN_NOTE + TOOL_TRAFFIC + ANSWER).toBeLessThan(TOOL_PROMPT_RESERVE);
  });
});

describe('planNote', () => {
  it('carries the wall clock, which the system prefix omits', () => {
    const note = planNote(new Date('2026-08-02T09:30:00Z'), []);
    expect(note.content).toMatch(/Reference, not a request/);
    expect(note.content).toContain('Sunday');
  });

  it('repeats the request last, so the decision sits next to it', () => {
    // The note is a user message; once the date table went in it became the
    // most recent user text and the planner started answering IT — "thanks,
    // that is all" drew a web search for "current time".
    const note = planNote(new Date(), [], 'Set an alarm for 7').content;
    expect(note).toMatch(/Reference, not a request/);
    expect(note.indexOf('What I actually asked you')).toBeGreaterThan(
      note.indexOf('Reference, not a request'),
    );
    expect(note).toContain('"Set an alarm for 7"');
  });

  it('truncates a very long request rather than echoing an essay', () => {
    const note = planNote(new Date(), [], 'x'.repeat(1000)).content;
    expect(note).toContain('x'.repeat(300));
    expect(note).not.toContain('x'.repeat(301));
  });

  it('names the calls already spent this turn', () => {
    const note = planNote(new Date(), ['list_calendar_events']);
    expect(note.content).toContain('already called list_calendar_events');
    expect(note.content).toMatch(/do not call it again/i);
  });

  it('pre-computes the relative clock times people actually say', () => {
    // Observed: at 13:09 the model answered "in an hour" with 13:09 — the
    // current time copied — and its retry moved it a day instead. It should
    // not be doing this arithmetic at all.
    const note = planNote(new Date(2026, 7, 2, 13, 9), []).content;
    expect(note).toContain('in 30 minutes it is 13:39');
    expect(note).toContain('in an hour 14:09');
    expect(note).toContain('in three hours 16:09');
    // Fenced, or the model copies the minutes into "at 10pm" requests.
    expect(note).toMatch(/Use ONLY if I say "in N minutes\/hours"/);
    expect(note).toMatch(/minute 0 unless I said a minute/);
  });

  it('lists every date a request might name, so weekdays are a lookup', () => {
    // "Friday at 1pm" landed on Monday when the model had to work the date out
    // for itself. Sunday 2026-08-02 → Friday is 2026-08-07.
    const note = planNote(new Date(2026, 7, 2, 13, 9), []).content;
    expect(note).toContain('today 2026-08-02');
    expect(note).toContain('tomorrow 2026-08-03');
    expect(note).toContain('Friday 2026-08-07');
    expect(note).toContain('This week means 2026-08-02 to 2026-08-08');
  });

  it('rolls the clock past midnight in local time, not UTC', () => {
    // The tools build a Date from these in the phone's zone; a UTC instant
    // would shift every reminder by the offset (5.5h where this was written).
    const note = planNote(new Date(2026, 7, 2, 23, 30), []).content;
    expect(note).toContain('in an hour 00:30');
    expect(note).toContain('tomorrow 2026-08-03');
  });

  it('says nothing about spent calls on the first decision', () => {
    expect(planNote(new Date(), []).content).not.toMatch(/already called/);
  });

  it('mentions a repeated tool once', () => {
    const note = planNote(new Date(), ['echo', 'echo']);
    expect(note.content.match(/echo/g)).toHaveLength(1);
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

