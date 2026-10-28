#!/bin/bash
# Idle baseline: waits for XCALE_DURATION (10s by default; 30s, 5m, 1h or plain seconds).
to_seconds() {
  case "$1" in
    *h) echo $(( ${1%h} * 3600 )) ;;
    *m) echo $(( ${1%m} * 60 )) ;;
    *s) echo "${1%s}" ;;
    '') echo "$2" ;;
    *) echo "$1" ;;
  esac
}
total=$(to_seconds "$XCALE_DURATION" 10)
echo "idle for ${total}s on $(hostname)"
for ((i = 0; i < total; i += 5)); do
  sleep $(( total - i < 5 ? total - i : 5 ))
  echo "elapsed $(( i + 5 < total ? i + 5 : total ))s / ${total}s"
done
echo done
