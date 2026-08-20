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

## 2. Speculative decoding — **second, because voice-first makes latency the product**

**Status:** planned, feasibility unverified
**Cost:** medium. Extra 300–500 MB resident and downloaded, on devices already
at 8 GB.
**Expected gain:** 1.5–2.5× on the answer phase per llama.cpp benchmarks.

Small draft model alongside the main one. Matters here specifically because
Phase 2's time-to-first-audio budget is the make-or-break number for a voice
assistant, and the answer phase is the long pole.

**Unverified and must be checked before committing:** whether `llama.rn` exposes
llama.cpp's draft-model parameters at all. If it does not, this becomes a patch
to `llama.rn` (there is already a `patches/` directory) or it drops below LoRA.

Depends on: Phase 0 latency instrumentation. Feeds: Phase 2.

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
          ├─> (2) speculative ───> Phase 2      [verify llama.rn support first]
          └─> (3) LoRA ──────────> Phase 3      [uses Phase 0 recorder as data]

(4) LiteRT-LM ─────────────────────> Phase 6    [independent, start any time]
```
