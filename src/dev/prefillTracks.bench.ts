// Prefill benchmark, part 1 of 2: dump the prompt tracks.
//
// Builds, with the app's REAL prompt builders and trim functions, the exact
// prompts two policies send over the same synthetic conversations:
//
//   old — stateless history trim; only the system prefix cached at cold start
//   new — sticky trim; KV checkpoint / conversation prewarm before the turn
//
// scripts/prefill-bench.mjs then replays both tracks against the real GGUF and
// times what each turn has to evaluate before its first token.
//
// Run both with `npm run bench:prefill`. Not part of `npm run check`.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { it } from 'vitest';

import { realTools } from '@/src/agent/__fixtures__/tools';
import { agentPrefix, planInstruction, toolPromptReserve, turnReference } from '@/src/agent/prompt';
import { estimateTokens, trimStart, trimToBudget, type CountedMessage } from '@/src/chat/historyBudget';

type M = { role: string; content: string };
const render = (ms: M[]) => ms.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('');
const NOW = new Date('2026-08-12T09:15');
const user = (i: number): M => ({
  role: 'user',
  content: `Question number ${i}: can you explain how item ${i} works in a bit more detail please?`,
});
const asst = (i: number): M => ({
  role: 'assistant',
  content: `Answer ${i}. `.padEnd(420, `Here is a reasonably detailed explanation of item ${i}. `),
});
const convo = (turns: number): M[] => Array.from({ length: turns }, (_, i) => [user(i), asst(i)]).flat();
const prefix = () => agentPrefix(realTools) as M[];
const plan = (history: M[]) => {
  const req = history[history.length - 1]!.content;
  return render([...prefix(), ...history, turnReference(NOW, req) as M, planInstruction([]) as M]);
};

type Step = { prompt: string; measured: boolean };
type Scenario = { name: string; nCtx: number; old: Step[]; neu: Step[] };

it('dumps tracks', () => {
  const sys = render(prefix());
  const out: Scenario[] = [];
  for (const turns of [5, 15]) {
    const prior = convo(turns);
    const prompt = plan([...prior, user(turns)]);
    const warmed = render([...prefix(), ...prior]);
    out.push({
      name: `First message after app restart or chat switch, ${turns}-turn chat`,
      nCtx: 8192,
      old: [{ prompt: sys, measured: false }, { prompt, measured: true }],
      neu: [{ prompt: warmed, measured: false }, { prompt, measured: true }],
    });
  }
  for (const [nCtx, measureTurns] of [[4096, 12], [8192, 6]] as const) {
    const budget = Math.max(512, nCtx - toolPromptReserve(realTools));
    const all: M[] = [];
    const counted = (ms: M[]): CountedMessage<M>[] =>
      ms.map((m) => ({ message: m, tokens: estimateTokens(m.content) }));
    let start = 0;
    let overTurns = 0;
    const old: Step[] = [];
    const neu: Step[] = [];
    for (let t = 0; overTurns < measureTurns + 1; t++) {
      all.push(user(t));
      const c = counted(all);
      const over = trimStart(c, budget) > 0;
      const hOld = trimToBudget(c, budget);
      start = trimStart(c, budget, start);
      const hNew = all.slice(start);
      if (over) overTurns++;
      const measured = over && overTurns > 1;
      old.push({ prompt: plan(hOld), measured });
      neu.push({ prompt: plan(hNew), measured });
      all.push(asst(t));
    }
    // Keep one warm-up step before the first measured one; earlier steps only
    // cost bench time.
    const first = old.findIndex((s) => s.measured);
    out.push({
      name: `Average turn once a chat is past the history budget (context ${nCtx})`,
      nCtx,
      old: old.slice(first - 1),
      neu: neu.slice(first - 1),
    });
  }
  fs.writeFileSync(
    process.env.WHISPER_BENCH_TRACKS ?? path.join(os.tmpdir(), 'whisper-prefill-tracks.json'),
    JSON.stringify(out),
  );
});
