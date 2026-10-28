#!/bin/bash
# CPU stress: one busy loop per core for XCALE_DURATION (20s by default; 30s, 15m, 1h or plain seconds).
to_seconds() {
  case "$1" in
    *h) echo $(( ${1%h} * 3600 )) ;;
    *m) echo $(( ${1%m} * 60 )) ;;
    *s) echo "${1%s}" ;;
    '') echo "$2" ;;
    *) echo "$1" ;;
  esac
}
total=$(to_seconds "$XCALE_DURATION" 20)
cores=$(nproc)
echo "stressing ${cores} cores for ${total}s on $(hostname)"
pids=()
for ((c = 0; c < cores; c++)); do
  ( while :; do :; done ) &
  pids+=($!)
done
trap 'kill "${pids[@]}" 2>/dev/null; echo "stopped early"; exit 143' TERM HUP INT
for ((i = 0; i < total; i += 5)); do
  sleep $(( total - i < 5 ? total - i : 5 ))
  echo "elapsed $(( i + 5 < total ? i + 5 : total ))s / ${total}s"
done
kill "${pids[@]}" 2>/dev/null
echo done
