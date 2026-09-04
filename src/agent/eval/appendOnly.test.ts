import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runAgent, type AgentEvent } from '@/src/agent/loop';
import {
  answerNote,
  legacyPlanNote,
  planInstruction,
  systemPrompt,
  turnReference,
} from '@/src/agent/prompt';
import { TOOL_DEFS } from '@/src/agent/toolDefs';
import { defineTool, paramsToJsonSchema, type AnyTool } from '@/src/agent/types';
import type { AgentMessage, ChatMessage, Engine } from '@/src/engines/types';

import { divergence, formatSize, MESSAGE_TEMPLATE_CHARS, promptSize } from './promptSize';

// ---------------------------------------------------------------------------
// Machinery
// ---------------------------------------------------------------------------

/** Every prompt the loop handed the engine, in order, deep-copied. */
type Capture = { messages: AgentMessage[]; planning: boolean };

function capturingEngine(script: string[]) {
  const seen: Capture[] = [];
  let i = 0;
  const engine: Engine = {
    load: async () => {},
    stop: async () => {},
    unload: async () => {},
    generate: async (messages, onToken, opts) => {
      seen.push({
        messages: JSON.parse(JSON.stringify(messages)) as AgentMessage[],
        planning: !!opts?.grammar,
      });
      const text = script[Math.min(i++, script.length - 1)] ?? '';
      if (!opts?.grammar && text) onToken(text);
      return { text, toolCalls: [] };
    },
  };
  return { engine, seen };
}

/** A read-only tool whose result is a realistic size for the turn budget. */
const probe = (name: string, result: string): AnyTool =>
  defineTool({
    name,
    description: `looks ${name} up`,
    params: z.object({ q: z.string() }),
    label: (a) => `${name} ${a.q}`,
    execute: async () => result,
  });

const TOOLS = [
  probe('look_a', 'A returned: the 4pm Intoglo tech sync on Thursday, and nothing else this week.'),
  probe('look_b', 'B returned: Arun Menon, +91 98450 12345, arun@example.com.'),
  probe('look_c', 'C returned: 24 degrees and clear, with rain expected after 9pm.'),
  // A web_fetch-sized result: longer than the turn budget, so the loop clamps
  // it to TURN_RESULT_TOKENS * CHARS_PER_TOKEN = 960 characters. This is the
  // WORST realistic single message, and it exists here because the biggest
  // rebuilt term on a tool turn is the result payload, not any note.
  probe('look_big', `The page said: ${'lorem ipsum dolor sit amet consectetur. '.repeat(120)}`),
];

/** The shipped registry, built from the pure declarations. Used only to size
 *  the system prompt honestly: three fake tools would under-state it by ~4000
 *  characters and make the composition table a fiction. */
const REAL_TOOLS: AnyTool[] = Object.entries(TOOL_DEFS).map(([name, d]) => ({
  name,
  description: d.description,
  jsonSchema: paramsToJsonSchema(d.params),
  label: () => name,
  run: async () => '',
}));

const call = (tool: string, q: string) => JSON.stringify({ tool, arguments: { q } });
const RESPOND = '{"respond": true}';

const NOW = new Date(2026, 8, 5, 13, 9);

/** A history long enough to be realistic — a real turn carries a few hundred
 *  tokens of conversation, and the whole question is what sits AFTER it. */
const HISTORY: ChatMessage[] = [
  { role: 'user', content: 'can you help me plan my week' },
  { role: 'assistant', content: 'Of course. Tell me what you have on and I will pull it together.' },
  { role: 'user', content: 'what is on my calendar this week and who is arun' },
];

/** Run a turn and return every prompt the engine saw. */
async function runTurn(script: string[]): Promise<Capture[]> {
  const { engine, seen } = capturingEngine(script);
  const events: AgentEvent[] = [];
  await runAgent(
    engine,
    TOOLS,
    HISTORY,
    { onEvent: (e) => events.push(e), confirm: async () => true },
    NOW,
  );
  return seen;
}

/** N tool calls, then respond, then answer. N=0 is the no-tool turn. */
function turnOf(steps: number): string[] {
  const names = ['look_a', 'look_b', 'look_c'];
  return [
    ...names.slice(0, steps).map((n) => call(n, 'x')),
    RESPOND,
    'Here is what I found for you.',
  ];
}

/**
 * The re-evaluated size of each generation, given the one before it left its
 * prompt in the KV cache. The first generation of a turn is measured against
 * the stable prefix a warm app is already holding — the prewarm leaves the
 * system message cached, so that is what the turn starts from.
 */
function reEvaluated(prompts: AgentMessage[][]): number[] {
  const prefix = prompts[0]!.slice(0, 1); // the system message, prewarmed
  return prompts.map(
    (p, i) => divergence(i === 0 ? prefix : prompts[i - 1]!, p).reEvaluatedChars,
  );
}

/**
 * The same generation as it would have been rendered by the layout this
 * replaced: no reference block, and one fat note after the accumulated traffic.
 *
 * Reconstructed from the captured prompt rather than kept as a second code path
 * in the loop, so the "before" column of the table is always the layout that
 * actually shipped and not a description of it.
 */
function asLegacy(capture: Capture): AgentMessage[] {
  const m = capture.messages;
  const head = m.slice(0, 1 + HISTORY.length); // system + history
  const traffic = m.slice(1 + HISTORY.length + 1, -1); // minus turnReference and the tail
  if (!capture.planning) return [...head, ...traffic, m[m.length - 1]!]; // answerNote is unmoved
  const called = traffic
    .map((t) => /^Result of (\w+):/.exec(t.content)?.[1])
    .filter((n): n is string => !!n);
  return [...head, ...traffic, legacyPlanNote(NOW, called, HISTORY[HISTORY.length - 1]!.content)];
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

/**
 * The trailing instruction is the ONLY thing a planning prompt is allowed to
 * rewrite between generations. 60 estimated tokens is 231 characters; the tail
 * as built is a spent-calls line plus one sentence of protocol.
 *
 * This is a ceiling on a latency cost, not a style rule. Every character here
 * is re-evaluated by llama.cpp once per planning generation, at 65-73 tok/s.
 */
const PLAN_TAIL_BUDGET_CHARS = 231;

/**
 * The answer note is bigger because it branches on what the turn did, and it is
 * paid exactly once per turn rather than once per step. Pinned so it cannot
 * quietly grow into the thing the plan tail was cut down from.
 */
const ANSWER_TAIL_BUDGET_CHARS = 600;

describe('the turn is append-only', () => {
  /**
   * THE SPECIFICATION.
   *
   * Within a turn every successive prompt must be the previous one with the
   * trailing instruction swapped and new messages appended after it. Nothing
   * before that point may change — not the clock, not the date table, not the
   * echoed request.
   *
   * The failure this pins, measured on device before the fix: a planning step
   * rendered a fresh ~600-char note AFTER the history, so step 2 diverged from
   * step 1's cache at the position where step 1's note began and re-evaluated
   * the decision, the result and a whole new note. A three-generation turn paid
   * that tail three times over. `adb logcat` showed single generations
   * re-evaluating 365, 378, 492 and once 1079 prompt tokens — about 20 seconds
   * — to produce a five-token JSON decision.
   */
  for (const steps of [0, 1, 2, 3]) {
    it(`keeps the divergence point moving forward across a ${steps}-step turn`, async () => {
      const seen = await runTurn(turnOf(steps));
      expect(seen.length).toBe(steps + 2); // one plan per step, a final plan, an answer

      for (let i = 1; i < seen.length; i++) {
        const prev = seen[i - 1]!.messages;
        const next = seen[i]!.messages;

        // Everything the previous prompt held EXCEPT its trailing instruction
        // must survive verbatim into this one. This is the whole property: the
        // cache grows, it is never invalidated.
        const stable = prev.slice(0, -1);
        const d = divergence(stable, next);
        expect(
          d.appendOnly,
          `generation ${i} rewrote history: it shares only ${d.sharedMessages} of ` +
            `${stable.length} messages with the generation before it, forcing ` +
            `${formatSize(d.reEvaluatedChars)} of re-prefill`,
        ).toBe(true);

        // …and the divergence never walks backwards.
        const back = divergence(prev, next);
        expect(back.sharedChars).toBeGreaterThanOrEqual(
          promptSize(stable).chars,
        );
      }
    });
  }

  it('bounds the volatile tail of every planning prompt', async () => {
    const seen = await runTurn(turnOf(3));
    for (const [i, s] of seen.entries()) {
      const tail = s.messages[s.messages.length - 1]!;
      const budget = s.planning ? PLAN_TAIL_BUDGET_CHARS : ANSWER_TAIL_BUDGET_CHARS;
      expect(
        tail.content.length,
        `generation ${i} (${s.planning ? 'plan' : 'answer'}) trails ` +
          `${formatSize(tail.content.length)}, over its ${budget}-char budget:\n${tail.content}`,
      ).toBeLessThanOrEqual(budget);
    }
  });

  it('prints the before/after re-evaluated cost of a turn, by step count', async () => {
    // Printed unconditionally, the way corpus.test.ts prints its score table:
    // this is the number the whole restructure exists to move, and it should be
    // readable without deliberately breaking something to see it. Both columns
    // are RENDERED, not recalled — the "before" one comes from legacyPlanNote(),
    // which reproduces the replaced layout byte for byte (prompt.test.ts pins
    // that), so this table cannot go stale the way a figure in a report does.
    const lines: string[] = [
      '',
      '  re-evaluated per generation, warm app (system prefix cached)',
      '  turn                gens  before                          after',
    ];
    const cases: [string, string[]][] = [
      ['0-tool turn', turnOf(0)],
      ['1-tool turn', turnOf(1)],
      ['2-tool turn', turnOf(2)],
      ['3-tool turn', turnOf(3)],
      // The result payload, not any note, is the biggest single message on a
      // tool turn. This one is clamped to 960 characters by the loop, which is
      // ~250 real Qwen3 tokens — more than twice the note it replaced. Every
      // layout pays it exactly once; it is the floor, not the waste.
      ['1-tool, 960c result', [call('look_big', 'x'), RESPOND, 'Here is the gist.']],
    ];
    for (const [label, script] of cases) {
      const seen = await runTurn(script);
      const after = reEvaluated(seen.map((s) => s.messages));
      const before = reEvaluated(seen.map(asLegacy));
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const cells = (xs: number[]) => xs.map((c) => String(c).padStart(4)).join(' ').padEnd(24);
      lines.push(
        `  ${label.padEnd(19)} ${String(seen.length).padStart(4)}  ` +
          `${cells(before)} =${String(sum(before)).padStart(5)}   ` +
          `${cells(after)} =${String(sum(after)).padStart(5)}   ` +
          `${(100 - (sum(after) / sum(before)) * 100).toFixed(0)}% less`,
      );
    }

    // Where the tail actually goes. The campaign brief estimated the volatile
    // tail at ~286 tokens and a logcat reading inferred ~720; neither survives
    // being rendered, so the composition is printed rather than recited.
    const at = NOW;
    lines.push('', '  composition of one turn (the real 18-tool catalog)');
    for (const [label, text] of [
      ['systemPrompt (once a day)', systemPrompt(REAL_TOOLS, at)],
      ['turnReference (once a turn)', turnReference(at, HISTORY[2]!.content).content],
      ['planInstruction (per step, first)', planInstruction([]).content],
      ['planInstruction (per step, spent)', planInstruction(['look_a']).content],
      ['answerNote (once a turn)', answerNote({ ran: 1, acted: false, failed: [], denied: [] }).content],
      ['legacyPlanNote (per step, was)', legacyPlanNote(at, ['look_a'], HISTORY[2]!.content).content],
      ['chat-template wrapper, per message', ' '.repeat(MESSAGE_TEMPLATE_CHARS)],
    ] as const) {
      lines.push(`  ${label.padEnd(36)}${formatSize(text.length)}`);
    }
    console.log([...lines, ''].join('\n'));
    // Deliberately not an assertion. This block is a REPORTING device — it
    // prints the table the restructure is judged by, the way corpus.test.ts
    // prints its score table, so the numbers are readable without having to
    // break something to see them. The real ratchets are the other tests in
    // this file: the append-only property, the plan/answer prefix sharing, the
    // legacy comparison, and the tail-size bound.
    //
    // Two things follow. Do NOT "fix" this into an assertion on the printed
    // figures — they move with every legitimate prompt edit and would redden
    // the build for no defect. And do not read the table as verified: nothing
    // here fails if those numbers regress, so a regression surfaces as a worse
    // number somebody has to notice, not as a failing test.
    expect(true).toBe(true);
  });

  it('pays only genuinely new content when a turn ends on a suppressed repeat', async () => {
    // The one shape where the answer prompt is NOT an extension of the last
    // planning prompt: the planner repeats a call, repeat suppression returns
    // 'exhausted', the loop breaks WITHOUT a final {"respond": true}, and the
    // answer prompt therefore has a decision and a result where the plan prompt
    // had its trailing instruction.
    //
    // This layout does not fix that, and it does not need to: what the answer
    // re-evaluates there is the decision, the result and the answer note — all
    // three genuinely new, none of them ever cached. Discarding a trailing
    // instruction costs nothing; only evaluating tokens costs anything. The
    // measurement below is the proof, and it is why "the answer phase throws
    // away the tail the plan phase built" is the wrong way to read a cache log.
    const decision = call('look_a', 'x');
    const seen = await runTurn([decision, decision, 'Same as before.']);
    expect(seen).toHaveLength(3);
    expect(seen[2]!.planning).toBe(false);

    const plan = seen[1]!.messages;
    const answer = seen[2]!.messages;

    // The messages the two prompts genuinely share, and the ones that are new.
    let same = 0;
    while (
      same < plan.length &&
      same < answer.length &&
      plan[same]!.role === answer[same]!.role &&
      plan[same]!.content === answer[same]!.content
    ) same++;
    const fresh = promptSize(answer).chars - promptSize(answer.slice(0, same)).chars;

    // Only the trailing instruction is dropped, and everything re-evaluated is
    // a message this prompt is the first to carry. Nothing cached is rebuilt.
    expect(plan.slice(0, same)).toEqual(answer.slice(0, same));
    expect(plan.length - same).toBe(1); // the planInstruction, and nothing else
    const d = divergence(plan, answer);
    expect(d.reEvaluatedChars).toBeLessThanOrEqual(fresh);

    // And the legacy layout paid the same here — the fix is in the planning
    // steps, not this one, which is why "the answer phase throws away the tail
    // the plan phase built" is the wrong way to read a cache log.
    const legacy = divergence(asLegacy(seen[1]!), asLegacy(seen[2]!)).reEvaluatedChars;
    expect(Math.abs(legacy - d.reEvaluatedChars)).toBeLessThanOrEqual(
      MESSAGE_TEMPLATE_CHARS,
    );
  });

  it('carries the cache across a turn boundary, not just within one', async () => {
    // The realistic warm case, and the one device logs actually sample: turn 2
    // of a conversation, against a KV cache holding everything turn 1 left. The
    // new exchange (turn 1's answer, turn 2's question) is genuinely new and
    // must be paid for; nothing before it should be.
    //
    // Note what this costs and why it is still the right trade: the reference
    // block sits after the history, so turn 2 re-evaluates it. Putting it
    // BEFORE the history would save that and invalidate the whole conversation
    // instead — up to 1280 tokens (historyBudget.ts) against ~110.
    const { engine, seen } = capturingEngine([
      ...turnOf(1),
      ...turnOf(1), // the second turn replays the same script
    ]);
    const history: ChatMessage[] = [...HISTORY];
    for (const ask of ['and what about thursday']) {
      await runAgent(engine, TOOLS, history, { onEvent: () => {}, confirm: async () => true }, NOW);
      history.push({ role: 'assistant', content: 'Here is what I found for you.' });
      history.push({ role: 'user', content: ask });
      await runAgent(engine, TOOLS, history, { onEvent: () => {}, confirm: async () => true }, NOW);
    }

    const turnTwo = seen.slice(3); // turn 1 spent three generations
    const first = divergence(seen[2]!.messages, turnTwo[0]!.messages);
    console.log(
      `\n  turn 2, first generation: re-evaluated ${formatSize(first.reEvaluatedChars)} ` +
        `of ${formatSize(promptSize(turnTwo[0]!.messages).chars)}\n`,
    );

    // The system prefix, the whole of turn 1's history and turn 1's own
    // decision and result all stay cached. Only the new exchange plus this
    // turn's reference block and instruction are rebuilt.
    expect(first.sharedMessages).toBeGreaterThanOrEqual(HISTORY.length + 1);
    expect(first.reEvaluatedChars).toBeLessThan(700);
  });
});
