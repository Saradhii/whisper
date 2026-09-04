#!/usr/bin/env python3
"""Smoke-test a RELEASE APK on a connected device.

usage: python3 scripts/smoke-release.py [path-to-apk]

Why this exists: `assembleRelease` succeeding proves the build ran, not that the
app runs. Minification and ProGuard are applied at BUILD time, so a stripped
class or a missing keep rule fails at LAUNCH — and a release nobody has started
has not been shipped, it has been compiled. Everything here is a checklist a
person would otherwise do by hand at the end of a long night and skip.

The load-bearing check is the logcat scan: ClassNotFoundException /
NoSuchMethodError are what a bad keep rule actually looks like, and they can be
caught and swallowed by a screen that merely renders empty. Do not judge a
release by "it opened".

DESTRUCTIVE: `install -r` REPLACES whatever build of com.whisper.app is on the
device. The debug/dev-client build and the release build share a package name
and are both debug-keystore-signed, so this silently swaps them. Metro-based
work needs the dev build reinstalled afterwards. Run it last.
"""
import os, re, subprocess, sys, time

ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
PKG = "com.whisper.app"
DEFAULT_APK = "android/app/build/outputs/apk/release/app-release.apk"

# What a stripped class or missing keep rule actually looks like at runtime.
FATAL = [
    "ClassNotFoundException",
    "NoSuchMethodError",
    "NoSuchFieldError",
    "UnsatisfiedLinkError",
    "AndroidRuntime: FATAL",
    "ReactNativeJS.*(Error|Exception)",
]

results = []


def sh(*args, timeout=180):
    return subprocess.run([ADB] + list(args), capture_output=True, text=True,
                          timeout=timeout).stdout


def say(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    say(f"  {'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    return ok


def dump():
    for _ in range(4):
        sh("shell", "uiautomator", "dump", "/sdcard/smoke.xml")
        x = sh("shell", "cat", "/sdcard/smoke.xml")
        if "<node" in x:
            return x
        time.sleep(1)
    return ""


def find(xml, needle):
    """Centre of the first node whose text or content-desc contains `needle`."""
    for n in re.finditer(r"<node[^>]*>", xml):
        node = n.group(0)
        if needle in node:
            b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
            if b:
                x1, y1, x2, y2 = map(int, b.groups())
                return (x1 + x2) // 2, (y1 + y2) // 2
    return None


def back():
    sh("shell", "input", "keyevent", "KEYCODE_BACK")
    time.sleep(2)


def main():
    apk = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_APK
    if not os.path.exists(apk):
        say(f"!! no APK at {apk}")
        return 1

    devs = [l.split()[0] for l in sh("devices").splitlines()[1:] if l.strip().endswith("device")]
    if len(devs) != 1:
        say(f"!! expected exactly one device, found {len(devs)}: {devs}")
        return 1
    say(f"device: {devs[0]}")
    say(f"apk:    {apk}")
    say("NOTE: this REPLACES the installed build (dev client included).")

    say("installing")
    out = sh("install", "-r", apk, timeout=600)
    if not check("install", "Success" in out, out.strip().splitlines()[-1] if out.strip() else "no output"):
        return 1

    sh("logcat", "-c")
    say("launching")
    sh("shell", "am", "force-stop", PKG)
    time.sleep(1)
    sh("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")

    # Alive after 20s means it got past init, not merely that it started.
    time.sleep(20)
    pid = sh("shell", "pidof", PKG).strip()
    if not check("process alive 20s after launch", bool(pid), f"pid={pid or 'none'}"):
        say("  (a crash at launch is the classic missing-keep-rule signature)")

    # The model can take a while; the chat shell should render well before it.
    xml = dump()
    check("chat screen rendered", "Ask anything" in xml)
    check("header shows a model", bool(re.search(r'text="[^"]*(offline|tools)[^"]*"', xml)))

    say("opening Models (exercises catalog reflection ProGuard may strip)")
    menu = find(xml, "Menu: chats, settings and models")
    models_ok = False
    if menu:
        sh("shell", "input", "tap", str(menu[0]), str(menu[1]))
        time.sleep(2)
        drawer = dump()
        m = find(drawer, "Models")
        if m:
            sh("shell", "input", "tap", str(m[0]), str(m[1]))
            time.sleep(4)
            mx = dump()
            # A stripped catalog renders an empty list, not a crash.
            models_ok = "Qwen" in mx or "Gemma" in mx
            check("Models screen lists the catalog", models_ok)
            back()
        else:
            check("Models entry in drawer", False)
        back()
    else:
        check("drawer menu found", False)

    say("opening Settings and the trace screen")
    sh("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "whisper://agent-trace", PKG)
    time.sleep(4)
    tx = dump()
    check("Agent trace screen opens", "Agent trace" in tx or "Trajectory" in tx)
    back()

    say("one full turn (this needs a downloaded model; may take minutes)")
    xml = dump()
    c = find(xml, "Ask anything")
    turn_ok = False
    if c:
        sh("shell", "input", "tap", str(c[0]), str(c[1]))
        time.sleep(2)
        sh("shell", "input", "text", "hi")
        time.sleep(1.5)
        s = find(dump(), "Send message")
        if s:
            sh("shell", "input", "tap", str(s[0]), str(s[1]))
            # Poll for a reply rather than guessing a duration.
            for _ in range(120):
                time.sleep(5)
                rx = dump()
                if "Read reply aloud" in rx or "Regenerate reply" in rx:
                    turn_ok = True
                    break
        check("one turn produced a reply", turn_ok,
              "" if turn_ok else "no reply within 10 min (is a model downloaded?)")
    else:
        check("composer available for a turn", False)

    say("scanning logcat")
    # Filter to OUR process. Scanning the whole buffer flags unrelated system
    # noise as a release blocker, which is worse than not checking: a smoke test
    # that cries wolf gets ignored on the night it is right.
    pid_now = sh("shell", "pidof", PKG).strip().split()
    log = sh("logcat", "-d", "-v", "brief", f"--pid={pid_now[0]}") if pid_now else ""
    if not log:
        # Process died, so its pid is gone — that IS the interesting case. Fall
        # back to the whole buffer and keep only lines naming the package.
        log = "\n".join(l for l in sh("logcat", "-d", "-v", "brief").splitlines()
                         if PKG in l or "AndroidRuntime" in l)
    hits = []
    for line in log.splitlines():
        if any(re.search(pat, line) for pat in FATAL):
            hits.append(line.strip()[:160])
    check("logcat clean of keep-rule failures", not hits, "; ".join(hits[:3]))

    print()
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"=== {passed}/{len(results)} checks passed ===")
    for name, ok, detail in results:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}{(' — ' + detail) if detail and not ok else ''}")
    if passed != len(results):
        print("\nA failure here is a RELEASE blocker, not a flake: the dev build")
        print("does not exercise minification, so this is the only place it shows.")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
