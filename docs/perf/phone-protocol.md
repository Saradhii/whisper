# Phone measurement protocol

**Why this exists: we cannot currently state this app's performance.** Every
number in `prefill-campaign.md` comes from a 4-core emulator on an M4 Pro host,
sharing a core with an unrelated runaway process. Token counts transfer between
machines; tokens per second do not. The product is an 8 GB Snapdragon-class
phone, and the goal — performance close to frontier apps despite running
locally — is a claim about that phone. Until the right-hand column of the table
below is filled in, the campaign has measured a proxy.

Budget about 15 minutes, most of it waiting. Steps 1-3 are one-time setup.

**The APK under test.** Never measure an APK whose provenance you cannot state;
re-pin these three fields whenever it is rebuilt.

| | |
|---|---|
| commit | `73e4092` (config C, n_ctx 8192, derived reserve, phrase gate, prewarm + prefix KV) |
| md5 | `901a5e3a70b57d66849fadc856a7fc9e` |
| built | 2026-09-05 02:53, clean tree, `main` frozen, exclusive `node_modules` |
| smoke test | **8/8 passed** (`scripts/smoke-release.py`), incl. a full turn and a clean logcat |

Verified by evidence, not assumption: the APK's Hermes bundle was extracted and
searched for markers of the newest commits. **Search both ASCII and UTF-16-LE** —
Hermes stores a string as UTF-16 if it contains any non-ASCII character, so
`'skipped planning — conversational turn'` (em dash) is invisible to an ASCII
grep and reads as a stale build. Confirmed present in this build: `much appreciated` and `take care` (ascii, the
phrase gate), `skipped planning` (utf-16, the fast path), `Never search` (ascii),
`Reference, not a request` (utf-16), `Dates:` (ascii, config C's date table at
the decision point).

> **The context-reserve bug is FIXED in this build.** It is recorded here
> because the numbers in the AVD column were taken before the fix. The reserve
> was a hand-tuned 2816 that measured as 4133 tokens needed against an `n_ctx`
> of 4096 — it overflowed, and `ctx_shift` discards from the FRONT with `n_keep`
> pinned at 0, so the first thing evicted was the tool catalog while the grammar
> kept the output looking well-formed: a confidently wrong tool call. The
> reserve is now derived from the prompt actually sent.
>
> This build also raises `n_ctx` 4096 → 8192 for the four models declaring 6 GB,
> on a measured +235 MB (VmRSS 1912 → 2147). Agent-mode history therefore goes
> from 896 to **4992 tokens** — worth a subjective check that a long tool
> conversation now holds the thread. The two 1.7B models targeting 4 GB devices
> stay at 4096.

> Provenance is not pedantry here. Two earlier builds of this APK were thrown
> away because agents committed to `main` while `expo prebuild && gradlew
> assembleRelease` was reading the working tree over ~6 minutes, so the bundle
> corresponded to no commit at all. Quiesce `main` before a release build, and
> record the commit and md5 immediately after.

---

## 0. What you need

- The 8 GB Android test phone, USB cable, developer options + USB debugging on.
- `adb` on PATH (`~/Library/Android/sdk/platform-tools`).
- The APK: `android/app/build/outputs/apk/release/app-release.apk`, built from
  `main` by `npm run build:apk`.

## 1. Install

```bash
adb devices -l                      # confirm exactly one device, and that it is the PHONE
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

`-r` upgrades in place and **keeps the downloaded model and your chats**. The
release build is signed with the standard Android debug keystore (see
`android/app/build.gradle`), which is stable across `prebuild --clean`, so an
existing install from a previous `build:apk` or GitHub release should upgrade
cleanly.

> If this fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, the installed copy
> was signed with a different key. Uninstalling would **delete the downloaded
> model** (~1.1 GB for Qwen3 1.7B) and force a re-download over wifi. Decide
> that deliberately; don't let a script do it.

## 2. One-time: turn on the trace

The per-phase timings are recorded by the in-app agent trace, which is **off by
default**. On the phone: **☰ menu → Settings → Developer → Agent trace**, toggle
on. (This is `devTrace` in `files/settings.json`.)

Confirm a model is active: the chat header should read `Qwen3 1.7B · tools ·
offline`. If not, download it on the Models screen first and let it finish.

**The active model MUST be tools-capable, and the header word `tools` is how you
check.** A model without `tools` (Gemma, the vision one) never reaches the agent
loop — every turn takes the plain-chat path — so it does no prewarm, writes no
prefix snapshot, and never runs a planning step. Run the protocol against such a
model and runs C and D measure nothing, which reads as "the feature is broken"
rather than "the feature does not apply here.

## 3. One-time: capture what the phone actually is

Nobody has yet seen which of llama.rn's seven native variants a real Snapdragon
loads, or whether it offers a Hexagon/OpenCL backend. This decides whether the
GPU-offload research is worth anything, and it is free to collect:

```bash
adb logcat -c
# now force-stop and reopen the app so the model loads fresh
adb shell am force-stop com.whisper.app
adb shell monkey -p com.whisper.app -c android.intent.category.LAUNCHER 1
sleep 45
adb logcat -d | grep -iE "rnllama|librnllama|backend|device|ggml|opencl|hexagon|adreno" \
  | head -60 | tee docs/perf/phone-backend.txt
```

What to look for in that output:

- `librnllama_jni_v8_2_*.so` — which variant loaded. The AVD loads
  `v8_2_dotprod_i8mm`. A real Snapdragon may load something else.
- Any `OpenCL` / `Adreno` / `HTP` device line — whether a GPU/NPU backend was
  even offered. Note llama.rn filters Hexagon out of the default device list
  (`shouldExcludeHexagonDevice`, `cpp/jsi/RNLlamaJSI.cpp:58-68`), so its absence
  is expected rather than informative.
- Whether the app took the CPU path. `files/gpu-probe.txt` on the phone records
  the verdict: `adb shell run-as com.whisper.app cat /data/data/com.whisper.app/files/gpu-probe.txt`.
  The AVD says `failed@8`. **If the phone says `ok@…`, every AVD number below is
  irrelevant to it** — it is running a different backend entirely, and that is
  the single most important thing this run can tell us.

## 4. The runs

Either drive it by hand, or run `python3 scripts/phone-bench.py phone` which
does steps A-D over adb and prints the trace. By hand:

| # | Run | How |
|---|---|---|
| A | **Cold first turn** | Force-stop, clear chats, reopen, wait for the model, send `hi` |
| B | **Warm conversational** | Immediately send `hi` again |
| C | **Warm tool turn** | Send `set an alarm for 7 tomorrow morning`, approve the card |
| D | **Second cold launch** | Force-stop and reopen WITHOUT clearing data, wait, send `hi` |

Clear chats before A only:

```bash
adb shell am force-stop com.whisper.app
adb shell run-as com.whisper.app rm -rf /data/data/com.whisper.app/files/chats
adb shell monkey -p com.whisper.app -c android.intent.category.LAUNCHER 1
```

**Run D is the one that tests the prefix-KV snapshot** (`2eba7ed`), which has
never been verified on any device. Its first turn should show a large `cache`
and a small `prefill`. Run D must be a **fresh launch with no `bench()` call
before it in that process** — see the warning at the bottom.

Read the numbers: **☰ → Settings → Agent trace**. Each row shows
`[cache N | prefill N tok N ms N t/s | decode N tok N ms N t/s]`. Newest first.
Screenshot it, or `adb shell uiautomator dump /sdcard/t.xml && adb shell cat /sdcard/t.xml`.

## 4b. When you are done

**Leave the release build installed.** It is the artifact that was actually
validated, and it is more useful sitting on the device than a dev client.

To go back to Metro/hot-reload afterwards, `npm run android` reinstalls the dev
build — and check which port it points at: the emulator was last pointed at a
worktree's Metro on **8082**, so a dev client may need repointing as well as
reinstalling. This is necessary because both builds share the package name and are both
debug-keystore-signed, so installing one silently REPLACES the other — if hot
reload has mysteriously stopped working, this is why.

## 5. Results

**Record re-evaluated TOKENS first and seconds second.** Token counts held at
0% spread across repeated runs last night while wall-clock varied 12-14% on a
host that reached load average 17.4 — prefill measured 3-8 tok/s against 65-73
earlier on the same AVD. Tokens are the hardware-independent quantity and the
thing every fix in this campaign actually moves; seconds are a property of the
machine you measured on. A phone on a quiet machine will produce very different
seconds, and someone will try to compare them across runs.

AVD figures are a **proxy and must not be quoted as product performance.**
Targets are from `prefill-campaign.md`.

| Measurement | AVD (proxy) | Target | **Phone** |
|---|---|---|---|
| **`gpu-probe.txt` verdict** | **`failed@8` (CPU)** | — | |
| **native lib variant** | **`v8_2_dotprod_i8mm`** | — | |
| A: cold turn, total | 13.8 s | — | |
| A: cold plan prefill (tok @ t/s) | 597 @ ~45 | — | |
| A: cold answer prefill | 79 tok | — | |
| B: warm conversational, total | 5.0 s | < 1 s TTFT | |
| B: planning row | *skipped (fast path)* | skipped | |
| B: answer prefill | 113 tok @ 32 t/s | — | |
| C: warm tool turn, total | not measured cleanly | — | |
| C: plan prefill | 305 tok @ 38 t/s | — | |
| D: prewarm drain, 1st vs 2nd cold launch | **297,467 ms → 14 ms** (verified) | ~0 ms | |
| D: restored cache vs freshly computed | identical to the token (1990/2077) | identical | |
| D: snapshot file size | 115.8 MiB, written once per prefix change | — | |
| Peak RSS during a turn | 2.30-2.40 GB | fits 8 GB | |

**Read the first two rows before anything else.** The AVD ran the CPU path
(`failed@8`). If the phone reads `ok@…`, it is running a different backend
entirely and every AVD figure below is irrelevant to it — not merely optimistic
or pessimistic, but measuring a different machine. That single file decides
whether tonight's proxy was ever the right proxy.

Baseline for comparison — the app **before** this campaign, same AVD:
cold turn **41.2 s**, warm turn **12.1 s**.

Also worth noting on the phone, since they are free:

- Time from tapping the icon to the chat being usable.
- Whether the prewarm is finished before you can realistically type (on the AVD
  it takes ~28 s; a phone should be several times faster). If a user can send
  before it completes, they wait at most one chunk — but confirm that is true
  rather than assuming it.
- Peak RSS: `adb shell dumpsys meminfo com.whisper.app | head -20`.

---

## Traps

These cost hours on the emulator. Most still apply to a phone.

- **`bench()` poisons the context.** `context.bench()` clears the KV cache
  (`rn-completion.cpp:961`, `:1033`) and never resets `embd`, so afterwards the
  next completion derives a large `n_past` from a stale token vector over an
  EMPTY cache. That produces exactly the large-`cache`/small-`prefill` signature
  that run D uses to verify the prefix snapshot — **a broken restore would read
  as a success.** Never bench and verify in the same process; reload between.
- **The saved conversation is restored on launch.** Without clearing
  `files/chats`, every run carries more history than the last and the numbers
  drift. Clear before A, and deliberately NOT before D.
- **The Send button moves when the keyboard opens.** Any scripted tap must read
  its live bounds; a fixed coordinate once launched Google Lens mid-run.
- **`adb shell input text` needs `%s` for spaces.**
- **Verifying a bundle: grep BOTH ASCII and UTF-16-LE.** Hermes stores a string
  as UTF-16 if it contains any non-ASCII character, and the two encodings are
  mixed within one bundle. On this very APK, `"Never search"` was found as ASCII
  while `"skipped planning"` (an em dash later in the same literal) and
  `"Reference, not a request"` existed only as UTF-16. An ASCII-only grep
  reports a current build as stale and costs you a needless rebuild — it nearly
  did here.
- **A release build does not need the dev-client deep link.** `monkey -p … 1`
  or `am start -n com.whisper.app/.MainActivity` opens the app directly. (On the
  *dev* build, `am start -n .MainActivity` opens the dev-launcher menu instead,
  which silently measures nothing — that trap does not apply here.)
- **Emulator CPU is not representative and its memory is.** Keep quoting AVD
  token counts; stop quoting AVD seconds the moment this table has a phone
  column.
