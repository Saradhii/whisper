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
- **The layout defeats it.** In a real turn with history and tool calls, the plan
  phase left a 2695-token prompt in the cache and the answer phase shared only
  1975 of it: ~720 tokens discarded and rebuilt, twice in one turn, ~11s each at
  67 t/s. The per-turn note sits *after* the history, so every phase change
  invalidates everything from the note onward.

That last one is the largest recoverable cost in the app, and it is a
TypeScript problem — no native work, no model change.

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
On a turn that calls a tool, the dominant rebuilt term is the tool RESULT
payload, not the note.

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
