#!/usr/bin/env bash
# Atomic, SUPERVISED singleton restart for the JARVIS sidecar.
# - kills every existing instance (pattern + port holder)
# - runs a supervisor loop: respawns on crash (any exit), backs off 3s,
#   but stops permanently on exit 2 (= duplicate-instance guard) so two
#   supervisors can never fight over the port.
# - durable log at ~/.kimaki-whisper/jarvis.log (survives /tmp wipes),
#   rotated at 5 MB.
cd "$(dirname "$0")"
LOG="$HOME/.kimaki-whisper/jarvis.log"
PIDFILE="$HOME/.kimaki-whisper/jarvis.pid"
mkdir -p "$HOME/.kimaki-whisper"

pkill -9 -f 'kimaki-whisper/dist/cli.js' 2>/dev/null
for i in 1 2 3 4 5; do
  P=$(ss -ltnp 2>/dev/null | grep ':7071' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1)
  [ -z "$P" ] && break
  kill -9 "$P" 2>/dev/null
  sleep 1
done
sleep 2

# rotate log if >5MB
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  tail -c 1048576 "$LOG" > "$LOG.1" && mv "$LOG.1" "$LOG"
fi

export PATH="$HOME/.local/bin:$HOME/.kimaki/bin:$PATH"
(
  while :; do
    node dist/cli.js >> "$LOG" 2>&1 &
    CHILD=$!
    echo "$CHILD" > "$PIDFILE"
    wait "$CHILD"
    CODE=$?
    if [ "$CODE" -eq 2 ]; then
      echo "[supervisor] duplicate-instance guard (exit 2) — standing down" >> "$LOG"
      break
    fi
    echo "[supervisor] sidecar exited ($CODE) — respawning in 3s" >> "$LOG"
    sleep 3
  done
) &
disown
sleep 10
echo "── restart-jarvis: child=$(cat "$PIDFILE" 2>/dev/null) log=$LOG" >> "$LOG"
