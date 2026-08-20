# Whisper — production roadmap

**Positioning:** the private voice assistant that works in flight mode. Voice-first,
acts on your phone through structured tools, remembers you, and provably sends
nothing anywhere.

**Platform:** Android to production first. iOS follows once the harness is proven.

**Monetization:** one-time paid unlock. Free = chat + read-only tools. Paid =
memory, automations, documents, premium voices, full model library. No server, so
the zero-backend privacy claim stays literally true.

---

## Why this order

The 2026 evidence is that the harness, not the model, decides whether an agent
works — harness-only changes have moved agents from rank 30 to top 5 on the same
benchmark. But you cannot tune a harness you cannot measure, and today every
prompt change is validated by hand on an emulator. So the eval harness comes
first and everything after it is gated on it.

The second constraint is arithmetic. `TOOL_PROMPT_RESERVE` is 2816 tokens of a
4096-token window: 69% scaffolding, leaving ~1280 tokens (about six turns) for
the actual conversation before `trimToBudget` starts deleting what the user said.
An assistant that forgets you after six turns cannot be sold. Context and memory
are therefore Phase 1, before any new capability.

Everything else is capability on top of those two foundations.

---

## Phase 0 — Eval harness — **LANDED 2026-08-08**

**Gate: no later phase merges without a green scored run.**

Run it with `npm run eval` (score table) or `npm run check` (gate). Current:
74 scenarios / 75 turns, 100% on completion, tool, args and answer, mean 1.95
planning steps, 0 drift. The floors in `src/agent/eval/corpus.test.ts` are a
ratchet — raise them when the harness improves, never lower one to green a build.

**Finding worth keeping.** The first acceptance run passed for the wrong reason.
Reintroducing the old GBNF quoting bug failed only the pre-existing
`grammar.test.ts`; all 77 scenarios stayed green, because the fixture engine read
`opts.grammar` solely to decide whether to stream and never checked its CONTENT.
The corpus was scoring a clean run against a grammar that on a real device breaks
every tool call. `assertProducible()` in `eval/engine.ts` now rejects any canned
decision the constrained sampler could not have emitted; the same experiment now
fails 23 tests across 3 files. The general lesson for later phases: a fixture
that cannot reproduce a known-shipped bug is not yet a gate, so every phase
should re-run its own deliberate-regression check rather than trusting a green
suite.

- Trajectory recorder behind the existing `devTrace` seam in `src/agent/trace.ts`;
  records plan decisions, tool calls with arguments, results, and timings as
  replayable JSONL.
- Scenario corpus, ~60 tasks across all 18 tools, seeded from
  `docs/agent-tool-test-sheet.md`. Each scenario declares its expected final
  state, not just an expected string.
- Node-side replay runner with a fixture engine, so prompt and grammar changes
  are regression-tested without a device.
- Scored metrics: task completion, tool correctness, **argument correctness**,
  step count, wall-clock per phase. Argument correctness is the one that catches
  the date/hour/minute class of bug that has burned this project repeatedly.
- Latency instrumentation split by phase (prefill / plan / tool / answer / TTS) —
  Phase 2 depends on having these numbers before design.
- Wired into `npm run check` with a scored floor that ratchets upward.

**Exit:** a single command produces a score table; a deliberate regression in
`prompt.ts` is caught by it.

**Known limitations of the contract, to fix when they start costing something:**

- `expectWorld` is all-or-nothing. `WorldSchema.partial()` lifts only the outer
  keys, so any `expectWorld` expands to a full-world assertion and a scenario
  must restate `world.failing` verbatim just to assert `alarms: []`. Wants a
  deep-partial variant, or `failing` excluded from the diff as config rather
  than state.
- No way to assert "this call was suppressed". Suppressed decisions never reach
  a tool, so suppression is only observable indirectly (two alarms vs one) and
  is invisible for reads, where suppressing and not suppressing look identical.
  Wants `expect.suppressed` or a decision count.
- `world.failing` is a fixed map, so "fails once, then succeeds" is unscriptable
  and the recover-after-transient-failure path is untested.
- `opened[].detail` has no specified format, so sms/dialer/maps handoffs are
  asserted via call arguments instead of final state.

## Phase 1 — Context and memory

- Tool-result trimming, then session summarization, then a persistent fact store
  (`USER.md`-equivalent) with agent-callable read/write memory tools. Mem0-style
  "what did the user tell me" facts; Letta-style explicit agent control over
  what gets promoted to long-term.
- Selective tool disclosure, PalmClaw-style: a one-line summary of every tool
  always in context, full schema and worked example only for matched tools.
- Schema versioning and migrations across all persisted stores (chats, settings,
  models, memory) — currently absent, and a format change today has no path.

**Target:** reserve 2816 → ~1600, useful history 1280 → ~2500 tokens, plus
unbounded recall through memory. Verified by Phase 0 scores, not by feel.

## Phase 2 — Voice through the agent

Today `app/live.tsx` calls `engineFor(active).generate` directly. It never
touches `runAgent` or `TOOLS`, so the flagship surface cannot do anything. This
is the product.

- Route live voice through `runAgent`.
- Spoken confirmation flow for `requiresConfirmation` tools — the tap-to-confirm
  card has no hands-free equivalent yet.
- **Latency budget, set from Phase 0 numbers.** STT → plan → tool → answer → TTS
  is a long chain on-device; if time-to-first-audio exceeds ~2.5s the surface
  fails regardless of accuracy. Mitigations in priority order: speak an
  acknowledgement during planning, stream TTS off the answer phase, shrink the
  planning prompt, draft-model speculative decoding (see `model-strategy.md`).
- Barge-in and cancellation that reach `signal.aborted`, not just `engine.stop()`.

## Phase 3 — Harness depth

- Structured permissions: `readOnly` / `destructive` / `idempotent` annotations
  replacing the single `requiresConfirmation` boolean; persistent per-tool grants
  ("always allow alarms"); an audit log the user can read.
- Plan scratchpad for multi-step tasks, and parallel independent calls — "find
  Arun's number, text him, add it to my calendar" is the task class that
  justifies the price and is structurally impossible at `MAX_STEPS = 4` with one
  call per turn.
- Verification step for mutating chains.
- Per-model prompt and grammar profiles. Qwen, Llama and Phi differ enough that
  one prompt cannot be right for all of them.
- Raise `MAX_STEPS` only on Phase 0 evidence.

## Phase 4 — Proactive

- Scheduled and triggered agent turns via notifications; Android foreground
  service where required.
- Automations UI ("every morning, summarize my day").
- Battery and thermal guards — a local model waking up on a schedule is a
  battery complaint waiting to happen.

## Phase 5 — Documents

- llama.cpp embeddings plus an on-device vector index over user-chosen documents,
  notes, and photo metadata; `search_my_documents` as a tool.
- Incremental indexing that survives backgrounding.

Paid-tier flagship. Fully local RAG on mobile is production-stable as of 2026.

## Phase 6 — Ship

- Remote-updatable model catalog with signed manifests. Today the catalog is
  compiled in, so a dead Hugging Face URL bricks onboarding until a store release.
- Device-aware onboarding that picks a model instead of showing a wall of GGUFs.
  Must also resolve the current trap: **Gemma is the recommended default and
  cannot run the agent** — no `tools: true`, and `nCtx: 2048` floors the history
  budget at 512 tokens. Either fix it or say so in the UI.
- Entitlement and paywall (one-time unlock, on-device receipt validation).
- Local-only diagnostics; crash reporting that does not break the privacy claim.
- Replace `Math.random()` conversation IDs.
- Play Store listing, privacy disclosures, screenshots.

---

## Parallel track

`docs/model-strategy.md` — four model-level bets, ordered by ROI, run alongside
the phases rather than blocking them.

## Known issues logged during the 2026-08-07 audit

- `app/live.tsx` bypasses the agent entirely (Phase 2).
- Gemma default cannot run tools; `nCtx: 2048` floors history at 512 (Phase 6).
- Model catalog compiled into the binary (Phase 6).
- No schema version field on any persisted store (Phase 1).
- `Math.random()` conversation IDs (Phase 6).
- Trace buffer has no export path (Phase 0 subsumes this).
