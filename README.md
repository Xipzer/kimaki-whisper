# Wendy

> **Shareable overview:** [ARCHITECTURE.md](./ARCHITECTURE.md) - capability map and flow diagram, safe to pass around.

Local, $0, voice-first personal assistant living in Discord voice channels - assistant first,
reliable operator second. She follows the owner into any VC, converses fluidly, and drives a
47-project / 1,200-thread Kimaki agent organisation by voice.

```
you (Discord VC) ── opus ──► 24 kHz pcm ──► Kyutai STT 1B (streaming words + semantic end-of-turn, 4070S)
                                                    │ text
                                             think() loop ── llama.cpp brain (streaming, tools)
                                                    │        Qwen3.8-27B + DFlash, 5090, 2 KV slots
                              ~20 tools ────────────┤
                              (kimaki CLI, notes,   │ sentences as generated
                               schedules, telegram) ▼
                    your threads <──► Kyutai TTS 1.6B (text-streaming, lookahead prosody) ──► VC
```

First word ≈ 3 s after you stop talking (warm). Barge-in cancels her mid-word.
**Operate her without an agent:** [docs/OPERATIONS.md](./docs/OPERATIONS.md).
Design rationale: [docs/ARCHITECTURE-V2.md](./docs/ARCHITECTURE-V2.md).

## Stack

| Piece | What | Where |
|---|---|---|
| Wendy process | this repo - Discord gateways, voice loop, `/whisper-*`, `:7070` transcription for Kimaki | `src/` |
| Wendy core | prompt, tools, turn loop, watchers, feeds, schedules, diagnostics | `src/wendy.ts` |
| Voice loop | STT/TTS websocket clients, Discord audio bridges, turn FSM | `src/voice/` |
| Ears + mouth | Kyutai STT `stt-1b-en_fr` + TTS `tts-1.6b-en_fr`, one PyTorch server | `deploy/kyutai/` → `ws://127.0.0.1:8010` |
| Brain | llama.cpp `local-fast`, profile A (DFlash), `-np 2 --cache-reuse 256` | `http://192.168.1.140:8080` (wake: `touch /mnt/c/llama-cpp/wake-A.flag` on the projector) |
| Kimaki voice notes | speaches / faster-whisper large-v3 behind `:7070` | `http://localhost:8000` |
| Nodes | one process per machine, `node.json` role decides if Wendy is live there | `wendy-node.sh` |
| Agent org | published Kimaki CLI - projects/threads she reads, asks, dispatches | `kimaki` on PATH |

## Architecture highlights

- **Two modes, one voice** - conversation (zero tools, instant) vs action (reliability doctrine:
  read-vs-ask, id discipline character-for-character, identity echo on every read/send,
  freshness overrides memory, never end a turn on a promise). Same conversational delivery in both.
- **Serial voice, parallel work** - dispatches return in seconds; results arrive as
  `[BACKGROUND UPDATE]` events delivered only at conversation pauses (>10s idle, nobody
  talking) via synthetic turns through her own brain, into shared history.
- **Turn-taking** - semantic end-of-turn from the STT's VAD (no silence timers); barge-in on two
  real words cancels her TTS stream and playback; fragments never supersede a reply; backchannels
  ("yeah/ok") absorbed unless answering her question.
- **Watchers** - dispatched threads auto-watched: content-fingerprint deltas (baselined at
  registration), start + finish announcements, dedup memory shared with the change feed so
  nothing is announced twice in different words.
- **Global awareness** - 10-min index walk of every project/thread (updated-diff change feed),
  git HEAD probe per repo, all delivered by notification tier (interrupt/digest/onjoin, per-route).
- **Silence mode** - owner-only (`go_silent`), hard mute on both mouth and brain; a bare
  "Wendy" wakes her (mishear-tolerant name regex, checked before every other gate).
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
~/bin/kimaki-prereqs           # start what is missing (speaches, kyutai, wendy), health-gated
./wendy-node.sh status|reload|role|promote|demote|handover
~/.kimaki-whisper/wendy.log    # runtime log (5MB rotate)
~/.kimaki-whisper/kyutai.log   # ears + mouth server
~/.kimaki-whisper/diagnostics/YYYY-MM-DD.jsonl   # full event stream, 14-day retention:
                               # utterance / first_audio / brain (per hop, cached_tokens) / barge_in
                               # dropped / speak / reply_spoken / announce / watch_delta / schedule_fire
~/.kimaki-whisper/config.json  # travels with her: tokens, brainUrl, kyutaiUrl, ttsVoice, ownerId...
~/.kimaki-whisper/node.json    # stays on the machine: name, role, per-node endpoints
~/.kimaki-whisper/workspace/   # her memory: memory.md, journal.jsonl, history.json, ledgers, schedules
```

Bench the whole voice path offline: `node scripts/bench-voice.mjs owner.wav` (prints a timeline).
Tests: `npm test`. Build: `npm run build`. Full runbook: [docs/OPERATIONS.md](./docs/OPERATIONS.md).

## Origin

Built session-by-session over Discord via Kimaki, debugged live in-channel with the owner -
including her own feature requests (thread index, passive notifications, scheduled checks,
read-vs-ask doctrine) filed by her, through the very switchboard she runs.

## Whisper sidecar heritage

Wendy grew out of (and still contains) the kimaki-whisper sidecar - these remain part of her stack:

- `/whisper-*` Discord slash commands (registered additively on the same bot token; Kimaki ignores unknown commands)
- OpenAI-compatible transcription endpoint on `127.0.0.1:7070` (Kimaki routes voice notes here via `OPENAI_BASE_URL`)
- Reply "retranscribe" to any voice note to re-transcribe it (primary: injected via `kimaki send`; standby nodes: posted as text)
- Every node runs these for its own Kimaki, whether or not Wendy herself is live there

Audio never leaves the machine. No API keys, no cloud.
