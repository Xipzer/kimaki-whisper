# Operating Wendy without an agent

Everything a human needs to keep Wendy running, move her between machines, and
diagnose her when she misbehaves. Commands are copy-paste; expected output is
shown where it matters.

## 1. What runs where

```
 printer (WSL2, RTX 4070S 12 GB)                 projector (Windows, RTX 5090 32 GB)
 ┌──────────────────────────────────────┐        ┌──────────────────────────────────┐
 │ wendy       node dist/cli.js  :7070  │──LAN──►│ llama.cpp  local-fast     :8080  │
 │   role=primary  (Wendy herself)      │        │   Qwen3.8-27B Q6 + DFlash drafter│
 │ kyutai      server.py         :8010  │        │   -np 2 --cache-reuse 256        │
 │   STT 1B + TTS 1.6B  (~6 GB VRAM)    │        │   C:\llama-cpp\profile-A-dflash  │
 │ speaches    faster-whisper    :8000  │        └──────────────────────────────────┘
 │   Kimaki voice-note transcription    │
 │ kimaki      OPENAI_BASE_URL→:7070    │        mac (M4 Max)   standby node: :7070 + :8080 + :8010
 └──────────────────────────────────────┘                        role=standby (own domain only)
```

| Service | Port | Started by | Log |
|---|---|---|---|
| Wendy | 7070 | `restart-wendy.sh` (supervisor) / `wendy-node.sh reload` | `~/.kimaki-whisper/wendy.log` |
| Kyutai STT+TTS | 8010 | `systemctl --user start wendy-kyutai` | `~/.kimaki-whisper/kyutai.log` |
| speaches | 8000 | `~/speaches-server/run-speaches.sh` | `~/.kimaki-whisper/speaches.log` |
| Brain | 8080 (projector) | Windows task `LlamaWakeWatcher` ← `touch /mnt/c/llama-cpp/wake-A.flag` | `C:\llama-cpp\logs\A-dflash.log` |

`~/bin/kimaki-prereqs` checks all of the above in order and starts what is
missing. **Run it before launching Kimaki, always.**

## 2. Daily driving

```bash
# is everything up?
curl -s localhost:8010/health; curl -s localhost:8000/health; curl -s 127.0.0.1:7070/health
curl -s http://192.168.1.140:8080/health            # brain
cd ~/WebstormProjects/kimaki-whisper && ./wendy-node.sh status

# start / restart Wendy (graceful: drains an in-flight reply first)
./wendy-node.sh reload

# watch her think
tail -f ~/.kimaki-whisper/wendy.log
tail -f ~/.kimaki-whisper/diagnostics/$(date -u +%F).jsonl | jq -c 'select(.ev|IN("utterance","first_audio","brain","barge_in","dropped","reply_spoken"))'
```

In Discord: `/wendy` opens her panel (wake/sleep/DND/silence/name-only/brain
start-stop/restart). `!wendy-commands` in any channel re-registers the slash
commands if Kimaki wiped them.

## 3. The voice pipeline (V2) and its numbers

```
 you stop talking
 │ ~1.0 s  semantic end-of-turn (Kyutai VAD) + 0.5 s STT delay
 │ ~1.0 s  brain first sentence (cached prefix; 3–4 s on a cold cache)
 │ ~0.9 s  TTS first audio (python server; the Rust server does ~0.25 s)
 ▼ first word  ≈ 2.9–3.4 s warm   (V1 was 11–13 s)
```

Measured with `scripts/bench-voice.mjs` — run it whenever you touch any organ:

```bash
cd ~/WebstormProjects/kimaki-whisper && npm run build
WENDY_BRAIN_URL=http://192.168.1.140:8080 node scripts/bench-voice.mjs /tmp/opencode/tts-bench.wav
#  TIMELINE  end-of-turn detect 986ms | brain first text +986ms | first AUDIO +1906ms ...
```

Rules the loop enforces (deterministic, not prompt rules):
- **End of turn** = VAD pause score > 0.6, committed 650 ms later (re-armed by
  any trailing word); fallback 1.4 s without new words.
- **Barge-in** = you say ≥ 2 real words while she is speaking → her TTS stream
  and playback are cancelled within one frame; what she never said is handed to
  the next turn as context.
- **Fragments** (< 3 words) never supersede a reply in flight; they merge into
  the pending input. Backchannels ("yeah", "ok") are ignored unless she asked.
- **Name-only** and **silence** modes apply before the brain sees anything.

## 4. Changing her voice

Kyutai TTS uses preset voice embeddings from `kyutai/tts-voices` (no cloning).
Default: `expresso/ex04-ex02_happy_001_channel1_118s.wav` (female). Expresso
speakers ex01/ex04 are female, ex02/ex03 male.

```bash
# audition candidates (writes /tmp/opencode/voice-*.wav)
~/kyutai-server/.venv/bin/python deploy/kyutai/bench.py voices expresso/ex04-ex02_calm_002_channel1_480s.wav vctk/p225_023.wav
# set permanently: config.json  "ttsVoice": "expresso/ex04-ex02_happy_001_channel1_118s.wav"   (any path in the voices repo)
# or server default: Environment=TTS_VOICE=... in the systemd unit
```

Her original Kokoro `af_heart` voice cannot be loaded into Kyutai. Getting it
back = Qwen3-TTS-Base voice clone from a Kokoro sample (planned, `TtsEngine`
swap-in).

## 4b. Autonomy: promises, away duty, activity mirror

- **Promises are tracked.** When she says "I'll tell you when X lands", an aux
  brain call records it in `workspace/commitments.json` (what, thread, due).
  It fires a `COMMITMENT DUE` turn when that thread moves (watcher/change feed)
  or its time comes; "still not finished" keeps it open; 10 attempts -> "gave up"
  in the away report. She can list/drop them with the `commitments` tool.
- **Away duty.** With you out of voice she keeps firing due promises and
  collects agents she spawned. Replies go to `workspace/away-log.json`.
- **Away report.** On your next join the greeting carries the away log: a short
  rundown of what she did, what's open, what needs you.
- **Autonomy rules.** `workspace/autonomy.json` `askFirst` (default empty = full
  authority). Change by voice via the `autonomy_rules` tool.
- **Activity mirror.** Locked thread "Wendy activity (read-only)" in her channel
  (`workspace/activity.json`): one live-edited message per turn - heard, reasoning,
  tool calls + results, reply. She never reads it.

## 5. Config files

| File | Travels between nodes? | Holds |
|---|---|---|
| `~/.kimaki-whisper/config.json` | **yes** (with her memory) | `wendyToken`/`botToken` (home bot), `ownerId`, `brainUrl`, `kyutaiUrl`, `speachesUrl`/`backendUrl`, `port`, `ttsVoice`, `telegramBotToken`, `telegramVips`, `wendyChannelId`, `spawnModels`, `foreignBotToken` |
| `~/.kimaki-whisper/node.json` | **no** (per machine) | `name`, `role` (`primary`/`standby`), `label`, `peers`, and per-node overrides of `brainUrl`/`speachesUrl`/`kyutaiUrl`/`port`, `brainStartCommand`/`brainStopCommand`/`brainWakeCommand`, optional `nodeToken`, `startCommand` |
| `~/.kimaki-whisper/workspace/` | yes | memory.md, journal, history, ledgers, pins, schedules |
| `~/.kimaki-whisper/telegram/` | yes | profiles, poll offset |
| `~/.kimaki-whisper/diagnostics/` | no | per-day event stream (14 days) |

Tokens: `wendyToken` is the home bot (Portable PC) and is opened **only** on
the primary. `nodeToken` is this device's own Kimaki bot, read from
`~/.kimaki/discord-sessions.db` automatically; it is always opened and serves
`/whisper-*` + "retranscribe" for the local Kimaki. On the printer both are the
same bot, so one gateway.

## 6. Moving Wendy between machines

One bot token = one live Wendy. Roles are flipped on the machine that owns the
process; nothing is ever killed remotely.

```bash
./wendy-node.sh status                    # roles and liveness everywhere
./wendy-node.sh promote printer           # on the NEW primary: sync memory from printer, demote it, become primary
./wendy-node.sh demote mac                # on the OLD primary: become standby, push memory to mac (then promote there)
./wendy-node.sh handover printer mac      # from any machine that can ssh both
./wendy-node.sh role standby              # emergency: drop the Wendy gateway here, keep own-domain
```

Prerequisites: ssh aliases `printer`, `projector`, `mac` in `~/.ssh/config` on
every node, tailnet reachable (printer needs `sudo tailscale set
--shields-up=false --operator=xipz` once — otherwise nothing can reach it
inbound), and the same repo commit on both ends (`git pull` before promote).

## 7. The brain

```bash
# from the printer
touch /mnt/c/llama-cpp/wake-A.flag                       # via: ssh projector 'touch /mnt/c/llama-cpp/wake-A.flag'
ssh projector '~/bin/llm-remote stop'                     # stop
curl -s http://192.168.1.140:8080/slots | jq '.[].id'     # expect [0,1]
```

Profile: `C:\llama-cpp\profile-A-dflash.bat` — `-c 98304 -np 2 --cache-reuse 256`
(49k per slot). **Do not raise `-c`**: at 163840 the server used 30.9 GB, and
with the desktop's own VRAM (dwm ~2 GB, Chrome, Discord) Windows paged part of
it to system RAM — prefill fell from ~1,300 to ~100 tok/s and decode from ~90 to
~20 (measured 2026-09-22). `brain_degraded` in the diagnostics flags it. Do not
drop `-np 2 --cache-reuse 256` either: slot 0 is the conversation, slot 1 is background work; without two slots
every Telegram summary evicts her conversation cache and turns go back to 10 s.
Verify the cache is working from a diag line: `"prompt_tokens_details":
{"cached_tokens": N}` with N close to `prompt_tokens`.

If the projector reboots, WSL's ssh portproxy on :2222 breaks — run
`C:\llama-cpp\wsl-ssh-heal.ps1` (scheduled task `WslSshHeal`).

### Reaching the brain from anywhere (travel)

The brain is exposed on the tailnet by `brain-forward` (systemd user unit in
the projector's WSL, `~/bin/brain-forward.py`): `100.88.30.110:8080` →
Windows llama-server. `brainUrl` is `http://100.88.30.110:8080` and the ssh
alias `projector` points at the tailnet (`projector-lan` = the old LAN
portproxy), so wake/stop and inference work identically at home and abroad.
WSL is kept alive at Windows logon by `Startup\wsl-keepalive.vbs`.
If the projector reboots, someone must log in to Windows once (the brain,
the wake watcher and WSL all start at logon).

### Travelling where VoIP is blocked (UAE, etc.)

Discord voice is UDP and some networks (UAE carriers: du, Etisalat) block it: the
bot's voice connection sits in `connecting` and `voice_connect_failed` appears in
the diagnostics, so she flickers in and out of the channel. Fix: the printer's
Windows Mullvad (`mullvad.exe connect`, relay `de fra`, DAITA off, auto-connect
on). WSL traffic, Tailscale to the brain, and Discord voice all ride the tunnel.

## 8. When something is wrong

| Symptom | Check | Fix |
|---|---|---|
| She joins the VC but never answers | `wendy.log`: `voice loop failed to start` / `stt ws error` | `systemctl --user restart wendy-kyutai`; wait for `kyutai server on :8010` in `kyutai.log` (~90 s) |
| "My reasoning engine was asleep" | `curl 192.168.1.140:8080/health` | wake flag (§7); if the projector is off, she cannot think — she says so |
| Slow first word (> 6 s) every turn | diag `brain` line `cached_tokens` far below `prompt_tokens`; or `brain_degraded` (tps < 45) | cache miss: a different client on slot 0, or history rewritten mid-way. Degraded: VRAM overcommitted on the projector — close GPU-heavy apps there, restart the brain |
| Two Wendys answering | `./wendy-node.sh status` shows two `primary` | `./wendy-node.sh role standby` on the wrong one |
| Kimaki voice notes fail (`ECONNREFUSED 7070` / `Incorrect API key`) | Kimaki was started without the prereq gate or without `OPENAI_BASE_URL` | restart Kimaki through `~/bin/kimaki-prereqs && env OPENAI_API_KEY=local OPENAI_BASE_URL=http://127.0.0.1:7070/v1 npx -y kimaki@latest` |
| speaches 500s on every request | `speaches.log`: `Conv NOT_IMPLEMENTED` | GPU node: `onnxruntime-gpu` with matching CUDA; CPU node: plain `onnxruntime` |
| Kyutai OOM on start | `nvidia-smi` | 4070S must have ≥ 7 GB free; stop other GPU users (speaches idles at ~3 GB) |
| Slash commands vanished | Kimaki bulk-PUT wiped them | type `!wendy-commands`; she also self-heals every 10 min |
| She cut herself off mid-sentence | diag `barge_in` with `heard:` | you (or your mic) said ≥ 2 words; raise the bar in `src/voice/loop.ts maybeBargeIn` if it is noise |

Never `pkill -f node` — Kimaki is node too. Use `wendy-node.sh reload` or
`kill -TERM $(cat ~/.kimaki-whisper/wendy.pid)`; the supervisor respawns her.

## 9. Fresh machine, from zero

```bash
git clone git@github.com:Xipzer/Wendy.git ~/WebstormProjects/kimaki-whisper && cd $_
npm ci && npm run build
deploy/kyutai/setup.sh                                  # CUDA venv; Mac: use the MLX path in docs/MAC-HANDOFF.md
cp deploy/kyutai/wendy-kyutai.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now wendy-kyutai
cp deploy/printer/kimaki-prereqs ~/bin/ && chmod +x ~/bin/kimaki-prereqs
# config: copy config.json + workspace/ from the primary (wendy-node.sh sync printer), write node.json with role=standby
./wendy-node.sh role standby                            # starts her as a standby (own-domain gateway + :7070)
```
