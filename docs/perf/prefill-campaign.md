# The prefill campaign

**One sentence: a chat turn in this app is ~92% prompt evaluation, so the only
optimizations that matter are the ones that remove prompt tokens or make them
hit the KV cache.**

Everything here is measured. Where a number is estimated it says so.

---

## Start here

**What shipped** (measured on the test AVD unless stated): prewarm of the system
prefix, a conversational fast path, `n_predict: 0`, the prefix KV cache
persisted to disk, and the append-only prompt layout. Cold turn 41.2s → 13.8s,
warm turn 12.1s → 5.0s, and the mid-turn planning step down a further 60%.

**Two decisions are open and both belong to a person, not to this document:**

1. **`n_ctx` 4096 → 8192.** With an honest, derived context reserve, *every*
   tools-capable model in the catalog gets ~896 tokens of conversation history
   against the 1024 minimum the codebase itself asserts. Prefix trimming is
   exhausted and proven so. Either the window goes up (~+250 MB predicted, one
   line in `catalog.ts`, a ratchet test names the line to delete) or tool
   capability stops shipping on 4096-context models. See *The context-window
   ceiling*.
2. **A run on the real phone.** Every number here is from a 4-core emulator that
   is roughly 3x slower than the target hardware and is sharing a core with an
   unrelated process. `docs/perf/phone-protocol.md` makes it about five minutes.
   The first row of its table decides whether anything else transfers: if the
   phone's `files/gpu-probe.txt` reads `ok` where the AVD reads `failed`, the
   phone is on a different backend and these numbers describe a different
   machine.

**What is proven and what is not.** Token counts, character counts, prompt
structure and the eval corpus results are proven. Every claim about how a *real
model behaves* after a prompt change is NOT — the corpus replays scripted
responses and cannot see the difference. See *The harness blind spot*.

**If you are about to optimize something here, read *Settled questions* and
*Dead ends* first.** Several attractive-looking ideas are already measured and
dead, and re-running them costs hours.

---

---

## The governing measurement

Test AVD (`whisper-test`: arm64-v8a, 4 cores, 6 GB, android-35, on an Apple M4
Pro host), Qwen3-1.7B-Q4_K_M, CPU path, `n_threads=4`, message "hi".
Reproducible to ~0.1% across repeated runs.

| phase | prefill | decode |
|---|---|---|
| cold plan | 2333 tok @ 63 t/s = 37,206 ms | 5 tok, 288 ms |
| cold answer | 79 tok @ 35 t/s = 2,197 ms | 22 tok, 1,325 ms |
| warm plan | 305 tok @ 38 t/s = 8,076 ms | 5 tok, 308 ms |
| warm answer | 79 tok @ 36 t/s = 2,271 ms | 22 tok, 1,377 ms |

Cold turn 41.2s, warm turn 12.1s. **Decode is fine** — 16-17 tok/s, about 1.6s
of a 41s turn. Every remaining second is a prompt token being evaluated.

Two consequences drive everything else:

1. **Token counts are the currency, and they are hardware-independent.** A 60%
   cut in evaluated tokens is 60% faster on the emulator, on a Snapdragon, and
   on an iPhone. A tok/s figure is not portable; a token count is. Prefer
   optimizations provable in token counts over ones that need a device.
2. **Anything that only accelerates decode is close to worthless here.** This is
   why speculative decoding was demoted — see `model-strategy.md`.

## The prompt budget

Rendered from the real 18-tool catalog. Characters are exact; tokens are
estimated at 3.84 chars/token, a constant calibrated against this project's own
data (a 1500-char prewarm slice measured 393 tokens on device).

| block | chars | est. tokens |
|---|---|---|
| system message | 6665 | ~1736 |
| — tool catalog | 2573 | ~670 |
| — worked examples | 2040 | ~531 |
| — rules, identity, protocol | ~2050 | ~534 |
| planNote (per planning step) | 570 | ~148 |
| answerNote | 296 | ~77 |

The system message measures 1804 tokens as llama.cpp sees it, the difference
being chat-template wrapping.

Worth noting because it is counter-intuitive: **the tool catalog is only ~38% of
the system message.** Worked examples and the rules block are each about as
large. Any plan to shrink the prefix by disclosing fewer tools has a ceiling of
roughly 670 tokens and cannot on its own reach a sub-800-token prefix.

## Free instrumentation nobody was using

`RNLlama loadPrompt:221` logs, for every generation, with a timestamp:

    [DEBUG] Input processed: n_past=1802, embd.size=2881, num_prompt_tokens=2881

`n_past` is tokens served from the KV cache; `num_prompt_tokens` is the total.
**`num_prompt_tokens − n_past` is exactly the work done**, and it is the single
number this campaign optimizes. It requires no instrumentation, no rebuild, and
no app change — `adb logcat -d` while using the app produces it.

## What the cache is actually doing

21 generations captured across three app launches:

- **The prewarm ladder is efficient.** Cumulative prompt sizes 393 / 752 / 1124 /
  1609 / 1804 recur identically every launch. Warming 1804 tokens costs 1829
  evaluated — ~1.4% overhead, from ~6 tokens of chat-template suffix
  re-evaluated per slice. It takes ~28 seconds of wall clock, on every cold
  start, to rebuild a byte-identical prefix.
- **The cache is not broken.** One generation reused 2800 of 2914 tokens — 114
  evaluated — when the prompt genuinely extended the previous one.
- **The layout defeated it.** The per-turn note sat *after* the history, so it
  was displaced by every decision and result the turn appended, and had to be
  re-evaluated at every planning step. Fixed by A1; see the measured result
  below.

**RETRACTED — a number that was in this document and was wrong.** An earlier
version read "the plan phase left a 2695-token prompt in the cache and the
answer phase shared only 1975 of it: ~720 tokens discarded and rebuilt, twice in
one turn". The 720 came from subtracting an `n_past` reported by one generation
from a `num_prompt_tokens` reported by a *different* generation. Those are two
different prompts and the difference is not a quantity anyone can optimize. It
could not be reproduced from any rendering of the source, and the honest
conclusion is that there was never a missing 300 tokens to hunt for. The only
figure worth quoting is the within-generation one: `num_prompt_tokens − n_past`,
both read from the same completion.

## Settled questions (do not re-litigate)

**`no_extra_bufts: true` is correct. Keep it.** The flag disables llama.cpp's
weight repacking. llama.rn's docstring says it trades prompt-processing speed
for memory, and `librnllama_jni_v8_2_dotprod_i8mm.so` is confirmed loaded, so
the i8mm GEMM kernels repacking exists to feed are genuinely present — which
made this look like the smoking gun. It is not. Measured, same AVD, same message:

| | repack OFF (shipped) | repack ON |
|---|---|---|
| cold plan | 34,153 ms | **181,105 ms** (5.3x worse) |
| warm plan | 8,411 ms | 6,162 ms (27% better) |
| RSS | 2,296 MB | 3,369 MB (+1,073 MB) |

**The repack is lazy, on first use.** The user pays ~3 minutes on the opening
turn to buy 27% on later prefill, and carries a gigabyte of double-resident
weights all session. On an 8 GB phone that is disqualifying. (An eager repack at
model-load time would move the cliff somewhere less painful, but the +1 GB still
rules it out below ~12 GB devices.)

**End-of-turn prewarm: no benefit.** Warming system+history+reply after each turn
measured 10.8s vs 11.0s, because a fast-pathed turn's prefill is already only
~113 tokens.

**`stopCompletion()` does not interrupt a prewarm.** It stops token *generation*;
a prewarm is nearly all prompt *evaluation*, which llama.cpp will not abandon
mid-flight. A first attempt made the opening turn worse than no prewarm at all
(123s vs 58s) because the user's message queued behind the entire warm. The fix
is chunking with an abort flag between slices — interrupting is lossless, since
llama.cpp keeps the prefix it already evaluated.

## The tuning surface, verified in llama.rn 0.12.5

Exposed and unused by this app: `n_batch`, `n_ubatch`, `cpu_mask`, `cpu_strict`,
`kv_unified`, `swa_full`, `n_cpu_moe`, `grammar_lazy` + `grammar_triggers`,
`logit_bias`, `n_probs`, `seed`. Also `context.bench(pp, tg, pl, nr)` — a
built-in prefill/decode benchmark, the right instrument for any context-param
A/B, where a scripted UI turn costs ~2.5 minutes and wobbles.

Runtime configuration currently in force, from logcat:

    n_parallel: 1, n_seq_max = 1, ctx_shift: enabled
    ggml threadpool (n_threads=4, n_threads_batch=4)
    librnllama_jni_v8_2_dotprod_i8mm.so
    HTP libs extracted: libggml-htp-v69/v73/v75/v79/v81 (Hexagon NPU, idle here)

`n_threads_batch == n_threads`. Prefill is compute-bound and decode is
bandwidth-bound; they want different counts. No headroom to prove it on a 4-core
AVD, but it is free throughput on an 8-core phone. The Hexagon NPU backend ships
in the APK and has never been tried.

## The harness blind spot

`src/agent/eval/` scores 74 scenarios at 100% and gates `npm run check`. It
replays **scripted** model responses. It regression-tests harness *structure*
extremely well — see the `assertProducible()` story in `roadmap.md` — but it
cannot tell you whether a *real* planner still behaves after a prompt change,
because the fixture emits the same canned decision either way.

This matters because most of the remaining prefill wins are prompt changes.
**A green `npm run eval` is necessary and not sufficient for any change to
prompt content or layout.** Accuracy claims about such changes need a real model
in the loop.

## Caveats on every number here

- The AVD has 4 cores and shares them with a stray `python3.14` process (pid
  93568) that has pegged a full core for nine days. It was present for all of
  these measurements, so A/Bs are internally consistent, but absolute throughput
  is depressed.
- Emulator tok/s does not transfer to a phone. Token counts do.

---

## What the native audit settled (llama.rn 0.12.5, source-read)

**Reuse is a plain longest-common-token-prefix, and there is no middle-reuse.**
`find_common_prefix_length` (`rn-completion.cpp:142`) then
`llama_memory_seq_rm(kv, 0, n_past, -1)`. `n_cache_reuse` exists in the vendored
`common_params` and is never read anywhere in llama.rn, so llama.cpp-server's
trick of re-basing a suffix by KV-shifting is absent.

**The consequence is the single most useful rule in this document: the cost of a
change is proportional to its POSITION in the prompt, not to its size.** A
one-token edit at position 5 of a 2000-token prompt costs 1995 re-evaluated
tokens. Optimize where volatile content sits before optimizing how big it is.

Corollary, and the actual shape of the per-turn waste:

    plan1  prompt = [sys, hist] + planNote
    plan2  prompt = [sys, hist, dec1, res1] + planNote
    answer prompt = [sys, hist, dec1, res1, dec2, res2] + answerNote

The last plan's prompt is not a prefix of the answer's — they diverge exactly
where the plan had `planNote` and the answer has `dec2`. The note is not in the
answer prompt at all, so its SIZE is nearly irrelevant; its POSITION is the bug.

**RETRACTED — "the tool result payload is the dominant rebuilt term, so shrink
or reposition results."** Two of us reached that conclusion independently and it
does not follow. Results DO dominate the tail by size, but each one is evaluated
**exactly once** under both the old and the new layout: step *i+1* prefills
`dec_i + res_i + note`, and step *i+2* prefills only `dec_{i+1} + res_{i+1} +
note`. Results were never re-prefilled, so they were never recoverable. The note
was always the only recoverable part — which is why A1 is worth 60% of a
planning step and not more. Clamping results still matters for the context
budget; it buys nothing in prefill.

The general lesson: "biggest term in the tail" and "biggest recoverable term"
are different questions, and only the second one is worth optimizing.

### Confirmed available, no patch needed

- **Persisting the prefix KV to disk.** `loadSession` writes restored tokens
  directly into `ctx->completion->embd` — the same vector the prefix match reads
  — and `rewind()` never clears it, so a cold start gets a genuine cache hit.
  Use plain `saveSession`/`loadSession`. A stale snapshot is NOT a correctness
  hazard: the hit is computed by comparing actual token vectors, so an outdated
  prefix simply yields a shorter match and the divergent tail is evicted.
- **Merging the plan and answer generations.** `grammar_lazy` +
  `grammar_triggers` leaves logits untouched while awaiting a trigger and
  retroactively replays buffered tokens into the grammar on a match. Trigger
  `type`: 0 TOKEN, 1 WORD, 2 PATTERN, 3 PATTERN_FULL. Trap: a WORD trigger that
  tokenizes to a single token is rewritten to a TOKEN trigger and **throws**
  unless that token is also in `preserved_tokens`.
- **`n_predict: 0`** means "evaluate the prompt, generate nothing" (`-1` is the
  unlimited sentinel). It is strictly cleaner than `n_predict: 1`, which pushes
  a sampled-but-undecoded token into `embd` and leaves
  `embd.size() == n_past + 1`.

### A free lever nobody knew about

`ggml-cpu.c:1431-1434`: if `ne11 % 2 != 0` — the token count in the micro-batch —
then `num_rows_per_vec_dot` drops to 1. **An odd-length micro-batch silently
takes Q4_K mul_mat off the 2-row `smmla` path and onto the 1-row `sdot` path.**
Because we ship `no_extra_bufts: true`, that vec_dot path is the hot prefill
road, and a 305-token warm prefill is a single odd micro-batch. Padding prompts
to an even token count is close to free. Being A/B'd.

### Dead ends — do not spend time here

- **`cpu_mask` / big-core pinning.** `JSIParams.cpp:25-62` `set_best_cores()`
  already runs on every Android init: reads `cpuinfo_max_freq` per core, sorts
  descending, pins the top N, sets `strict_cpu`. Already pinned to the fastest
  cores; setting it by hand can only make it worse.
- **Per-completion `n_threads`.** `attachThreadpoolsIfAvailable()` has one call
  site (init) and `llama_set_n_threads` is never called. A thread A/B needs a
  fresh `initLlama` per arm.
- **`n_threads_batch`.** Not settable from JS. And the log line
  `Attached ggml threadpool (n_threads=4, n_threads_batch=4)` **means the
  opposite of what it reads**: `cpuparams_batch.n_threads` is -1, so no batch
  threadpool is created at all and the log prints `n_threads` twice. Exposing it
  is a 2-line patch and is the most valuable patch available to this project.
- **`parallel.enable()`.** In parallel mode a completion without
  `load_state_path` wipes the slot KV and re-prefills from zero on every call.
  Also `n_ctx` is DIVIDED by `n_parallel`, not multiplied.
- **Hexagon NPU as a config flip.** `RNLlamaJSI.cpp:58-68` filters every `HTP*`
  device out of the default list. Reaching it needs an explicit `devices` array,
  `n_gpu_layers > 0`, an SM8xxx SoC, and giving up flash attention and quantized
  V. A research spike, not an optimization.

### Two traps for anyone measuring

- **`bench()` corrupts the next completion.** It calls `llama_memory_clear` but
  never touches `completion->embd`, so the KV is empty while `embd` still holds
  the old conversation; the next completion decodes from a large `n_past` with
  nothing behind it. Silent garbage, not an error. Always `clearCache()` after,
  or bench on a dedicated context. Same defect in `embedding()` and `rerank()`.
  Also `pl > 1` fails at `n_seq_max = 1`, and the guard is
  `pl * (pp + tg) <= n_ctx`.
- **A context shift costs a full re-prefill on the NEXT turn**, regardless of
  `n_keep`: after the shift `embd` is compacted and KV positions re-based, so
  the following prompt diverges immediately.

`n_keep` remains settable natively but absent from llama.rn's `src/types.ts`,
so it is unreachable from JS. The comment in `loop.ts` saying so is correct and
the `TURN_RESULT_TOKENS` rationale built on it stands.

---

## Acceptance targets — what "close to frontier, but local" means numerically

Set 2026-09-05. A goal that cannot be failed is not a goal, so these are the
numbers the campaign is judged on.

**The reference experience.** A frontier chat app over an API shows its first
token in roughly 0.5-1.5s and finishes a short answer in 2-4s. That is the bar,
and the honest part of the comparison is that a 1.7B model on a phone has to
reach it with a much smaller compute budget and no network.

**What the user actually perceives is time-to-first-token, not turn duration.**
A frontier app feels fast largely because it starts streaming almost
immediately. This app cannot stream until the whole planning generation has
finished, so TTFT today is plan prefill + plan decode + (tool) + answer prefill.
That chain, not the total, is what makes it feel slow.

### Targets on a real phone (8 GB Snapdragon class)

| | target | notes |
|---|---|---|
| TTFT, conversational turn | **< 1.0s** | no tool; should feel instant |
| TTFT, tool turn | **< 2.0s** | plan, run, then start answering |
| Complete short answer | **< 3.0s** | end of stream |
| Cold start (first turn of a session) | **within 1.5x of warm** | prefix KV snapshot is what makes this possible |

### Proxy targets on the test AVD

The AVD is 4 cores (one of them stolen by an unrelated nine-day `python3.14`
process) and measures roughly 3x slower than the phone class above. Until a
physical device is attached, multiply by ~3:

| | AVD target | today |
|---|---|---|
| TTFT, conversational turn | < 3.0s | ~5.0s fast-pathed, ~12.1s otherwise |
| TTFT, tool turn | < 6.0s | — |
| Complete turn | < 9.0s | 12.1s warm, 13.8s cold |

**These proxy numbers are a stand-in and must not be quoted as the product's
performance.** Token counts transfer between machines; tok/s does not. The
campaign's real claim needs one run on the physical test phone.

### What has to be true to hit them

1. **A1, append-only prompt layout.** Removes the per-generation rebuild. The
   largest single item.
2. **Prefix KV persisted to disk.** Removes cold start as a separate case.
   Shipped in `2eba7ed`, unverified on device.
3. ~~A3, collapse the plan and answer generations (`grammar_lazy`).~~
   **REJECTED 2026-09-05 — see below.**
4. Everything else — parity padding, ubatch, thread splits — is a multiplier on
   an already-small number and should be measured, not assumed.

### Where the remaining risk is

Accuracy, not speed. The eval corpus replays scripted responses, so the prompt
changes that produce most of the speed cannot be shown safe by it. The
host-side real-model harness is the gate; a fast assistant that picks the wrong
tool is not usable, and this project's own worst shipped bug was narrating an
action instead of performing it.

## Rejected: collapsing the plan and answer generations (A3)

The mechanism works — `grammar_lazy` plus `grammar_triggers` leaves logits
untouched while awaiting a trigger and retroactively replays buffered tokens
into the grammar on a match, and a source audit confirmed the exact param shape.
It was queued as the largest time-to-first-token win, because a no-tool turn
would start streaming immediately instead of after a whole planning generation.

**It is rejected because it trades away the property that keeps the agent
honest.** Today the planning generation is grammar-CONSTRAINED: the model must
emit `{"tool": ...}` or `{"respond": true}`, and it cannot narrate. Under a lazy
grammar the model is UNCONSTRAINED until it emits the trigger — so asked to set
an alarm it may simply answer "Sure, I'll set that for you at 7" and never emit
the trigger at all. That is narrate-instead-of-act, this project's worst shipped
bug, reintroduced at the mechanism level, failing silently, on every turn rather
than on a filtered subset.

It is the same risk-inversion argument that keeps `fastPath.ts` a closed
allowlist rather than a tool-keyword blocklist, and it applies with more force
here because the fast path is opt-in per message and this would not be.

**The decisive argument is that A3's benefit is concentrated exactly where its
risk is.**

- On fast-pathed turns it is worth ZERO — those are already a single generation.
- So it only pays on turns that plan. And of those, it pays most on the ones
  that emit a tool call — which are precisely the turns where the grammar
  constraint is the only thing standing between *setting* the alarm and *saying*
  it set the alarm.

Zero benefit where it is safe; benefit only where it is dangerous. That is a bad
trade at any latency, and it does not depend on anything else landing.

**A weaker argument was recorded here first and is withdrawn:** "A1 delivers
most of A3's benefit". That is false. A1 and A3 attack different terms and are
additive — A1 shrinks the PLAN's prefill, A3 would remove the ANSWER's prefill
and the plan's decode. Landing A1 does not shrink A3's saving at all. Recording
the wrong reason invites someone to reopen this in a month, correctly observe
that A1 did not deliver it, and re-litigate a decision that was right for
another reason.

For the record, A3's honest value on the pre-A1 warm turn was ~2.6s of 12.1s: it
removes the answer's prefill (2271ms) and the plan's decode (308ms), but not the
answer's decode (1377ms, those tokens must be generated either way) and not the
plan's prefill (the merged generation still evaluates the same prompt).

**The safe route to the same win is widening the fast path**, where a wrong
answer costs a slower turn instead of a silent lie, and where
`fastPath.test.ts` can measure the failure rate before it ships.

---

## A1 landed — measured result

Commit `10f9134`. Re-evaluated characters per generation, warm, system prefix
cached. Both columns are rendered rather than recalled: the "before" column
comes from `legacyPlanNote()`, which reproduces the replaced layout byte for
byte and is pinned by a test, so the table regenerates on every CI run and
cannot go stale.

| turn | gens | before, total | after, total | change |
|---|---|---|---|---|
| 0-tool | 2 | 1182 chars | 1020 | −14% |
| 1-tool | 3 | 2117 | 1407 | −34% |
| 2-tool | 4 | 3027 | 1769 | −42% |
| 3-tool | 5 | 3953 | 2147 | −46% |

**The headline is the mid-turn planning step: 919 → 371 characters (~239 → ~96
est tokens, 60% less), repeating once per step.**

The layout is now
`[system(+ date table), ...history, turnReference, (decision, result)*, planInstruction]`.
Only the trailing instruction (70–159 chars) is displaced per step.

`turnReference` sits AFTER the history, not before it as originally briefed.
History is the largest stable region in the prompt — up to 1280 tokens — and a
ticking clock ahead of it would move every byte of the conversation on every
turn. That is ~110 characters against up to 1280 tokens: the same
"position, not size" principle, applied where it actually pays.

Evals identical before and after: 78 scenarios / 79 turns, 100% on completed,
tool, args and answer, mean 1.82 steps, 0 drift. No floor touched.

### Derived TTFT, and the gap that remains

Derived, NOT measured — re-evaluated characters ÷ 3.85 chars/token ÷ 70 tok/s,
plus plan decode at ~16 tok/s:

| turn shape | before | after | AVD target |
|---|---|---|---|
| conversational, fast path | ~1.1s | ~1.1s | < 3.0s ✓ |
| conversational, still plans | ~4.7s | ~4.1s | < 3.0s ✗ |
| 1 tool | ~8.5s | ~5.8s | < 6.0s ✓ (just) |
| 2 tools | ~11.8s | ~7.2s | — |
| 3 tools | ~15.3s | ~8.6s | < 9.0s ✓ (just) |

Two honest caveats:

1. **The tool-turn targets are met on paper with no margin.** 5.8s against 6.0s
   and 8.6s against 9.0s sit inside the error bars of a chars-per-token estimate
   and a single-point tok/s figure. "Plausibly met, needs the device", not
   "cleared".
2. **The remaining miss is any conversational turn the fast path declines** —
   ~4.1s against a 3.0s target. That is the knowledge-question class ("what is
   the capital of France", "how long to boil eggs"): 8 of the corpus's 18
   no-tool turns, which still pay a full planning generation. A1 cannot close
   it. **Widening the fast path is the remaining work**, and it is gated on a
   real-model harness because the corpus cannot see the difference.
   *Partly closed since, without widening the fast path — see "Landed: the
   relative-times block is conditional" at the end of this document. 0.79s of
   the 1.1s, by not rendering clock arithmetic to turns that cannot use it.*

---

## The context-window ceiling — a product decision, not an optimization

Found 2026-09-05 by re-deriving the context reserve against the post-A1 layout
instead of carrying the old constant forward.

**`TOOL_PROMPT_RESERVE` had been silently under-reserving.** It was a hand-tuned
2816 with nothing connecting it to what it covers. Measured against the real
prompt, on the *least* conservative ruler available (3.85 chars/token):

    system + turnReference(300-char request) + answerNote, wrapped   2073 tok
    + history (what 2816 leaves)                                     1280
    + per-turn traffic (loop.ts's own: results 320 + wrappers 140)    460
    + generated answer                                                320
    ----------------------------------------------------------------------
                                                                     4133 tok
    against n_ctx                                                    4096

**It overflows by 37 tokens**, and by more on the app's own 3.5 ruler. The peak
is the ANSWER generation, not a planning step — `planInstruction` is one
sentence, while the answer band is a note plus 320 generated tokens.

This is the exact overflow `loop.ts` bounds tool results to keep unreachable,
and it is not a soft failure. `ctx_shift` discards from the FRONT with `n_keep`
pinned at 0, so the first thing evicted is the tool catalog and the JSON
protocol — while the grammar keeps the output well-formed. The model then emits
confident, valid-looking tool calls chosen from a catalog it can no longer see.

**The reserve is now DERIVED** from the prompt that will actually be sent
(`toolPromptReserve(tools, now)`), rather than hand-tuned, so a new tool costs
history instead of silently breaking the turn, and every token trimmed from the
prefix becomes conversation history with no second constant to remember.
`TOOL_PROMPT_RESERVE` survives as the ratchet ceiling the derived value is
asserted under.

### The consequence

Raising the reserve to a truthful 3200 leaves **~896 tokens of history at
`n_ctx` 4096 — about four turns.** So the codebase's own invariant now says
**4096 is insufficient for a tools-capable model with this prompt.**

Trimming the prefix is exhausted. An independent pass established that the
system message cannot go below ~1900 tokens without deleting worked examples or
whole tool descriptions — the strongest lever this codebase has on a 1.7B — on
the authority of an eval that cannot see the difference. The three slices are
rules ~679, catalog ~722, examples ~608: there is no fat target.

### The price, named deliberately

Raising the reserve 2816 → 3200 cuts agent-mode conversation history from 1280
to **896 tokens — a 30% reduction in how much of the conversation the model can
see** (`historyBudget` is `max(512, nCtx - reserve)`).

**This is a user-visible product change that came out of a latency campaign, and
it is recorded here so it is not rediscovered as a regression next week.** The
trade is right: a silently truncated tool catalog produces confident wrong
actions, while a shorter memory produces "sorry, what were we discussing" — one
of those is a lie and the other is an inconvenience. But it was a side effect,
not a goal, and it deserves to be a named decision.

Two things follow. A phone run should subjectively check that a tool
conversation does not lose the thread too early — that is in the phone protocol.
And **if 896 turns out to be too tight in practice, the lever is `nCtx`, not the
reserve.** The reserve is now derived and truthful; un-deriving it would simply
restore the overflow.

**The requirement is currently met by nothing that ships.** Enumerating which
models satisfy "a tools model needs `n_ctx` >= reserve + 1024 tokens of real
history" produces an exemption list of six — and six is *every* tools-capable
model in the catalog: qwen3-4b, llama-3.2-3b, phi-4-mini, smollm3-3b,
qwen3-1.7b, qwen3-1.7b-abliterated. All sit at 4096; all get ~896 tokens of
history against a 1024 minimum. It reads like an exception list and it is
actually the whole set.

A ratchet guards it, verified to bite three ways: adding a seventh model goes
red, dropping a still-broken one goes red, and raising an exempt model to
`n_ctx` 8192 goes red with "now has room for the agent prompt — remove it from
NCTX_EXEMPT". So the list cannot widen, cannot go stale, and cannot be escaped
by deletion — and the moment a window is raised, the test names the line to
delete.

That leaves two ways out:

1. **`n_ctx` 4096 → 8192.** History goes to ~5481 tokens. One line in
   `catalog.ts`, zero accuracy risk. Gated entirely on whether the RAM fits.

   Predicted cost, from the model geometry: Qwen3-1.7B is 28 layers with 8 KV
   heads at head_dim 128, so KV width is 1024 per half, and both halves are
   `q8_0` on the Android CPU path (~1.06 bytes/element with the block scale):
   `28 x 2 x 1024 x 1.06 ≈ 60.8 KB/token`, so 4096 → ~249 MB and 8192 → ~498 MB,
   a delta of **~+250 MB**. Against ~2.3–2.4 GB current RSS, `minRamBytes` 6 GB
   and an 8 GB target phone, that looks affordable — but "looks affordable" is
   the kind of claim this campaign has been wrong about twice, so it is being
   measured. What genuinely cannot be predicted is whether the larger KV moves
   prefill throughput; if 8192 is slower per token it trades against the whole
   point of the campaign.

   Note the prefix KV snapshot does **not** scale with `n_ctx`:
   `llama_kv_cache::state_write` skips empty cells, so the file is sized by the
   ~1900 tokens actually stored, not by the cache geometry.
2. **Stop shipping tool capability on 4096-context models.** A product decision.

This also reframes roadmap Phase 1: its history target (1280 → ~2500 tokens)
should be aimed at `n_ctx`, not at the prefix. The prefix cannot deliver it.

### A finding about our own gates, worth more than the tokens

During the same pass, three rules were removed on the theory that each was
redundant with a worked example. **Eval stayed 79/79 and all five `guarded`
scenarios stayed green — and the removal was still wrong**, so it was reverted.
A rule is the *generalisation* over its example, not a duplicate of it: the
example is contacts→sms, while the corpus also contains contacts→dial_number and
contacts→compose_email that the example never covers. Deleting the rule and
keeping the example preserves the enumeration and discards the generalisation.

That reasoning now lives in a comment above the Rules block, not just here,
because the next person to trim tokens will read the code. **A green eval run is
not permission to cut that block.**

---

## How this campaign was actually run, and why the numbers here are trustworthy

Four load-bearing claims were made confidently during this work and later
retracted. Each was caught by someone going back to the source rather than
trusting the relay:

| claim | why it was believed | what killed it |
|---|---|---|
| `no_extra_bufts: true` is the smoking gun | llama.rn's own docstring says it trades prompt speed for memory, and i8mm is confirmed live | measurement: repack ON is 5.3x WORSE cold (181s) and +1073 MB, because the repack is lazy on first use |
| ~720 tokens per turn are rebuilt as waste | two logcat lines, subtracted | the subtraction crossed two different prompts; irreproducible from any rendering of the source |
| tool RESULT payloads are the dominant recoverable term | they genuinely dominate the tail by size | each result is evaluated exactly once under both layouts — they were never recoverable |
| the working tree already had `n_predict: 0` | a subagent reported it | it did not; the tree was being edited concurrently. A source citation is checkable forever, a state claim is true for an instant |

None of those retractions cost much, because each was caught within an hour by
a second pair of eyes checking the primary source. All four would have been
expensive if they had been built on.

**The practices that produced that, worth keeping:**

- **Separate source claims from state claims.** A file:line citation can be
  re-checked by anyone at any time. "The working tree currently has X" is true
  for an instant and is worthless in a message read ten minutes later. Quote the
  commit you read at.
- **A negative result is a deliverable.** "Repack is 5.3x worse, do not re-run
  this" saved more time than most of the positive findings. So did "selective
  tool disclosure breaks even at 0.53 turns" and "widening this would reintroduce
  narrate-instead-of-act".
- **Prove the test can fail.** Every gate added here was checked by deliberately
  reintroducing the bug it guards — the no-tool teachings one at a time, the UTC
  date, a clock leaking into the stable prefix, the model-catalog ratchet three
  separate ways. This project's own Phase 0 lesson is that a fixture which
  cannot reproduce a known bug is not yet a gate.

  **The yield on this repo is unusually high, and here is the evidence.** The
  habit caught two tests that were silently asserting nothing and would have
  passed forever:
  - A DST date test matched a WORKED EXAMPLE (`today is Monday 2026-03-02`)
    rather than the real date table, and only worked at all because the table
    happens to render above the examples. It would have started asserting
    against the wrong line the moment the table moved — which configuration C is
    about to do.
  - The model-catalog exemption ratchet passed before anyone had tried widening
    it. Only deliberately adding a seventh model, dropping a still-broken one,
    and raising an exempt model's window proved it bit in all three directions.

  Both would have read as green coverage. On a codebase whose failure shape is
  nearly always silent, "does this go red when I break it" is the cheapest
  question available and it keeps returning bugs.
- **Distinguish "biggest term" from "biggest recoverable term".** Two people
  independently got this wrong about tool results.
- **Measure the real thing, not a fixture that resembles it.** An ad-hoc probe
  built the tool catalog with `z.object({})`, so it rendered with no argument
  descriptions and reported the system message at 6075 characters against a real
  7026. Reproduced exactly: 954 characters of argument descriptions, with the
  remaining 3 characters being weekday-name lengths at a different `now`.

  **The danger is that 6075 is a plausible number** — right order of magnitude,
  smaller than 7026 in precisely the direction a token-trimming campaign expects
  to see, and it would have read as a finding. No error was raised and nothing
  looked wrong. A wrong number pointing the way you hoped is the one you are
  least likely to question. Use `promptSize.ts` against the real catalog; treat
  any hand-rolled probe as suspect until it agrees with it.
- **A green suite is not permission.** Three prompt rules were removed, the eval
  stayed 79/79, every guard stayed green, and the removal was still wrong. The
  corpus replays scripted responses; it cannot see what a real model would do.

### The class of bug that verification does not reach

Three of the bugs found tonight were not wrong answers. They were **work
running that should not have run — or, in the worst case, work being SKIPPED
that should not have been** — and none had a natural failing assertion:

- The prewarm fired for every model, including ones that never reach `runAgent`
  — spending ~28s of CPU and a ~100 MB snapshot write to populate a cache that
  could never be hit. The feature was gated on the agent path; the CALL was
  placed in the model-load effect, which knows nothing about which path a turn
  will take. `useTools` and `spec.tools` were two different questions and only
  one was asked.
- A first draft of the release smoke test scanned the whole logcat buffer gated
  on a condition that was always true, so it would have reported unrelated
  system noise as a release blocker. A smoke test that cries wolf gets ignored
  on the night it is right.

- **The conversational fast path skipped schedule questions.** `skipsPlanning()`
  is a bag-of-words gate: every word must be in a pleasantry vocabulary, at
  least one must be an anchor, no attention to order. But safe words compose
  into unsafe sentences. `how`, `much`, `is`, `there` are each unarguably
  innocent and together they are a question, so "hey how much work is there
  today" skipped planning entirely and the model answered a schedule question
  from nothing. The same question **plans correctly without the greeting** — the
  anchor requirement works; what defeats it is that a greeting donates the
  anchor while the rest of the sentence happens to be built from whitelisted
  filler.

  The instructive part is the attempted fix. Removing the offending words does
  not work and cannot: `fastPath.test.ts` asserts "thank you so much" is
  fast-pathed, so `much` must stay in the vocabulary — and once it does,
  "hey how much is there" passes. That is a proof that no curation of the list
  can work, not merely evidence that one curation failed. **The defect is the
  design, not the vocabulary**, and the remedy is to match whole normalized
  phrases end to end rather than word membership — which restores the property
  the file's own comment already claimed: it recognises pleasantries, never
  "sentences assembled from safe pieces".

  A word-removal patch would have been *worse than the bug*: it would make the
  two reported sentences plan, read as fixed, and close the investigation while
  the class survived.

  **Fixed in `1711cf1`, and it cost no coverage.** The gate now normalizes and
  requires the WHOLE string to match `^phrase( phrase)*$` over a list of
  complete pleasantries. Composing phrases is safe where composing words was
  not: "morning" + "how are you doing today" is still a pleasantry, while "hey"
  + six filler words is a question. All six corpus pleasantries that fast-pathed
  before still do — "Perfect, thanks — that is all for now" is three listed
  phrases end to end — so the coverage the old design bought with loose filler
  was, as far as the corpus can see, coverage it never needed.

  Two details worth keeping. The digit check must run BEFORE normalization,
  because normalization strips digits and "hi 7" would otherwise reduce to a
  matching "hi". And the regression test pins the CLASS, not the instances: 7
  pleasantry prefixes crossed with 8 innocent-word questions in 3 punctuation
  shapes, with each question also asserted to plan on its own — so the test
  proves the greeting prefix is what would have changed the verdict.

Everything else in this document is about verifying claims. This class is
different: there is no claim to check, because nothing is asserting anything.
The tests that catch it are **assertions about what does NOT happen** — no
prewarm for a model without tools, no trace work when tracing is off, no
snapshot for a cache that cannot be hit — and nobody writes those until after
the first time.

Two places tonight got it right and are worth copying: `tailLabel()` returns
early on `!Trace.isEnabled()` *before* stringifying the prompt while still
updating its cross-turn state, and the prewarm now checks `spec.tools` at the
call site rather than trusting the feature gate downstream.

---

## Landed: the relative-times block is conditional

`turnReference` carried a 212-character fenced block on every planning turn —
`Use ONLY if I say "in N minutes/hours": in 30 minutes it is 13:39, in an hour
14:09, in three hours 16:09. If I name a time instead ("at 10pm", "at 7:30"),
use exactly that, with minute 0 unless I said a minute.` It is now rendered only
when the request could name a time (`mentionsTime()` in `prompt.ts`).

### The verified decomposition it was aimed at

The ~4.1s figure above was quoted without a breakdown twice. Rendered, for
"What's the capital of France?" against the real 18-tool catalog, with the
system prefix prewarmed:

| | before | after |
|---|---|---|
| plan prefill (turn 2 of a conversation) | 555c ≈ 144 tok ≈ 2.06s | 342c ≈ 89 tok ≈ 1.27s |
| plan decode (5 tokens @ 16 t/s) | 0.31s | 0.31s |
| answer prefill (`answerNote`) | 307c ≈ 80 tok ≈ 1.14s | unchanged |
| **TTFT** | **3.51s** | **2.73s** ✓ |
| same, first turn after a cold start (history uncached) | 3.96s | 3.17s ✗ |

Derived, not measured: characters ÷ 3.85 ÷ 70 tok/s. **212 characters ≈ 55
estimated tokens ≈ 0.79s**, and it is the same 0.79s in both framings because it
is one message removed from one generation. The `< 3.0s` AVD target is cleared
mid-conversation and missed by 0.17s on the first turn of a session — which is
the turn the prefix KV snapshot exists to fix, and it has not been verified on
device.

**It returns ZERO tokens to the history budget, and that is correct.**
`toolPromptReserve()` must cover the reference block at its longest, which is
still the block-present rendering, so the derived reserve is 3146 before and
after. A reserve that varied with the request would resize the history from turn
to turn and re-prefill the whole conversation each time — far more than 55
tokens. (The reserve's own worst-case probe was changed from 300 `x`s to a
request opening with a digit; without that it would have measured the shortened
block and silently under-reserved by 61 tokens.)

### Why this cannot become narrate-instead-of-act

The claim is not "this request needs no tool" — that is the fast path's claim,
and it is refused as a blocklist for good reason. The claim here is "this
request contains no expression of TIME", and the two are not comparable:

- **The surface is closed where an intent is open.** "I need to be up at 5" is
  an alarm request with no tool word in it, which is why `fastPath.ts` is an
  allowlist. But it names a time, and every phrasing that names one either
  writes a digit, writes am/pm, or uses one of a small set of words
  (noon, midnight, o'clock, half, quarter, an hour, a bit, tonight).
- **The prompt already says so.** The block is fenced `Use ONLY if I say "in N
  minutes/hours"`. Omitting it when no such phrase appears removes text the
  model has been instructed to ignore.
- **The failure is LOUD.** The block exists to fill an `hour`/`minute` argument.
  The only three tools that take one — `set_alarm`, `schedule_reminder`,
  `create_calendar_event` — all set `requiresConfirmation: true` and render the
  computed time into the card the user must tap ("Set alarm 13:09"). A word the
  vocabulary misses therefore degrades to a wrong time the user is *shown before
  anything happens*, not to the silent lie a false skip would be. No tool that
  consumes this block can run unseen.
- **Two independent triggers.** A miss needs both to fail: the time vocabulary,
  and the vocabulary of asking this phone to schedule something. "Remind me in a
  jiffy" keeps the block on the word "remind".
- **It removes a known hazard as well as tokens.** The block has its own
  observed failure when present and irrelevant: unfenced, "in an hour 22:59"
  turned "remind me at 10pm" into 10:59 PM. Not rendering it where it cannot
  apply is one fewer clock time in the prompt to copy the wrong one out of.

`mentionsTime.test.ts` is the specification, built the same way
`fastPath.test.ts` is: **zero false omissions across every corpus turn whose
expected call takes an hour or a minute** — 21 of them today. The set of such
tools is derived from `TOOL_DEFS` by looking for an `hour`/`minute` property, so
a new tool joins the property instead of escaping it.

Scored over the corpus: 21/21 clock-bearing turns keep the block; 10 of 18
no-tool turns drop it (the saving); the 8 that keep it are greetings and
"what time is it", all in the safe direction. 22 tool turns drop it — contacts,
battery, clipboard, maps, media, URLs — and none of those tools takes a time.

Eval unchanged: 78 scenarios / 79 turns, 100%, mean 1.82 steps, 0 drift. **Still
unverified behaviourally** — the corpus replays scripted responses and cannot
say whether a real Qwen3-1.7B still gets "wake me in an hour" right. That needs
the host-side GGUF harness.

### Rejected here too: the cheap constrained probe

A single-token `root ::= "T" | "C"` generation replacing the planning
generation. Its own sketch said it only pays if the probe prompt is dramatically
shorter than the planning prompt AND reuses the same cached prefix. **Those two
requirements are mutually exclusive on this engine.** `LlamaEngine` holds one
module-level context, `n_parallel: 1`, and reuse is a plain longest-common-token
prefix followed by `llama_memory_seq_rm`. A short probe prompt therefore does
not share the prefix — it *evicts* it, and the answer generation behind it
re-prefills the whole ~2000-token system message: ~29s at 70 tok/s.

Constrained to share the prefix, the probe's prompt is the planning prompt with
a different trailing sentence, and the arithmetic is: it saves the difference
between `planInstruction` (98 wrapped characters on the first step) and a
shorter probe instruction, plus four tokens of decode. **Best case ~0.35s, on
no-tool turns only, and it adds a whole extra generation to every tool turn.**
It buys under half of what the conditional block buys, and it buys it by
putting a classifier in front of the grammar — which is narrate-instead-of-act
with an extra step.

### Widening `skipsPlanning` — still not done, and here is the evidence needed

Not attempted, and no flag was added, because the flag would have nothing behind
it. The remaining no-tool class is knowledge questions, and the second failure
mode there is worse than a slow turn: "what's on my calendar", "when is my
meeting", "what's my battery at" all look like questions answerable from
knowledge and are not, so a skip answers from the model's imagination about the
user's private data. There is no closed vocabulary that separates "how long to
boil eggs" from "when is my meeting" — both are `<wh-word> <common words>`.

What would justify turning such a flag on: the host-side GGUF harness scoring a
candidate gate over the whole corpus **plus** an adversarial set of possessive
questions ("my", "our", "mine" + every noun the tool catalog can reach), with
zero skips on any of them, and a measured false-skip rate of zero across at
least a few hundred real user messages. Until that exists the honest position is
that this gap closes by making the planning turn cheaper, not by skipping it.

---

## The real-model harness, and what it found

`npm run eval:real` runs the actual Qwen3-1.7B-Q4_K_M with the actual GBNF
grammar against the actual rendered prompts, driving the *same* 78-scenario
corpus through the *same* `runAgent`. 82 turns in ~90s on Metal. It is not
wired into `npm run check` — it needs a multi-GB model — and skips with
instructions when the GGUF is absent.

**Accuracy transfers between machines; latency does not.** Same weights, same
grammar, same prompt bytes produce the same decisions anywhere. Never quote a
timing from this harness.

### The sentence that reframes the whole campaign

**The replay corpus scores 100%. The real model scores 66%.**

Every "eval stayed green" in this document means the *harness* did not regress.
It never meant the model was right. The fixture emits scripted decisions, so a
green run asserts the script back at itself — which is exactly what the Phase 0
`assertProducible()` story in `roadmap.md` warned about, one level up.

This does not make the replay corpus useless: it is a good regression test for
harness structure, and it caught real bugs tonight. It means the two suites
answer different questions and only one of them is about the model.

### Variance is zero, so ±1 is signal

Three separate process launches at one seed produced byte-identical scores, and
two seeds agree exactly on the subsets. Planning is greedy at temperature 0; the
answer phase is pinned by seed.

### The gate can fail, deliberately proved

`WHISPER_EVAL_ABLATION=anchors` strips the date table and relative-time anchors
at the engine boundary — never by editing `prompt.ts`. On the `dates` subset:
call-ok 8→7, args 9→8, completed 6→5. Against the pre-A1 prompt the same
ablation moved tool-correct 14→12 and produced visibly wrong dates:
`cal-create-friday-1pm` off by a day, `rem-in-an-hour` returning 13:05,
`cal-list-weekend` refusing outright with "I don't have access to your calendar".

### Open, and blocking: A1 costs date accuracy

A/B'd through `legacyPlanNote()` — same scenarios, same seed, only the layout
differing — the pre-A1 layout scores **+5 call-ok and +6 completed over 82
turns**. One flipping scenario is identified and cleanly explained:
`cal-list-named-weekday`, "What have I got on Monday?" asked on a Wednesday,
returns the correct single day under the old layout and the whole week under A1.
That is the documented named-weekday failure class, caused by the date table
moving away from the decision point. A pure salience effect.

**The remedy under test is not a revert.** A1 bundled two independent changes:
the append-only turn structure (where the 60% saving lives, unindicted) and
moving the date table into the system prefix (what the evidence indicts).
Configuration C — append-only structure, date table back in `turnReference` — is
being measured three-way. If it matches legacy on dates it is strictly best,
because a date-independent prefix also makes the KV snapshot permanent and
removes the 42-second midnight cliff. Its price is ~49 est tokens per turn on
the TTFT path.

### Two more real bugs it found

- **`toolCatalog()` drops JSON-schema `enum`.** `search_phone_media.media_type`
  reaches the model as `media_type?: string` with no allowed values, so it emits
  `"photos"`, zod rejects, and the loop burns an extra plan-execute cycle. ~5
  turns. Identical in class to the `.describe()` bug already documented in
  `prompt.ts` — a schema field written, tested, and never shown to the model.
- **`rem-in-an-hour` is live today.** "in an hour" at 13:09 returns minute 0
  (14:00, not 14:09) *with* the relative-time anchors present. The signature bug
  this project has fought for months is not fixed.
