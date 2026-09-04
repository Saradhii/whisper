# Model strategy — tracked bets

Four model-level bets. All four are in scope; they are ordered by return on
effort, not by appeal. Nothing here is merged without a Phase 0 scored run
showing it actually helped — that is the whole point of doing the eval harness
first.

Status: `planned` / `in progress` / `landed` / `dropped`.

---

## 1. Harness-only improvements — **highest ROI, do first**

**Status:** planned
**Cost:** low. No training, no new runtime, no download-size change.
**Expected gain:** most of the available accuracy, per the 2026 literature.

Per-model prompt and grammar profiles; selective tool disclosure; worked-example
tuning per model family; sampler settings per phase. The published result that
harness-only changes moved an agent from rank 30 to top 5 is the case for
exhausting this before touching weights.

Caveat worth designing against: the "Constraint Tax" finding — GBNF eliminates
malformed calls but cannot steer the model to the *right* tool among valid ones,
and structured-output constraints can actively suppress tool-calling propensity.
Constraint plus examples plus validation, never constraint alone.

Depends on: Phase 0. Feeds: Phase 1, Phase 3.

## 2. Speculative decoding — **DEMOTED 2026-09-05. Feasible, and not worth doing.**

**Status:** feasibility CONFIRMED, priority dropped to last
**Cost:** medium. Extra 300–500 MB resident and downloaded, on devices already
at 8 GB.
**Expected gain on this app: about one second.**

The feasibility question this entry was waiting on is answered: `llama.rn`
0.12.5 exposes the whole surface — `model_draft`/`draft_model`, a `speculative`
config on both the context and the completion, and `spec_draft_n_max` /
`n_min` / `p_min` / `p_split` / `n_gpu_layers` / `cache_type_k` / `cache_type_v`.
No patch to `llama.rn` is needed. This entry's stated blocker is gone.

It is being demoted anyway, because the premise underneath it was wrong.
"The answer phase is the long pole" is false. Measured on the test AVD with
Qwen3-1.7B-Q4_K_M, reproducible to ~0.1%:

    cold plan    prefill 2333 tok @ 63 t/s = 37,206 ms | decode  5 tok   288 ms
    cold answer  prefill   79 tok @ 35 t/s =  2,197 ms | decode 22 tok 1,325 ms
    warm plan    prefill  305 tok @ 38 t/s =  8,076 ms | decode  5 tok   308 ms
    warm answer  prefill   79 tok @ 36 t/s =  2,271 ms | decode 22 tok 1,377 ms

**The turn is ~92% prompt evaluation.** Decode is healthy at 16–17 tok/s and
accounts for about 1.6 seconds of a 41-second cold turn. Speculative decoding
accelerates decode and nothing else, so its best case here is to save roughly a
second — for 300–500 MB of resident memory on an 8 GB device that has already
had to fight for RAM (see the `no_extra_bufts` comment in `LlamaEngine.ts`).

That is a bad trade today. It becomes a good one only if prefill is reduced far
enough that decode is actually the long pole, which is what the prefill work is
for. **Revisit only when a measurement shows decode above ~30% of a turn.**

The general lesson is worth more than the bet: this entry ranked second for a
year on an unmeasured assumption about which half of inference was slow. The
latency instrumentation in Phase 0 existed precisely to prevent that, and the
ranking was never re-checked against it.

Depends on: nothing now. Feeds: Phase 2, if it ever comes back.

## 3. Tool-calling LoRA — **highest ceiling, gated on measurement**

**Status:** planned
**Cost:** high. Needs a training-data pipeline, a training budget, and adapter
hot-swap plumbing.
**Expected gain:** likely the single largest accuracy jump for a 1.7–3B planner.
The Berkeley Function Calling Leaderboard puts 1–3B at reliable single-turn tool
use only, and fine-tuned open models in the 7–20B range have beaten frontier
closed models on the same benchmark — the gap is trainable.

Train an adapter on Whisper's own 18 tool schemas and hot-swap it for the
planning phase only, leaving the answer phase on the base weights.
llama.cpp supports LoRA adapter sets and control vectors at runtime.

**Plumbing confirmed 2026-09-05.** `llama.rn` 0.12.5 exposes `lora` /
`lora_scaled` / `lora_list` at context creation and, more importantly,
`applyLoraAdapters()` / `removeLoraAdapters()` / `getLoadedLoraAdapters()` on a
live context — so the hot-swap this bet needs does not require a new context or
a library patch. The "adapter hot-swap plumbing" listed under Cost is already
there; what remains is the training pipeline and the data.

Deliberately after Phase 0: without scored evals there is no way to tell a real
gain from a lucky demo, and no way to build the training set from real
trajectories. The recorder built in Phase 0 *is* the data pipeline.

Depends on: Phase 0 (hard). Feeds: Phase 3.

## 4. LiteRT-LM engine — **independent track, unblocks better models**

**Status:** planned (carried over from the original multi-engine plan)
**Cost:** high. A second engine implementation behind the existing
`src/engines/` interface.
**Expected gain:** memory-mapped per-layer embeddings mean Gemma E4B-class models
become viable on 8 GB, where llama.cpp's GGUF path materializes all ~8B raw
params (~5 GB) plus a ~1 GB F16 mmproj and gets the app killed.

The `EngineKind` union and `ModelSpec.engine` field already anticipate this, so
it slots in without touching the UI. Runs parallel to the phases; not on the
critical path for voice.

Depends on: nothing. Feeds: Phase 6.

---

## Sequencing

```
Phase 0 ──┬─> (1) harness-only ──> Phase 1, Phase 3
          ├─> (3) LoRA ──────────> Phase 3      [uses Phase 0 recorder as data]
          └─> (2) speculative ───> Phase 2      [DEMOTED: buys ~1s of a 41s turn]

(4) LiteRT-LM ─────────────────────> Phase 6    [independent, start any time]
```

**The bet that was missing from this list entirely.** None of the four is the
biggest available win. The turn is ~92% prefill, and most of that prefill is
scaffolding the model has already seen: a 1736-token system message re-evaluated
on cold start, and a volatile tail after the cached prefix that is rebuilt on
every generation because the per-turn note sits after the history rather than
before it. That is a prompt-LAYOUT problem, costs nothing in memory, needs no
new model, and is invisible from a model-strategy document — which is why it
went unlisted while a decode optimization sat at number two. Tracked as the
prefill campaign; see `docs/perf/` and the KV-cache notes in `prompt.ts`.
