# Wendy

> **Shareable overview:** [ARCHITECTURE.md](./ARCHITECTURE.md) - capability map and flow diagram, safe to pass around.

Local, $0, voice-first personal assistant living in Discord voice channels - assistant first,
reliable operator second. She follows the owner into any VC, converses fluidly, and drives a
47-project / 1,200-thread Kimaki agent organisation by voice.

```
you (Discord VC) ── opus ──> prism decode ──> speaches STT (faster-whisper large-v3, 4070S)
                                                    │ text
                                             think() loop ── llama.cpp brain
                                                    │        (Qwen3.8-27B+MTP, 5090, 196K ctx)
                              15 tools ─────────────┤
                              (kimaki CLI, bash,    │ reply
                               notes, schedules)    ▼
                    your threads <──> Kokoro TTS (af_heart) ──> VC playback
```

## Stack

| Piece | What | Where |
|---|---|---|
| Sidecar | this repo - Discord gateway, VC capture/playback, `/whisper-*`, :7071 | `src/` |
| Wendy core | prompt, tools, turn loop, watchers, feeds, schedules, diagnostics | `src/wendy.ts` |
| STT | speaches, faster-whisper large-v3 | `http://localhost:8000` |
| Brain | llama.cpp `local-fast` (Profile A) | `http://the GPU host` (wake: `~/bin/llm-remote start A` via `ssh projector`) |
| TTS | Kokoro-82M ONNX, voice `af_heart` (hot-swappable via config) | speaches |
| Agent org | published Kimaki CLI - projects/threads she reads, asks, dispatches | `kimaki` on PATH |

## Architecture highlights

- **Two modes, one voice** - conversation (zero tools, instant) vs action (reliability doctrine:
  read-vs-ask, id discipline character-for-character, identity echo on every read/send,
  freshness overrides memory, never end a turn on a promise). Same conversational delivery in both.
- **Serial voice, parallel work** - dispatches return in seconds; results arrive as
  `[BACKGROUND UPDATE]` events delivered only at conversation pauses (>10s idle, nobody
  talking) via synthetic turns through her own brain, into shared history.
- **Barge-in** - 0.7s of sustained speech cuts her playback; queued speech discarded by epoch;
  superseded replies stay silent; backchannels ("yeah/ok") absorbed unless answering her question.
- **Watchers** - dispatched threads auto-watched: content-fingerprint deltas (baselined at
  registration), start + finish announcements, dedup memory shared with the change feed so
  nothing is announced twice in different words.
- **Global awareness** - 10-min index walk of every project/thread (updated-diff change feed),
  git HEAD probe per repo, all delivered by notification tier (interrupt/digest/onjoin, per-route).
- **Silence mode** - owner-only (`go_silent`), hard mute on both mouth and brain; a bare
  "Wendy" wakes her (0.25s capture gate + mishear-tolerant name regex while muted).
- **Scheduled checks** - persistent timers (`schedule_check`): re-read a thread at T+N minutes
  or plain reminders; she self-schedules safety nets after long dispatches.
- **Episodic memory** - evicted conversation auto-compresses into a journal; a consolidation
  pass rewrites standing memory; retrieval is relevance-gated (see workspace/journal.jsonl,
  memory.md, consolidation.json).
- **Self-tasks** - her own background workbench: long work advanced in slices between
  conversation, foreground preemption via slice abort (workspace/selftasks.json).
- **Agent orchestration** - spawn_agent creates opencode agents in the dedicated #wendy
  Discord channel (owner-readable/replyable); persistent spawn ledger (workspace/spawns.json),
  concurrency cap, whitelist-only model selection (local/opus/fable) with on-the-fly
  switch_thread_model for load balancing.
- **Update intelligence** - HIGH/MED/LOW priorities, consent-based delivery, DND with a
  high-priority pressure valve, staleness re-verification before speaking aged updates.
- **Reads that actually work** - kimaki CLI truncates piped stdout (~64KB), so all CLI output
  routes through temp-file sinks with seek-tail reads (293MB sessions fine); transcripts parsed
  into messages, tool noise + inline-screenshot base64 stripped, last 3-4 messages aggregated.

## Runtime & ops

```bash
./restart-jarvis.sh            # historical name; current: restart-wendy.sh
./restart-wendy.sh             # atomic supervised restart (exit 2 = duplicate stands down)
~/.kimaki-whisper/wendy.log    # runtime log (5MB rotate)
~/.kimaki-whisper/diagnostics/YYYY-MM-DD.jsonl   # full event stream, 14-day retention:
                               # owner_said / speak / tool (args+result+ms) / brain (per hop)
                               # dropped / barge_in / announce / watch_delta / schedule_fire …
~/.kimaki-whisper/config.json  # botToken, brainUrl, brainWakeCommand, speachesUrl, ttsVoice, ownerId
~/.kimaki-whisper/routes.json  # curated alias → thread routes (+ notify tier)
~/.kimaki-whisper/workspace/   # her memory: notes/, memory.md, history.json (24 msgs),
                               # thread-index.json, nicknames.json, schedules.json, git-heads.json
```

Testing: `test/sim-messy.mjs` - live-fire chaos sim against the real brain/tools
(`WENDY_TEST=1` isolates her real history). Build: `./node_modules/.bin/tsc`.

## Origin

Built session-by-session over Discord via Kimaki, debugged live in-channel with the owner -
including her own feature requests (thread index, passive notifications, scheduled checks,
read-vs-ask doctrine) filed by her, through the very switchboard she runs.

## Whisper sidecar heritage

Wendy grew out of (and still contains) the kimaki-whisper sidecar - these remain part of her stack:

- `/whisper-*` Discord slash commands (registered additively on the same bot token; Kimaki ignores unknown commands)
- OpenAI-compatible transcription endpoint on `127.0.0.1:7071` (Kimaki routes voice notes here via `OPENAI_BASE_URL`)
- Reply "retranscribe" to any voice note to re-transcribe and inject via `kimaki send`

Audio never leaves the machine. No API keys, no cloud.
