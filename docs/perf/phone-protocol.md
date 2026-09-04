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
| commit | `10f9134` (includes A1 append-only layout, the fast path, prewarm + prefix KV) |
| md5 | `59be33e3c18d1e764c08a3a95d15c47d` |
| built | 2026-09-05 01:10, from a clean tree with `main` frozen |

Verified by evidence, not assumption: the APK's Hermes bundle was extracted and
searched for markers of the newest commits. **Search both ASCII and UTF-16-LE** —
Hermes stores a string as UTF-16 if it contains any non-ASCII character, so
`'skipped planning — conversational turn'` (em dash) is invisible to an ASCII
grep and reads as a stale build. Confirmed present: `Never search` (ascii),
`skipped planning` (utf-16), `Reference, not a request` (utf-16).

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

## 5. Results

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
| D: 2nd cold launch, first-turn `cache` | **unverified** | large | |
| D: 2nd cold launch, first-turn prefill | **unverified** | small | |
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
- **A release build does not need the dev-client deep link.** `monkey -p … 1`
  or `am start -n com.whisper.app/.MainActivity` opens the app directly. (On the
  *dev* build, `am start -n .MainActivity` opens the dev-launcher menu instead,
  which silently measures nothing — that trap does not apply here.)
- **Emulator CPU is not representative and its memory is.** Keep quoting AVD
  token counts; stop quoting AVD seconds the moment this table has a phone
  column.
