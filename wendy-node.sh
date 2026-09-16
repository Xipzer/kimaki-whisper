#!/usr/bin/env bash
# wendy-node - run Wendy on any node, hand over between nodes without losing state.
#
#   wendy-node status              what is running where
#   wendy-node sync   <from>       pull Wendy's state from another node (safe, read-only there)
#   wendy-node promote [from]      become the active Wendy: sync, stop the other node, start here
#   wendy-node demote  <to>        stop here and push state to the node that is taking over
#
# ONE bot token = ONE live Wendy. promote/demote enforce that.
# Node names are ssh aliases (mac, projector, printer) - LAN or tailnet, whatever ssh resolves.
set -euo pipefail

STATE_DIR="$HOME/.kimaki-whisper"
REPO="$HOME/WebstormProjects/kimaki-whisper"
# what travels: memory, telegram offset/profiles, ledgers, pins, triggers, config.
# what does NOT: runtime/ (750MB ONNX, per-node), diagnostics/ (per-node audit), logs.
SYNC_PATHS=(workspace telegram config.json)

log() { printf '[wendy-node] %s\n' "$*"; }
here() { hostname -s 2>/dev/null || hostname; }

running_here() { pgrep -f "kimaki-whisper/dist/cli.js" >/dev/null 2>&1 && ! pgrep -f "dist/cli.js serve" >/dev/null 2>&1; }
running_on()   { ssh -o ConnectTimeout=6 -o BatchMode=yes "$1" 'pgrep -f "kimaki-whisper/dist/cli.js" >/dev/null 2>&1 && ! pgrep -f "dist/cli.js serve" >/dev/null 2>&1' 2>/dev/null; }

stop_here() {
  if running_here; then
    log "stopping Wendy on $(here)"
    pkill -TERM -f "restart-wend[y].sh" 2>/dev/null || true
    pkill -TERM -f "kimaki-whisper/dist/cli.j[s]" 2>/dev/null || true
    for _ in $(seq 1 12); do running_here || break; sleep 1; done
    pkill -9 -f "kimaki-whisper/dist/cli.j[s]" 2>/dev/null || true
  fi
}
stop_on() {
  if running_on "$1"; then
    log "stopping Wendy on $1"
    ssh -o BatchMode=yes "$1" 'pkill -TERM -f "restart-wend[y].sh"; pkill -TERM -f "kimaki-whisper/dist/cli.j[s]"; sleep 8; pkill -9 -f "kimaki-whisper/dist/cli.j[s]"' 2>/dev/null || true
  fi
}
start_here() {
  log "starting Wendy on $(here)"
  cd "$REPO"
  # Node config: each node keeps its OWN service endpoints in node.json and they
  # override whatever came across in config.json (brainUrl/speachesUrl/port).
  if [ -f "$STATE_DIR/node.json" ]; then
    python3 - "$STATE_DIR/config.json" "$STATE_DIR/node.json" <<'EOF'
import json, sys
cfg = json.load(open(sys.argv[1])); node = json.load(open(sys.argv[2]))
cfg.update({k: v for k, v in node.items() if v is not None})
json.dump(cfg, open(sys.argv[1], 'w'), indent=2)
print('[wendy-node] applied node overrides:', ', '.join(f'{k}={v}' for k, v in node.items()))
EOF
  fi
  setsid ./restart-wendy.sh </dev/null >/dev/null 2>&1 &
  for i in $(seq 1 25); do sleep 3; running_here && grep -aq "armed - will follow" "$STATE_DIR/wendy.log" 2>/dev/null && { log "Wendy up on $(here)"; return 0; }; done
  log "WARNING: Wendy did not report armed within 75s - check $STATE_DIR/wendy.log"
  return 1
}

do_sync() {
  local from="$1"
  log "syncing state from $from -> $(here)"
  mkdir -p "$STATE_DIR"
  # snapshot the other side's state first (no partial reads of live files)
  ssh -o BatchMode=yes "$from" "cd ~/.kimaki-whisper && tar czf /tmp/wendy-state.tgz ${SYNC_PATHS[*]} 2>/dev/null" 
  scp -q "$from:/tmp/wendy-state.tgz" /tmp/wendy-state.tgz
  # keep a rollback of what was here
  [ -d "$STATE_DIR/workspace" ] && tar czf "$STATE_DIR/state-before-sync-$(date +%s).tgz" -C "$STATE_DIR" "${SYNC_PATHS[@]}" 2>/dev/null || true
  tar xzf /tmp/wendy-state.tgz -C "$STATE_DIR"
  log "state synced ($(du -sh "$STATE_DIR/workspace" | cut -f1) workspace, $(du -sh "$STATE_DIR/telegram" | cut -f1) telegram)"
}

cmd="${1:-status}"
case "$cmd" in
  status)
    for n in "$(here)" mac projector printer; do
      [ "$n" = "$(here)" ] && { running_here && s="ACTIVE" || s="standby"; echo "  $n (this node): $s"; continue; }
      ssh -o ConnectTimeout=5 -o BatchMode=yes "$n" true 2>/dev/null || { echo "  $n: unreachable"; continue; }
      running_on "$n" && echo "  $n: ACTIVE" || echo "  $n: standby"
    done
    ;;
  sync)
    [ -n "${2:-}" ] || { echo "usage: wendy-node sync <from-node>"; exit 2; }
    do_sync "$2"
    ;;
  promote)
    from="${2:-}"
    if [ -z "$from" ]; then
      for n in mac projector printer; do [ "$n" = "$(here)" ] && continue; running_on "$n" 2>/dev/null && { from="$n"; break; }; done
    fi
    if [ -n "$from" ]; then
      if ssh -o ConnectTimeout=6 -o BatchMode=yes "$from" true 2>/dev/null; then
        do_sync "$from"
        stop_on "$from"
      else
        log "WARNING: $from unreachable - promoting with LOCAL state (last sync). Run 'wendy-node sync $from' when it is back."
      fi
    else
      log "no other active node found - promoting with local state"
    fi
    stop_here
    start_here
    ;;
  demote)
    [ -n "${2:-}" ] || { echo "usage: wendy-node demote <to-node>"; exit 2; }
    stop_here
    log "pushing state $(here) -> $2"
    tar czf /tmp/wendy-state.tgz -C "$STATE_DIR" "${SYNC_PATHS[@]}"
    scp -q /tmp/wendy-state.tgz "$2:/tmp/wendy-state.tgz"
    ssh -o BatchMode=yes "$2" 'mkdir -p ~/.kimaki-whisper && cd ~/.kimaki-whisper && tar czf state-before-sync-$(date +%s).tgz workspace telegram config.json 2>/dev/null; tar xzf /tmp/wendy-state.tgz -C ~/.kimaki-whisper'
    log "state pushed. Now on $2 run: wendy-node promote"
    ;;
  *) sed -n 2,9p "$0"; exit 2 ;;
esac
