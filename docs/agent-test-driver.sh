#!/bin/bash
# Drive the Whisper chat on the emulator and read the transcript back as text.
# Usage:
#   t.sh new                 start a fresh chat
#   t.sh say "some text"     type it and send
#   t.sh wait                block until the turn ends or a confirm card appears
#   t.sh rows                print the transcript
#   t.sh allow | t.sh deny   answer a pending confirmation card
set -u
DUMP=/sdcard/wt.xml

dump() { adb shell uiautomator dump $DUMP >/dev/null 2>&1; adb shell cat $DUMP 2>/dev/null; }
tree() { dump | tr '>' '\n'; }

case "${1:-}" in
  new)
    adb shell input tap 76 224; sleep 2
    adb shell input tap 94 220; sleep 3
    ;;
  say)
    # %s is input-text's space escape; the prompt must stay plain ASCII.
    esc=$(printf '%s' "$2" | sed 's/ /%s/g')
    adb shell input tap 500 2260; sleep 1
    adb shell input text "$esc"; sleep 1
    # The input row slides up when the IME opens, so Send is NOT where it was.
    # Read its live bounds — a fixed tap lands on the keyboard (and once
    # launched Google Lens, which then stole focus for the rest of the run).
    b=$(tree | grep -oE 'content-desc="Send message"[^/]*bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' \
        | grep -oE '\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]' | tail -1)
    x1=$(echo "$b" | sed 's/\[\([0-9]*\),.*/\1/'); y1=$(echo "$b" | sed 's/\[[0-9]*,\([0-9]*\)\].*/\1/')
    x2=$(echo "$b" | sed 's/.*\[\([0-9]*\),[0-9]*\]$/\1/'); y2=$(echo "$b" | sed 's/.*,\([0-9]*\)\]$/\1/')
    adb shell input tap $(( (x1+x2)/2 )) $(( (y1+y2)/2 ))
    echo "sent: $2"
    ;;
  wait)
    for i in $(seq 1 60); do
      sleep 8
      body=$(dump)
      echo "$body" | grep -q 'Regenerate reply' && { echo "DONE"; exit 0; }
      echo "$body" | grep -q 'text="Deny"' && { echo "CARD"; exit 0; }
    done
    echo "TIMEOUT"; exit 1
    ;;
  rows)
    tree | grep -oE '(content-desc|text)="[^"]{2,}"' \
      | sed 's/^content-desc="//;s/^text="//;s/"$//' \
      | grep -vE '^(Menu: chats|Whisper$|Qwen3|Live voice mode|Voice input|Ask anything|Send message|Send$|Read reply aloud|Regenerate reply|Stop$)' \
      | awk '!seen[$0]++'
    ;;
  allow|deny)
    label=$([ "$1" = allow ] && echo Allow || echo Deny)
    b=$(tree | grep -oE "text=\"$label\"[^/]*bounds=\"\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]\"" \
        | grep -oE '\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]' | tail -1)
    x1=$(echo "$b" | sed 's/\[\([0-9]*\),.*/\1/'); y1=$(echo "$b" | sed 's/\[[0-9]*,\([0-9]*\)\].*/\1/')
    x2=$(echo "$b" | sed 's/.*\[\([0-9]*\),[0-9]*\]$/\1/'); y2=$(echo "$b" | sed 's/.*,\([0-9]*\)\]$/\1/')
    adb shell input tap $(( (x1+x2)/2 )) $(( (y1+y2)/2 ))
    echo "tapped $label at $(( (x1+x2)/2 )),$(( (y1+y2)/2 ))"
    ;;
  *) echo "usage: t.sh new|say <text>|wait|rows|allow|deny"; exit 2;;
esac
