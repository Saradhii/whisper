# The prefill campaign

**One sentence: a chat turn in this app is ~92% prompt evaluation, so the only
optimizations that matter are the ones that remove prompt tokens or make them
hit the KV cache.**

Everything here is measured. Where a number is estimated it says so.

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
- **Distinguish "biggest term" from "biggest recoverable term".** Two people
  independently got this wrong about tool results.
- **A green suite is not permission.** Three prompt rules were removed, the eval
  stayed 79/79, every guard stayed green, and the removal was still wrong. The
  corpus replays scripted responses; it cannot see what a real model would do.
