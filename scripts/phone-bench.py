#!/usr/bin/env python3
"""Whisper latency bench for a REAL PHONE running the release APK.

usage: python3 scripts/phone-bench.py <label> [message] [settle_seconds]

Runs the protocol in docs/perf/phone-protocol.md: a cold turn, a warm turn, and
a second cold launch that exercises the prefix-KV snapshot. Drives the real UI
over adb and reports the in-app agent trace's per-phase timings.

PREREQUISITES (see the protocol doc):
  * Release APK installed, a model downloaded and active.
  * Settings -> Developer -> Agent trace turned ON, or every timing row is empty.
  * Exactly one device attached, and it is the phone.

Differs from the emulator harness in two ways: a release build is launched
directly (no dev-client deep link), and nothing here calls context.bench(),
which would poison the context and fake a cache hit on the run-D check.
"""
import os, re, subprocess, sys, time

ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
PKG = "com.whisper.app"
SP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "perf")
# A release build IS the app; no dev-launcher deep link needed.
LAUNCH = ("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")


def sh(*args, timeout=120):
    return subprocess.run([ADB] + list(args), capture_output=True, text=True,
                          timeout=timeout).stdout


def say(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def pid():
    return sh("shell", "pidof", PKG).strip()


def rss_kb():
    p = pid()
    if not p:
        return 0
    out = sh("shell", f"cat /proc/{p}/status 2>/dev/null | grep VmRSS")
    m = re.search(r"(\d+)", out)
    return int(m.group(1)) if m else 0


def jiffies():
    p = pid()
    if not p:
        return None
    out = sh("shell", f"cat /proc/{p}/stat 2>/dev/null | awk '{{print $14+$15}}'")
    m = re.search(r"(\d+)", out)
    return int(m.group(1)) if m else None


def dump():
    """uiautomator dump -> xml text. Retries: it fails mid-animation."""
    for _ in range(4):
        sh("shell", "uiautomator", "dump", "/sdcard/b.xml")
        x = sh("shell", "cat", "/sdcard/b.xml")
        if "<node" in x:
            return x
        time.sleep(1)
    return ""


def find(xml, needle, attr=None):
    """Center of the node whose content-desc or text contains `needle`."""
    for node in re.finditer(r"<node[^>]*>", xml):
        n = node.group(0)
        if attr:
            if not re.search(attr + r'="[^"]*' + re.escape(needle) + r'[^"]*"', n):
                continue
        elif needle not in n:
            continue
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        if b:
            x1, y1, x2, y2 = map(int, b.groups())
            return (x1 + x2) // 2, (y1 + y2) // 2
    return None


def user_msg_count(xml):
    """How many user bubbles are on screen (to verify a send landed)."""
    return len(re.findall(r'content-desc="You said', xml)) or \
           len(re.findall(r'class="android\.widget\.TextView"[^>]*text="hi"', xml))


def wait_idle(label, max_s=600):
    """Wait for a busy -> idle transition in app CPU."""
    busy = False
    idle = 0
    prev = jiffies()
    t0 = time.time()
    while time.time() - t0 < max_s:
        time.sleep(1.0)
        cur = jiffies()
        if cur is None or prev is None:
            prev = cur
            continue
        d = cur - prev
        prev = cur
        if d > 80:          # >80% of one core => generating
            busy = True
            idle = 0
        elif busy:
            idle += 1
            if idle >= 4:
                return time.time() - t0
    return None


def send(text):
    """Tap composer, type, tap Send. Verifies the composer actually focused."""
    c = None
    for _ in range(30):                 # Metro may still be bundling
        xml = dump()
        c = find(xml, "Ask anything", attr="text")
        if c:
            break
        time.sleep(2)
    if not c:
        say("  !! composer not found")
        return False
    sh("shell", "input", "tap", str(c[0]), str(c[1]))
    time.sleep(2)
    sh("shell", "input", "text", text.replace(" ", "%s"))
    time.sleep(1.5)
    xml = dump()                      # Send MOVES when the IME opens
    s = find(xml, "Send message", attr="content-desc")
    if not s:
        say("  !! send button not found")
        return False
    sh("shell", "input", "tap", str(s[0]), str(s[1]))
    return time.time()


def read_trace(label):
    # The release build has no custom scheme wired for this route in all cases;
    # the deep link is tried first and the caller is told to navigate by hand if
    # the dump comes back without timing rows.
    sh("shell", "am", "start", "-a", "android.intent.action.VIEW",
       "-d", "whisper://agent-trace", PKG)
    time.sleep(4)
    xml = dump()
    open(f"{SP}/trace-{label}.xml", "w").write(xml)
    vals = [v for v in re.findall(r'text="([^"]+)"', xml) if v.strip()]
    rows = []
    for i, v in enumerate(vals):
        if re.fullmatch(r"\d+ms", v):
            kind = vals[i - 1] if i else "?"
            rows.append((kind, int(v[:-2])))
    sh("shell", "input", "keyevent", "KEYCODE_BACK")
    time.sleep(1)
    sh("shell", "input", "keyevent", "KEYCODE_BACK")
    return rows


def require_phone():
    """Refuse to run against an emulator.

    This script force-stops the app and deletes its saved chats. The emulator is
    owned by whoever is benchmarking there, and clobbering it mid-run would
    silently corrupt their numbers as well as ours.
    """
    out = subprocess.run([ADB, "devices"], capture_output=True, text=True).stdout
    devices = [l.split()[0] for l in out.splitlines()[1:] if l.strip().endswith("device")]
    if len(devices) != 1:
        say(f"!! expected exactly one device, found {len(devices)}: {devices}")
        say("   unplug the others, or stop the emulator, and retry.")
        return False
    if devices[0].startswith("emulator-"):
        say(f"!! {devices[0]} is an EMULATOR. This script is for the phone only.")
        say("   Emulator runs belong to the device agent; use the AVD harness there.")
        return False
    say(f"device: {devices[0]}")
    return True


def main():
    label = sys.argv[1] if len(sys.argv) > 1 else "run"
    msg = sys.argv[2] if len(sys.argv) > 2 else "hi"
    settle = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    say(f"=== PHONE BENCH: {label} (message: {msg!r}) ===")
    if not require_phone():
        return

    sh("shell", "am", "force-stop", PKG)
    time.sleep(2)
    # Clear the saved conversation. It is restored on launch, so without this
    # each run starts with MORE history than the last and the comparison drifts.
    sh("shell", "run-as", PKG, "sh", "-c", "rm -rf /data/data/com.whisper.app/files/chats")
    say("cold launch (chat history cleared)")
    t_launch = time.time()
    sh(*LAUNCH)

    for _ in range(90):
        if rss_kb() > 900_000:
            say(f"model resident after {time.time()-t_launch:.0f}s (RSS {rss_kb()//1024} MB)")
            break
        time.sleep(2)
    else:
        say("!! model never became resident")
        return
    say(f"settling {settle}s (lets any prewarm finish)")
    time.sleep(settle)

    results = {}
    for n, name in ((1, "cold"), (2, "warm")):
        say(f"turn {n} ({name})")
        t_send = send(msg)
        if not t_send:
            say("send failed")
            return
        el = wait_idle(name)
        # From the Send tap to idle, minus the 4 idle samples the detector
        # needs to declare the turn over. This is what the user actually waits.
        wall = (time.time() - t_send) - 4.0
        if el is None:
            say(f"  turn {n} TIMEOUT")
        else:
            say(f"  turn {n} wall={wall:.1f}s  RSS={rss_kb()//1024} MB")
        results[name] = wall
        time.sleep(3)

    # Run D: a SECOND cold launch, deliberately WITHOUT clearing chats, to
    # exercise the on-disk prefix-KV snapshot (commit 2eba7ed, never verified on
    # any device). Its first turn should show a large `cache` and a small
    # `prefill`. Nothing in this process has called bench(), which is what makes
    # that signature trustworthy rather than an artifact of a stale embd.
    say("run D: second cold launch (prefix snapshot)")
    sh("shell", "am", "force-stop", PKG)
    time.sleep(3)
    sh(*LAUNCH)
    for _ in range(90):
        if rss_kb() > 900_000:
            break
        time.sleep(2)
    time.sleep(settle)
    t_send = send(msg)
    if t_send:
        el = wait_idle("coldD")
        say(f"  run D wall={(time.time()-t_send-4.0):.1f}s  RSS={rss_kb()//1024} MB")
    else:
        say("  run D send failed")

    say("reading trace")
    rows = read_trace(label)
    print(f"\n--- TRACE [{label}] ---")
    for kind, ms in rows:
        print(f"  {ms:7d} ms   {kind}")
    total = sum(ms for _, ms in rows)
    print(f"  {total:7d} ms   TOTAL (all phases, both turns)")
    print(f"\n  wall: cold={results.get('cold',0):.1f}s  warm={results.get('warm',0):.1f}s")
    if not rows:
        print("\n  !! No timing rows. Either Settings -> Developer -> Agent trace")
        print("     is OFF, or the trace screen did not open — navigate to it by")
        print("     hand and screenshot it instead.")
    print("\n  Rows are newest first: run D, then warm, then cold.")
    print("  Fill these into the Phone column of docs/perf/phone-protocol.md.")


if __name__ == "__main__":
    main()
