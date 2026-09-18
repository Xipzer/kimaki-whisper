#!/usr/bin/env bash
# wendy-sync - the ACTIVE node pushes Wendy's memory to every peer, continuously.
# Pull-free by design: a standby never needs to reach the primary to be current,
# so promotion works even when the primary is already dead.
# Runs from cron/systemd every 2 minutes on whichever node is active.
set -uo pipefail
STATE="$HOME/.kimaki-whisper"
PEERS=$(python3 -c "import json;print(' '.join(json.load(open('$STATE/node.json')).get('peers',[])))" 2>/dev/null)
ACTIVE=$(pgrep -f "kimaki-whisper/dist/cli.js" >/dev/null 2>&1 && ! pgrep -f "dist/cli.js serve" >/dev/null 2>&1 && echo yes || echo no)
[ "$ACTIVE" = yes ] || exit 0            # only the running Wendy is the source of truth
[ -n "$PEERS" ] || exit 0
cd "$STATE" && tar czf /tmp/wendy-state.tgz workspace telegram config.json 2>/dev/null || exit 1
for p in $PEERS; do
  if scp -q -o ConnectTimeout=6 -o BatchMode=yes /tmp/wendy-state.tgz "$p:/tmp/wendy-state-incoming.tgz" 2>/dev/null \
     && ssh -o ConnectTimeout=6 -o BatchMode=yes "$p" 'mkdir -p ~/.kimaki-whisper/incoming && tar xzf /tmp/wendy-state-incoming.tgz -C ~/.kimaki-whisper/incoming && date +%s > ~/.kimaki-whisper/incoming/.synced' 2>/dev/null; then
    echo "$(date +%H:%M) synced -> $p"
  else
    echo "$(date +%H:%M) $p unreachable"
  fi
done >> "$STATE/sync.log" 2>&1
tail -n 200 "$STATE/sync.log" > "$STATE/sync.log.tmp" && mv "$STATE/sync.log.tmp" "$STATE/sync.log"
