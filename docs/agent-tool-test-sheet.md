# Agent tool test sheet

Device-validation pass for the 18 tools in `src/agent/tools.ts`. Re-run this
whenever the agent loop, the prompt, or a tool schema changes — unit tests prove
the loop's mechanics, but only a real device shows what the model actually
decides.

**Environment for the run below:** `whisper-test` AVD (arm64, Android 16),
Qwen3 1.7B Q4_K_M, 2026-08-02.

> The AVD ships with `hw.ramSize = 2560` in `hardware-qemu.ini` even though
> `config.ini` says 6144M. At 2.5 GB the low-memory killer takes the app mid-turn
> (`low on swap … thrashing (302%)`). Relaunch with
> `emulator -avd whisper-test -memory 6144` before testing, or the results are noise.

## Fixtures

The emulator starts with no contacts, no calendars, and no photos, so seed them
(the data partition is a real image, so these survive a restart):

```sh
# permissions, so system dialogs don't steal focus mid-test
for p in READ_CALENDAR WRITE_CALENDAR READ_CONTACTS ACCESS_FINE_LOCATION \
         POST_NOTIFICATIONS READ_MEDIA_IMAGES; do
  adb shell pm grant com.whisper.app android.permission.$p
done

# contact: Arun Menon / +919845012345 / arun@example.com
adb shell content insert --uri content://com.android.contacts/raw_contacts \
  --bind account_name:n: --bind account_type:n:
adb shell "content insert --uri content://com.android.contacts/data --bind raw_contact_id:i:1 \
  --bind mimetype:s:vnd.android.cursor.item/name --bind data1:s:'Arun Menon'"
# …phone_v2 and email_v2 rows likewise

# a writable local calendar + one event
adb shell "content insert --uri 'content://com.android.calendar/calendars?caller_is_syncadapter=true&account_name=whisper.test&account_type=LOCAL' \
  --bind account_name:s:whisper.test --bind account_type:s:LOCAL --bind name:s:WhisperTest \
  --bind calendar_displayName:s:'Whisper Test' --bind calendar_access_level:i:700 \
  --bind ownerAccount:s:whisper.test --bind visible:i:1 --bind calendar_timezone:s:Asia/Kolkata"
```

Driving the app: `docs/agent-test-driver.sh` (new / say / wait / rows / allow / deny). It
reads the transcript out of the accessibility tree, which is far faster and more
reliable than screenshots — chip labels and statuses (`· failed`, `· denied`)
come through as text. Two gotchas it encodes: the Send button **moves** when the
IME opens (read its live bounds, never tap a fixed y — a stray tap launched
Google Lens and stole focus for the rest of the run), and `input text` needs
`%s` for spaces, so prompts must be plain ASCII.

## Results

| # | Tool | Prompt | Result |
|---|---|---|---|
| 1 | `get_battery` | "How much battery do I have left" | **PASS** — 1 call, "at 100% and not charging" |
| 2 | `write_clipboard` | "Copy hello world to my clipboard" | **PASS** — chip `Copy to clipboard (11 chars)` |
| 3 | `read_clipboard` | "What is on my clipboard" | **PASS** — round-trip, read back "hello world" |
| 4 | `set_brightness` | "Dim the screen to 30 percent" | **PASS** (see F9 — app-window only) |
| 5 | `open_url` | "Open anthropic.com in the browser" | **PASS** — Chrome launched (see F5) |
| 6 | `open_maps` | "Show me Cubbon Park on the map" | **PASS** — Maps launched with the query |
| 7 | `list_calendar_events` | "What is on my calendar this week" | **PARTIAL** — found the event, but range was Aug 2→Aug 3 (F3) |
| 8 | `create_calendar_event` | "…lunch with Priya on Friday at 1pm" | **FAIL** — wrote Mon Aug 3 12:00, title "Put lunch with Priya" (F2) |
| 9 | `schedule_reminder` | "…call the plumber at 6pm today" | **FAIL** — proposed 4:00 PM (F2) |
| 10 | `search_contacts` | "What is Arun phone number" | **PASS** — number + email correct |
| 11 | `search_contacts`→`compose_sms` | "Text Arun that I am running ten minutes late" | **PASS** — 2-tool chain, right number |
| 12 | `compose_email` | "Email arun@example.com with the subject Project update" | **PASS** — Gmail launched |
| 13 | `web_search` | "Search the web for the capital of Bhutan" | **PASS** — real results, Thimphu |
| 14 | `web_fetch` | "Read the page at https://example.com…" | **PASS** — quoted actual page text |
| 15 | `get_location` | "Where am I right now" | **NOT VERIFIED** — emulator has no GPS fix (F10); error path reported honestly |
| 16 | `search_phone_media` | "Find my beach photos" | **FAIL** — missed `beach_sunset.png` (F7) |
| 17 | `set_alarm` | "Set an alarm for 7 tomorrow morning" | **PASS** — exactly one `SET_ALARM` intent in logcat |
| 18 | `schedule_reminder` (relative) | "Remind me to stretch in an hour" | **PASS** — sent 1:26 PM → scheduled 2:26 PM |
| N1 | general knowledge | "What is a good stretch for lower back pain" | **FAIL** — searched, then described the search (F5, F6) |
| N2 | pure conversation | "Thanks that is all for now" | **FAIL** — called `web_fetch` on example.com (F4) |
| N3 | no matching tool | "Delete my 9am meeting tomorrow" | **FAIL** — proposed to *create* it (F8) |
| N4 | denial | deny any confirmation card | **FAIL** — answer claimed the action was done (F1) |
| N5 | repeat suppression | any repeated decision | **PASS** — second identical call never reaches the tool |

## Findings

**F1 — a denied action is reported as done.** *(highest severity: this is the
one thing the harness exists to prevent.)* Deny the reminder card and the reply
is "I already scheduled the reminder for 6 pm today." Two causes: the repeat
suppression message says "you already made this exact call", which reads as
confirmation of success; and `answerNote()` has no denial branch — a denial
increments neither `ran` nor `failures`, so it lands in the generic
"no action taken" text, which the model overrides.

**F2 — ISO datetime arguments are unreliable.** "Friday at 1pm" → Mon Aug 3
12:00. "6pm today" → 4:00 PM. Meanwhile `set_alarm`, which takes `hour` and
`minute` as **integers**, has been correct on every run. The model can pick
numbers; it cannot render a correct ISO-8601 string. The fix is to stop asking
it to.

**F3 — the "Tomorrow is …" anchor contaminates date ranges.** Added to fix
relative times, it made absolute dates worse: the week range collapsed to
today→tomorrow, and several wrong dates landed exactly on tomorrow. Needs a
range anchor of its own ("this week runs … to …") rather than a lone salient date.

**F4 — the model copies literal URLs out of the worked examples.** The
`web_search` example's result contains `https://example.com`; on a pure-chat
turn the planner called `web_fetch` on it. Same class as the date warning, which
is in the prompt — the URL was not.

**F5 — over-eager second tools.** `web_fetch` after `open_url`; `web_search`
after `get_location` failed; `web_search` for general knowledge. Never harmful
(all reads) but slow and noisy.

**F6 — answers describe the search instead of answering.** "I searched for
stretches and found several resources, including articles" — the results were in
context and went unused. Also the odd past tense on reads ("The battery **was**
at 100%"). `answerNote()` treats every tool as an action; reads need their own
instruction.

**F7 — `search_phone_media` matches the whole query against the filename.**
"beach photos" misses `beach_sunset.png`. Needs tokenising and dropping generic
words (photo/picture/image/video/file/my).

**F8 — no delete tool, so it reached for create.** "Delete my 9am meeting"
proposed creating "9am meeting". The confirmation card is the only thing between
the model and a wrong mutation — a good argument for keeping them.

**F9 — `set_brightness` is app-window only.** `expo-brightness.setBrightnessAsync`
dims Whisper, not the system, but the reply says "I dimmed the screen". Product
decision, not a bug.

**F10 — `get_location` unverifiable on this AVD.** `dumpsys location` shows
`last location=null` for every provider even after `adb emu geo fix` and
`location_mode 3`. Needs a real device.

## After the fixes — re-verified on device

| Finding | Fix | Re-test |
|---|---|---|
| F1 denial narrated as done | `answerNote` gained a refusal branch that outranks every other; the suppression message now restates the real outcome instead of "you already made this exact call" | "I did not create the event. Let me know what you would like instead." **PASS** |
| F2 wrong datetimes | `schedule_reminder` / `create_calendar_event` / `list_calendar_events` take `date` + `hour` + `minute` instead of ISO strings — the shape `set_alarm` already used successfully | "Friday at 1pm" → Fri Aug 7, 1:00 PM; "10pm today" → 10:00 PM; "in an hour" at 17:36 → 6:35 PM. **PASS** |
| F3 tomorrow-anchor contamination | the lone "Tomorrow is …" line became a full 7-day date table plus an explicit week range | "this week" → Sun Aug 2 → Sat Aug 8. **PASS** |
| F4 example.com copied | the URL is gone from the worked example's result | no stray `web_fetch`. **PASS** |
| F5 over-eager tools | **root cause was not the planner.** The removed recovery phase forced a tool whenever a yes/no probe guessed the user wanted one — and the probe's own question listed the tools, priming a yes | "Thanks that is all for now" → answers directly, no tool. **PASS** |
| F6 answers describe the search | `mutates` on each tool splits the answer note: actions get past tense, reads get "answer the question, present tense" | "There **is** a meeting titled 'Intoglo tech meeting'…". **PASS** |
| F7 media whole-string match | `mediaMatches()` tokenises and drops generic words | "Find my beach photos" → finds `beach_sunset.png`. **PASS** |
| F8 create instead of delete | prompt rule against substituting a tool that does something else; the confirmation card remains the real guard | not re-tested |
| F9 app-only brightness | unchanged — product decision | n/a |
| F10 no GPS fix | environment | n/a |

### Two things worth carrying forward

**The planning note is a user message, and length changes its meaning.** Once the
date table went in, the note became the longest and most recent user text in the
window, and the planner started answering *it* — "Thanks that is all for now"
drew a web search for "current time", lifted from "It is currently…". It is now
labelled `[Reference, not a request — …]` and the user's own words are repeated
last, right before the decision.

**Argument descriptions were never being shown.** `toolCatalog` rendered
`hour: integer` and dropped every `.describe()`. Hints like "1pm is 13 and 6pm
is 18" and "minute 0 unless a specific minute was asked for" were written,
tested, and invisible. Rendering them is what finally fixed the minutes.

**Anchors leak.** Twice now, a helpful value in the note was copied into an
unrelated argument: "Tomorrow is 2026-08-03" became the end of every date range,
and "in an hour 22:59" became the minute of "at 10pm". Anything put in the note
must be fenced to the case it serves.

### Still open

- **F5 residual:** stray reads still happen occasionally after a denial
  (`web_search` for the event title). Harmless, but noisy.
- **Titles keep the imperative:** "Put lunch with Priya on my calendar" still
  becomes an event titled "Put lunch with Priya", despite the tool description
  asking for the event name only.
- **F8, F10** not re-verified.
