# Wendy on the projector - builder handoff

> **Status (2026-09-22):** partly historical. The voice pipeline is now V2
> (Kyutai streaming STT/TTS, see `docs/ARCHITECTURE-V2.md`); the node model is
> one role-driven process per machine (`wendy-node.sh role|promote|demote`);
> there is no `serve` mode, no sync cron, and no `README.md` (read `README.md`
> and `docs/OPERATIONS.md`). Machine facts below were measured when written and
> may have drifted — verify before acting.


You are the Wendy builder for THIS machine (the projector, RTX 5090). The primary
builder lives on the printer (4070S box) in the Local-LLM channel of the
"Portable PC Playground" Discord and cannot help when that box is down. That is
when you matter. Read this fully before touching anything.

## What Wendy is

A voice assistant for the owner (Xipz, Discord id 1373950239303532656). She
follows him into voice channels, transcribes him (Whisper), thinks (a local
Qwen3.8-27B via llama.cpp), speaks (Kokoro TTS), manages his Kimaki agent
threads, and reads/answers his Telegram. She is an agency utility: he uses her
to dispatch, monitor and relay work across threads while away from a keyboard
or in parallel with it.

Repo: `~/WebstormProjects/kimaki-whisper` (git remote `wendy` =
github.com/Xipzer/Wendy). State: `~/.kimaki-whisper/`. Architecture doc:
`README.md`. Read `src/wendy.ts`, `src/node/identity.ts`, `wendy-node.sh`,
`wendy-sync.sh` before changing behaviour.

## The multi-node design (why this machine has a copy)

ONE bot token = ONE live Wendy. Discord allows one gateway per token and
Telegram rejects a second poller. So this is active/standby, never two at once.

```
printer   (4070S)  PRIMARY  - his workspace; runs Wendy normally; Whisper on its GPU
projector (5090)   STANDBY  - THIS MACHINE; brain host; can run everything alone
mac       (M4 Max) STANDBY  - last man standing; not finished yet (no sshd, brain unstarted)
```

Her memory (`workspace/`, `telegram/`, `config.json`, ~5 MB) is pushed from the
active node to every peer every 2 minutes by `wendy-sync.sh` (cron on the
active node) into `~/.kimaki-whisper/incoming/`. Her EYES do not travel: every
thread/project she can see comes from the LOCAL Kimaki. On this machine she can
only see and act on threads registered with the projector's Kimaki. `node.json`
tells her which machine she is on and that rule is injected into every prompt
(`nodeBlock()` in `src/node/identity.ts`).

## This machine's node identity  (`~/.kimaki-whisper/node.json`)

```
name=projector  role=standby
brainUrl     = http://192.168.1.140:8080   (llama.cpp on the 5090 - a WINDOWS process;
                                            from WSL it is NOT 127.0.0.1, use the LAN ip)
speachesUrl  = http://localhost:8000       (speaches CPU: Whisper large-v3 int8 + Kokoro,
                                            systemd --user unit `speaches-cpu`, ~6s/clip)
port         = 7070                        (transcription endpoint Kimaki calls)
wake/start   = touch /mnt/c/llama-cpp/wake-A.flag  (Windows task LlamaWakeWatcher starts profile A)
stop         = rm -f /mnt/c/llama-cpp/wake-*.flag; ~/bin/llm-remote stop
```

The brain: `C:\llama-cpp` on Windows, profiles A-F in `llm.bat`, model
`C:\models\Qwen3.8-27B-Uncensored-Q6_K.gguf` (+ DFlash2 drafter). `llm-remote
start|stop|status` from WSL. If WSL interop dies (cmd.exe "Exec format error"),
drop the flag file instead - the Windows watcher picks it up within 60s.

## The one command that matters

When the printer is down and the owner wants Wendy here:

```
cd ~/WebstormProjects/kimaki-whisper && ./wendy-node.sh promote
```

It uses the pushed memory snapshot in `incoming/` (needs no live printer),
applies node.json endpoints, starts her under `restart-wendy.sh` (supervised,
logs to `~/.kimaki-whisper/wendy.log`). Verify with `./wendy-node.sh status`
and `grep armed ~/.kimaki-whisper/wendy.log`.

When the printer is back: from the PRINTER run
`./wendy-node.sh handover projector printer` (hub-driven; the two WSL boxes
cannot ssh each other directly - see below).

## Known limits and traps (all verified, not guesses)

- WSL<->WSL ssh across Windows NAT does not work; the tailnet path between the
  two WSL nodes did not establish either. Handover is driven from a node that
  can reach both (the printer reaches this box via 192.168.1.140:2222).
- The Windows portproxy for :2222 breaks after a reboot (WSL gets a new ip).
  `C:\llama-cpp\wsl-ssh-heal.ps1` re-points it; a scheduled task runs it at
  logon and every 5 min. If ssh from the printer resets with no banner, that is
  the cause.
- `pgrep -f` matches its own shell. Use bracket patterns: `dist/cli.j[s]`.
- Two launchers racing (a second `restart-wendy.sh` before the first finished)
  SIGTERM each other. Wait for `armed` in the log before relaunching.
- Wendy can only see this machine's Kimaki projects. Threads the owner
  remembers from the printer are NOT reachable here; she is told so.
- Model pins (`thread_model_pin`) once downgraded threads due to a stale alias;
  the tool now refuses to change a model without `confirm_change`. Pins are
  currently EMPTY by owner instruction - do not re-add.

## Deterministic guards you must not remove

Nearly every behaviour fix in her history is CODE, not prompt text, because
the model obeyed doctrine ~60% of the time. In `src/brain/guards.ts` and the
tool gate in `src/wendy.ts`: send-claim vs dispatch ledger, duplicate-send
block, verified-target block (session ids share prefixes), action hold while
the owner is mid-speech, self-directive hold, freshness refresh of queued items,
name-only mode, join-priority. Tests: `npm test` (18). Keep them green.

## Diagnostics

`~/.kimaki-whisper/diagnostics/YYYY-MM-DD.jsonl` - every event (owner_said,
brain with reasoning, tool, speak, dropped, capture_*, announce ...). This is
how every incident has been diagnosed. Start there, not with guesses.

## Your job when activated

1. Confirm the stack: brain (`curl 192.168.1.140:8080/v1/models`), speaches
   (`curl localhost:8000/health`), Wendy armed. Fix in that order.
2. Keep the owner's experience identical to the primary: voice follow, greeting,
   updates, Telegram, thread dispatch - all the same code, same memory.
3. When the primary returns, do not fight it. One Wendy. Hand back.
