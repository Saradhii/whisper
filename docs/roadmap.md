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
78 scenarios / 79 turns, 100% on completion, tool, args and answer, mean 1.82
planning steps, 0 drift. The floors in `src/agent/eval/corpus.test.ts` are a
ratchet — raise them when the harness improves, never lower one to green a build.
They are absolute turn counts, so ADDING scenarios must raise them too, or the
new turns are free to regress unnoticed.

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

**Second finding, same shape, 2026-09-05.** On the emulator the shipping app
answered "what is the capital of France" with `web_search` on one turn and
`search_contacts` on the next — a scan of the address book for a fact the model
then stated from its own knowledge anyway, and an extra plan/execute/prefill
cycle each time. The corpus already had the scenario: `chat-known-fact`, that
exact question, `calls: []`. It scored green throughout, because a `noTool()`
script emits `{"respond": true}` however the prompt reads — it asserts the script
back at itself. Measured: with every piece of no-tool teaching reverted to what
shipped, the old scenario still passed. So a no-tool scenario written that way
pins the LOOP (nothing forces a tool where the planner chose none, which is the
regression it was written for) and pins nothing about the prompt.

`noToolUnlessTaught(guard, tempted, answer)` in `eval/scenarios/define.ts` is the
falsifiable form: it scripts the planner observed on device — one that reaches
for `tempted` unless `guard`, quoted from the rendered prompt, is there to stop
it. Five scenarios tagged `guarded` use it, and each was confirmed to go red on
its own when the rule, tool description, or worked example it quotes is removed.
It proves the teaching cannot be deleted silently, which is the risk during a
token-trimming pass; it does not prove a 1.7B model obeys it, which still needs a
live run. Note that `expect.calls: []` was never the missing primitive — the
missing primitive was a script that could produce a different answer.

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
  The recommendation trap inside it is fixed (2026-09-05): Qwen3 4B leads the
  catalog and carries the word "Recommended", Gemma stays suggested for vision
  with a description that names what it cannot do, and the models screen prints
  `· tools` / `· chat only` on every card. `src/models/catalog.test.ts` pins the
  invariants. Gemma will never get `tools: true` — its 2048-token window is
  smaller than `TOOL_PROMPT_RESERVE` (2816), and with `ctx_shift` pinned at
  `n_keep: 0` the overflow would discard the system message, i.e. the tool
  catalog itself.
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
- ~~Gemma default cannot run tools; `nCtx: 2048` floors history at 512~~ — fixed
  2026-09-05, see Phase 6.
- Model catalog compiled into the binary (Phase 6).
- No schema version field on any persisted store (Phase 1).
- `Math.random()` conversation IDs (Phase 6) — reviewed 2026-09-05 and judged
  untidy, not a risk: `src/chat/store.ts` mints `c${ms36}${rand36}` only inside
  `saveCurrent` on a human-initiated new chat, and the ids are device-local with
  no sync, so a collision needs two conversations created in the same
  millisecond on one phone. Left alone; changing the format touches persisted
  keys for no user-visible gain.
- Trace buffer has no export path (Phase 0 subsumes this).

## 2026-09-12 device pass — user-reported, all on a real phone

Found in one session of actually using v1.1.0 as shipped; each fix landed with
its replay scenario, and the floors went 79 → 81 with them.

- **New chat mid-turn leaked the turn into the new conversation** (reported:
  the loader sitting alone in an empty chat). `DrawerMenu`'s new-chat / open /
  delete-current paths swapped the transcript while `runAgent` kept streaming
  into it; the turn-end save then persisted the old answer into the new chat's
  file. Fixed with a generation counter in `app/index.tsx` (`turnRef`) whose
  stale guard drops every late callback, plus `abortTurn()` wired through
  `onBeforeSwitch`. Model switch and delete were already safe — `LlamaEngine`
  serializes load/unload behind a running completion.
- **"Turn on the torch light" set screen brightness instead** — there was no
  torch tool, and the planner did nearest-neighbour matching. `toggle_torch`
  added (Expo local module `modules/whisper-torch/`, `CameraManager
  .setTorchMode`, no camera session), scenario `dev-torch-on` pins the pick.
  The failed retry the same transcript showed — level 100 rejected, "fixed it
  to 1" — is the second finding: `set_brightness`'s description now spells out
  the divide-by-100 mapping, scenario `dev-brightness-full-percent`.
- **web_search answered with links dressed as results**, twice, even after
  "I want to see the results not links". The search itself was healthy (the
  DuckDuckGo markup still matches the parser — verified live); what was missing
  is the instruction to fetch a result page when the results are links, now in
  the `web_search`/`web_fetch` descriptions. A live-model check is still owed
  here — the replay corpus can only pin that the teaching exists.
- **`toolCatalog()` dropped JSON-schema `enum`** — `search_phone_media
  .media_type` reached the model as bare `string` (predicted in the prefill
  campaign, confirmed by the same session's transcript patterns). Enum values
  now render in the catalog line; `toolCatalog` test pins it.
- **No app version visible anywhere** — Settings now renders
  `Whisper <version> (<versionCode>)` under the privacy note, so a screenshot
  names the exact build.
- The reserve ratchet paid for it knowingly: TOOL_PROMPT_RESERVE 3200 → 3286,
  each of the 86 tokens traceable to one of the fixes above, ~4900 tokens of
  history left at nCtx 8192.

## 2026-09-12 live-model pass — the web-search fix, measured

The v1.2.0 description-level teaching (fetch the page when results are links)
did not survive contact with the real planner. The real-model harness, run on
Windows for the first time (node-llama-cpp runner + Qwen3-1.7B-Q4_K_M, vulkan),
reproduced the phone exactly: with a block of links in the transcript, the
planner answered "The search results show that there is a live cricket score at
https://example.org/scores" — no fetch, with the hint in view. Teaching is not
enough at 1.7B; the harness now does the reading.

- `web_search` auto-fetches the top result and returns its page text ahead of
  the remaining links (`parse.ts renderSearchTurn`, `tools.ts readPage`); the
  fixture mirrors the shape. `web-search-delivers` pins it — its scripted
  respond decision keys on the page text, so a fixture or executor regression
  reddens it.
- `answerNote` gained an `emptySearch` branch: a search that ran and found
  nothing must be answered with the absence, never with a sentence about the
  searching (the second half of the phone report).
- New ablation `fetched-page`: cutting the page from the result flips
  web-search-delivers red live ("the exact match result is not provided
  here"), which is the falsifiability proof the hint version never had.
- Live web-subset scores, same model, same seed: completed 3/10 → 4/10 and
  answers 6/10 → 7/10 with the fix; the ablated arm loses web-search-delivers
  specifically. Still owed live: the two-step web chain (web-search-then-fetch
  stays red live — a 1.7B taking a THIRD decision), web-fetch-given-url
  (open_url chosen for a read), web-maps-nearest (no call at all).
