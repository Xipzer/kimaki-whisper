#!/usr/bin/env bash
# wendy-node - every node runs the same process; node.json `role` decides
# whether Wendy herself (home bot token) is live there. The own-domain gateway
# (this device's Kimaki bot) never stops. Handover = flip roles + reload.
#
#   wendy-node status                  roles and liveness across nodes
#   wendy-node role [primary|standby]  show, or set + reload THIS node
#   wendy-node sync   <from>           pull Wendy's state from another node
#   wendy-node promote [from]          become primary: sync, demote <from>, flip here
#   wendy-node demote  <to>            flip here to standby, push state to <to>
#   wendy-node handover <from> <to>    hub-driven move for nodes that cannot ssh each other
#   wendy-node reload                  restart the local process (supervisor/launchd respawns)
#
# ONE bot token = ONE live Wendy. Roles are flipped on the node that owns the
# process; this script never kills a process on another machine.
# Node names are ssh aliases (mac, projector, printer).
set -euo pipefail

STATE_DIR="$HOME/.kimaki-whisper"
REPO="$HOME/WebstormProjects/kimaki-whisper"
NODE_JSON="$STATE_DIR/node.json"
# what travels: memory, telegram offset/profiles, ledgers, pins, triggers, config.
# what does NOT: node.json (per-node endpoints, role, own token), runtime/, diagnostics/, logs.
SYNC_PATHS=(workspace telegram config.json)
NODES=(printer projector mac)

log() { printf '[wendy-node] %s\n' "$*"; }
here() { python3 -c "import json;print(json.load(open('$NODE_JSON')).get('name',''))" 2>/dev/null || hostname -s; }
remote() { ssh -o ConnectTimeout=6 -o BatchMode=yes "$1" "cd ~/WebstormProjects/kimaki-whisper && ./wendy-node.sh ${*:2}"; }

pid_here() { pgrep -f "kimaki-whisper/dist/cli.j[s]" 2>/dev/null | head -1 || true; }
role_here() { python3 -c "import json;print(json.load(open('$NODE_JSON')).get('role','primary'))" 2>/dev/null || echo primary; }
set_role() {
  python3 - "$NODE_JSON" "$1" <<'EOF'
import json, sys
p, role = sys.argv[1], sys.argv[2]
try: n = json.load(open(p))
except FileNotFoundError: n = {}
n['role'] = role
json.dump(n, open(p, 'w'), indent=2)
EOF
  log "role on $(here): $1"
}

node_get() { python3 -c "import json;print(json.load(open('$NODE_JSON')).get('$1',''))" 2>/dev/null || true; }

# Reload = TERM the local process and let whatever supervises it respawn
# (restart-wendy.sh loop, or launchd KeepAlive). If nothing is running, start
# via node.json startCommand (default: the supervisor script).
reload_here() {
  local pid; pid=$(pid_here)
  if [ -n "$pid" ]; then
    log "reloading (pid $pid)"
    local n0; n0=$(wc -l < "$STATE_DIR/wendy.log" 2>/dev/null || echo 0)
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 15); do sleep 1; [ -z "$(pid_here)" ] && break; done
    [ -n "$(pid_here)" ] && { log "WARNING: pid $pid survived TERM"; kill -9 "$pid" 2>/dev/null || true; }
    sleep 4
    [ -n "$(pid_here)" ] && { wait_ready "$n0"; return; }
    log "no supervisor respawned it - starting"
  fi
  local start; start=$(node_get startCommand)
  cd "$REPO"
  if [ -n "$start" ]; then bash -c "$start"; else setsid ./restart-wendy.sh </dev/null >/dev/null 2>&1 & fi
  wait_ready 0
}
wait_ready() {
  local want="node gateway connected\|role: standby"
  [ "$(role_here)" = primary ] && want="armed - will follow"
  for _ in $(seq 1 25); do
    sleep 3
    tail -n +"$(( $1 + 1 ))" "$STATE_DIR/wendy.log" 2>/dev/null | grep -aq "$want" && { log "up on $(here) as $(role_here)"; return 0; }
  done
  log "WARNING: not ready within 75s - check $STATE_DIR/wendy.log"; return 1
}

do_sync() {
  local from="$1"
  log "syncing state from $from -> $(here)"
  mkdir -p "$STATE_DIR"
  ssh -o BatchMode=yes "$from" "cd ~/.kimaki-whisper && tar czf /tmp/wendy-state.tgz ${SYNC_PATHS[*]} 2>/dev/null"
  scp -q "$from:/tmp/wendy-state.tgz" /tmp/wendy-state.tgz
  [ -d "$STATE_DIR/workspace" ] && tar czf "$STATE_DIR/state-before-sync-$(date +%s).tgz" -C "$STATE_DIR" "${SYNC_PATHS[@]}" 2>/dev/null || true
  tar xzf /tmp/wendy-state.tgz -C "$STATE_DIR"
  log "state synced ($(du -sh "$STATE_DIR/workspace" | cut -f1) workspace, $(du -sh "$STATE_DIR/telegram" | cut -f1) telegram)"
}
apply_incoming() {
  [ -f "$STATE_DIR/incoming/.synced" ] || return 0
  local age=$(( $(date +%s) - $(cat "$STATE_DIR/incoming/.synced") ))
  log "using pushed state from the active node ($((age/60)) min old)"
  tar czf "$STATE_DIR/state-before-sync-$(date +%s).tgz" -C "$STATE_DIR" "${SYNC_PATHS[@]}" 2>/dev/null || true
  cp -r "$STATE_DIR/incoming/workspace" "$STATE_DIR/incoming/telegram" "$STATE_DIR/incoming/config.json" "$STATE_DIR/" 2>/dev/null || true
}
push_state() {
  tar czf /tmp/wendy-state.tgz -C "$STATE_DIR" "${SYNC_PATHS[@]}"
  scp -q /tmp/wendy-state.tgz "$1:/tmp/wendy-state.tgz"
  ssh -o BatchMode=yes "$1" 'mkdir -p ~/.kimaki-whisper && cd ~/.kimaki-whisper && tar czf state-before-sync-$(date +%s).tgz workspace telegram config.json 2>/dev/null; tar xzf /tmp/wendy-state.tgz -C ~/.kimaki-whisper'
}

cmd="${1:-status}"
case "$cmd" in
  status)
    me=$(here)
    for n in "${NODES[@]}"; do
      if [ "$n" = "$me" ]; then
        [ -n "$(pid_here)" ] && s="running" || s="DOWN"
        echo "  $n (this node): $(role_here) / $s"; continue
      fi
      r=$(ssh -o ConnectTimeout=5 -o BatchMode=yes "$n" 'cd ~/WebstormProjects/kimaki-whisper 2>/dev/null && ./wendy-node.sh role 2>/dev/null; pgrep -f "kimaki-whisper/dist/cli.j[s]" >/dev/null 2>&1 && echo running || echo DOWN' 2>/dev/null) || { echo "  $n: unreachable"; continue; }
      echo "  $n: $(echo "$r" | tr '\n' ' ')"
    done
    ;;
  role)
    if [ -n "${2:-}" ]; then
      case "$2" in primary|standby) ;; *) echo "role must be primary|standby"; exit 2;; esac
      set_role "$2"; reload_here
    else role_here; fi
    ;;
  reload) reload_here ;;
  sync)
    [ -n "${2:-}" ] || { echo "usage: wendy-node sync <from-node>"; exit 2; }
    do_sync "$2"
    ;;
  promote)
    apply_incoming
    from="${2:-}"
    if [ -z "$from" ]; then
      for n in "${NODES[@]}"; do
        [ "$n" = "$(here)" ] && continue
        [ "$(ssh -o ConnectTimeout=5 -o BatchMode=yes "$n" 'cd ~/WebstormProjects/kimaki-whisper && ./wendy-node.sh role' 2>/dev/null)" = primary ] && { from="$n"; break; }
      done
    fi
    if [ -n "$from" ]; then
      if ssh -o ConnectTimeout=6 -o BatchMode=yes "$from" true 2>/dev/null; then
        do_sync "$from"
        remote "$from" role standby
      else
        log "WARNING: $from unreachable - it may still hold the Wendy token. Promoting with LOCAL state; run 'wendy-node role standby' there as soon as it is back."
      fi
    else
      log "no other primary found - promoting with local state"
    fi
    set_role primary; reload_here
    ;;
  demote)
    [ -n "${2:-}" ] || { echo "usage: wendy-node demote <to-node>"; exit 2; }
    set_role standby; reload_here
    log "pushing state $(here) -> $2"; push_state "$2"
    log "state pushed. Now: wendy-node promote  (on $2)   or:   ssh $2 'cd ~/WebstormProjects/kimaki-whisper && ./wendy-node.sh promote'"
    ;;
  handover)
    from="${2:-}"; to="${3:-}"
    [ -n "$from" ] && [ -n "$to" ] || { echo "usage: wendy-node handover <from> <to>"; exit 2; }
    log "handover $from -> $to (driven from $(here))"
    if [ "$from" = "$(here)" ]; then set_role standby; reload_here; tar czf /tmp/wendy-state.tgz -C "$STATE_DIR" "${SYNC_PATHS[@]}"
    else remote "$from" role standby; ssh -o BatchMode=yes "$from" "cd ~/.kimaki-whisper && tar czf /tmp/wendy-state.tgz ${SYNC_PATHS[*]}"; scp -q "$from:/tmp/wendy-state.tgz" /tmp/wendy-state.tgz; fi
    if [ "$to" = "$(here)" ]; then
      tar czf "$STATE_DIR/state-before-sync-$(date +%s).tgz" -C "$STATE_DIR" "${SYNC_PATHS[@]}" 2>/dev/null || true
      tar xzf /tmp/wendy-state.tgz -C "$STATE_DIR"; set_role primary; reload_here
    else
      scp -q /tmp/wendy-state.tgz "$to:/tmp/wendy-state.tgz"
      ssh -o BatchMode=yes "$to" 'cd ~/.kimaki-whisper && tar czf state-before-sync-$(date +%s).tgz '"${SYNC_PATHS[*]}"' 2>/dev/null; tar xzf /tmp/wendy-state.tgz -C ~/.kimaki-whisper'
      remote "$to" role primary
    fi
    ;;
  *) sed -n 5,13p "$0"; exit 2 ;;
esac
