# Handoff — MacBook Pro M4 Max local LLM setup

> **For a fresh agent.** You are setting up local LLM inference on a MacBook Pro
> M4 Max, 36 GB unified memory. This document carries everything learned on the
> owner's RTX 5090 box so you don't repeat six weeks of mistakes.
>
> **Status of this document:** written 2026-09-19; §7 corrected and §9 (Wendy + Whisper) added the same day from measured facts. Everything marked ✅ was
> measured on real hardware. Everything marked ⚠️ is inferred and **must be
> verified before you state it as fact.** Do not let the ⚠️ items drift into the
> ✅ column by repetition — that is exactly how the previous stack accumulated
> wrong numbers.

---

## 0. Read this first: how the owner works

- **Local is a secondary / backup tool.** Frontier models (Claude Opus, GPT) stay
  primary. Do not architect as if local must win.
- The niche where local earns its keep is **security audit and adversarial review**
  — work hosted models refuse. That is why an *abliterated* (decensored) model is
  used rather than a stock one.
- **The server being off is correct**, not a fault. It is started on demand.
- The owner dislikes **storage creep**. Do not create backups of anything that is
  re-downloadable from a permanent release URL. A 680 MB backup of a public
  GitHub release was deleted from the other box for exactly this reason.
- **Do not end every message with a question.** Investigate, decide, act, report.
  Ask only when genuinely ambiguous or destructive.
- Prefer **continuing an existing thread** over spawning new ones.

---

## 1. Hardware reality — bandwidth is the whole story

| | |
|---|---|
| Machine | MacBook Pro, Apple M4 Max |
| Unified memory | **36 GB** |
| Memory bandwidth | **410 GB/s** ⚠️ verify |

> ⚠️ **Verify the bandwidth first.** M4 Max ships in two dies: a 14-core at
> **410 GB/s** (36 / 96 GB configs) and a 16-core at **546 GB/s** (48 / 64 / 128 GB).
> A 36 GB machine is the 410 GB/s part. Confirm with:
> ```sh
> system_profiler SPHardwareDataType | grep -E "Chip|Memory"
> sysctl -n machdep.cpu.brand_string hw.memsize
> ```
> Every speed estimate below scales linearly with this number. If it is 546, scale up ~33%.

### The arithmetic that decides everything

Decoding one token requires reading **every active weight once**. So:

```
  ceiling tok/s  ≈  memory bandwidth ÷ model size in memory
```

At 410 GB/s, for Qwen3.8-27B (dense, so all weights read every token):

| Quant | Size | Theoretical ceiling | Realistic (70–85%) |
|---|---|---|---|
| Q4_K_M | ~17.1 GB | ~24 tok/s | **~17–20 tok/s** |
| Q5_K_M | ~19.8 GB | ~21 tok/s | ~14–18 tok/s |
| Q6_K | ~22.9 GB | ~18 tok/s | ~13–15 tok/s |

**This is the most important difference from the 5090 box.** On the 5090
(1,792 GB/s, and ~2,176 GB/s once overclocked) capacity was the binding
constraint, so a *larger* quant was free. Here **bandwidth binds**, so a larger
quant costs you speed directly and buys nothing.

➡️ **Start at Q4 / MLX 4-bit on this machine.** Do not copy the 5090's Q5_K_M
recommendation across — it was correct there for a reason that does not apply here.

### Memory budget

36 GB total, macOS and apps need roughly 6–8 GB. Assume **~28 GB usable**.

KV cache for this model family runs roughly **0.07 GB per 1k tokens at FP16**,
halved at Q8. So 128K context ≈ 4.5 GB at Q8 KV.

```
  Q4 weights ~16 GiB  +  128K Q8 KV ~4.5 GiB  =  ~20.5 GiB     comfortable
  Q5 weights ~18.5    +  128K Q8 KV ~4.5      =  ~23 GiB       tight
  Q6 weights ~21.3    +  128K Q8 KV ~4.5      =  ~26 GiB       do not
```

### Thermals

⚠️ Reported: the 16-inch chassis throttles after ~20 minutes of sustained full-GPU
load, losing 8–12% throughput; the 14-inch throttles harder and sooner. Irrelevant
for bursty interactive use, relevant for long benchmark runs — **warm up and take
medians**, do not trust a single long run.

---

## 2. Runtime: use MLX, not llama.cpp

This is well established and not worth re-litigating:

| Claim | Evidence |
|---|---|
| MLX is **15–30% faster** than llama.cpp Metal at the same quant | multiple independent benchmarks |
| MLX uses **~10% less memory** (native unified-memory handling) | same |
| Advantage is **largest on prompt processing**, which dominates agentic loops | consistent across sources |
| The gap **narrows at 27B+** where both saturate bandwidth | ⚠️ expect a smaller win than the headline |

**Options, in order of recommendation:**

1. **LM Studio** — ships an MLX engine by default, GUI model management,
   one-click OpenAI-compatible server, draft-model speculative decoding built in.
   Easiest correct setup.
2. **Ollama 0.19+** — has an MLX backend that **auto-activates at 32 GB+ unified
   memory** (this machine qualifies). Best if scripting or running headless.
   Reported +93% decode / +57% prefill over its own llama.cpp path.
3. **`mlx-lm` directly** — lowest overhead, 5–8% faster than the above on
   identical quants, but no server until you wrap it.
4. **`vllm-mlx`** — newer; reports 21–87% over llama.cpp plus continuous batching
   and **content-based prefix caching that cut repeated-image latency 21.7s → 0.78s**.
   Worth evaluating if vision/screenshot work matters. ⚠️ unverified here.

> **Filter by "MLX" not "GGUF"** when downloading in LM Studio. It is easy to
> silently end up on the GGUF path and conclude MLX is no faster.

---

## 3. Model

**Qwen3.8-27B** — released 14 Aug 2026, Apache-2.0, dense 27B, native
vision **and** video, 262,144 native context, MTP built in.

Ranked **#3 among all open-weight models** (BenchLM, Sept 2026), behind only
Qwen3.8-Max and GLM-5.3 — both of which are rack-only. It is the best model that
fits consumer hardware, by a clear margin. 7.4M downloads/30d.

### Which build

The owner's use case needs an **abliterated** (decensored) build:

| Repo | Downloads/30d | Notes |
|---|---|---|
| `huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF` | 2.83M | ships `mmproj` + `-MTP` variants |
| `0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF` | 1.83M | Heretic method, separate `mtp-RVN.gguf` drafter |

⚠️ **Both are GGUF.** For MLX you need an MLX-format build — check
`mlx-community` and the `-mlx-` tagged repos, or convert with `mlx_lm.convert`.
If no abliterated MLX build exists, you have a real choice to make: GGUF via
llama.cpp (losing the MLX speed advantage) or convert one yourself.

> **Abliteration method matters at 27B.** Independent benchmarking on the
> Qwen3.5-27B generation found **huihui retains ~45 genuine refusals** at this
> scale (88.8% attack success) while **Heretic reaches 99.8%** with better
> capability retention (+7.7% GSM8K vs +2.3%). Huihui's single-direction ablation
> works on 4B/9B and degrades at 27B. ⚠️ Measured on 3.5, not 3.8 — treat as
> strong signal, not proof, and **test refusal rate on real prompts** before
> committing.

### Speculative decoding

Qwen3.8 has **MTP heads built in**. On llama.cpp the flag is
`--spec-type draft-mtp` (renamed from `mtp` on 2026-05-13; **the old name fails
silently** and costs the entire speedup). On MLX, speculative decoding uses a
separate draft model — pairing a 27B with a small draft reportedly lifts
~21 → ~34 tok/s. ⚠️ verify on this machine.

---

## 4. Setup

```sh
# 1. confirm the hardware before anything else
system_profiler SPHardwareDataType | grep -E "Chip|Memory"

# 2. LM Studio (recommended) — install, then in Discover:
#    filter MLX, search Qwen3.8-27B, take a 4-bit build
#    enable the local server (OpenAI-compatible) on :1234

# 3. or Ollama with MLX backend (auto at 32GB+)
ollama --version        # need 0.19+
ollama pull qwen3.8:27b
ollama run qwen3.8:27b --ctx-size 32768
```

> ⚠️ **Ollama silently truncates context.** It defaults far below the model's
> 262K and will quietly drop your conversation instead of warning. Always set
> `--ctx-size` explicitly, or `num_ctx` in API calls.

---

## 5. How to measure — methodology that cost real time to learn

These are not style preferences. Each one produced a wrong conclusion on the
other machine before being fixed.

1. **Measure at the context you actually ship.** A sweep at 32K picked a
   parameter that was *6× slower* at the real 200K setting. Benchmark at the
   deployed config or the result is worthless.
2. **Configured context ≠ usable context.** Allocation grows with *actual prompt
   depth*. "It loaded" proves nothing — drive it with a deep prompt.
3. **Corpus content dominates.** Real code vs synthetic filler changed measured
   throughput by **1.8×** (48 vs 27 tok/s) because speculative-decoding
   acceptance depends on how predictable the text is. **Benchmark on realistic
   material**, never lorem-ipsum.
4. **Give the model room to finish.** A capped output budget made one config look
   worse purely because it wrote longer per finding. Truncation artefacts
   masquerade as quality differences.
5. **Watch for memory spill, not just "did it fit".** On unified memory, swapping
   is the equivalent failure — check for pressure, not just allocation success.
6. **Take medians of ≥3 runs after a warm-up**, and re-run winner and loser in
   reverse order to rule out thermal/ordering effects.
7. **Units.** HuggingFace reports **decimal GB**; `ls` and most tools report
   **GiB**. Comparing them produced a fake "+2 GB won't fit" conclusion. `21392 MiB`
   is 20.89 GiB is 22.4 GB.

---

## 6. Wiring it into OpenCode / Kimaki

<!-- This cost hours to find. Do not remove. -->
> ⚠️ **The key is `tool_call`, not `tools`.**
> The OpenCode model schema is `additionalProperties: false` and has **no `tools`
> key**. `"tools": true` is silently ignored — config loads, requests succeed,
> tool calling is simply never enabled. No error, no warning.
> There were **86 occurrences** of this across a public preset repo.
>
> Verify against the **running server**, not the file — OpenCode normalises it
> into `capabilities.toolcall`:
> ```sh
> curl -s http://127.0.0.1:<opencode-port>/config/providers | python3 -c \
> "import json,sys; [print(m['id'], m['capabilities']['toolcall']) \
>  for p in json.load(sys.stdin) if 'llama' in p['id'] for m in p['models'].values()]"
> ```

Provider block shape:

```jsonc
"provider": {
  "local-mlx": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Qwen3.8-27B (M4 Max)",
    "options": { "baseURL": "http://127.0.0.1:1234/v1", "apiKey": "local-no-auth" },
    "models": {
      "qwen3.8-27b": {
        "name": "Qwen3.8-27B abliterated",
        "tool_call": true,
        "reasoning": false,
        "attachment": true,
        "limit": { "context": 131072, "output": 32768 },
        "options": { "temperature": 0.6, "top_p": 0.95, "top_k": 20, "min_p": 0 }
      }
    }
  }
}
```

Notes:
- `apiKey` must be **non-empty** or OpenCode won't list the provider, even though
  the server ignores its value.
- `limit.output` is **required** by the schema alongside `context`.
- The model key must match `/v1/models` exactly or every request 404s. Set a
  stable alias server-side rather than using a filesystem path.
- **Do not** set this as `model` or `small_model` — local stays secondary.
- Config is read **at startup**. Restart the server after editing.

---

## 7. The rest of the estate (context, not tasks)

| Machine | ssh alias | Role today |
|---|---|---|
| **Printer** — WSL2 Ubuntu on a Windows box, RTX 4070 Super 12 GB, LAN `192.168.1.113`, tailnet `printer-1` | `printer` | **Wendy's primary home.** Runs Wendy (voice assistant, §9), GPU Whisper + TTS (`speaches` on `:8000`), the transcription endpoint on `:7070`, and the owner's primary Kimaki with 298 projects. |
| **Projector** — WSL2 Ubuntu on Windows 11, RTX 5090 32 GB, LAN `192.168.1.140`, tailnet `projector` | `projector` | **Wendy's brain host.** llama.cpp runs as a *Windows* process on `:8080` (profiles A–F via `C:\llama-cpp\llm.bat`; from WSL it is `192.168.1.140:8080`, NOT `127.0.0.1`). Nothing else Wendy-related is running there by decision (see §9.6). |
| **This M4 Max** | `mac` (tailnet `xipzs-macbook-pro`) | Being set up now. Target: standalone Wendy node + Whisper node. |

Corrections to earlier drafts of this table, all verified 2026-09-19:
- The `:7070` endpoint on the printer is **not** an auth'd shim and is **not LAN-reachable** — it binds `127.0.0.1` only and takes no bearer token. It is Wendy's own process (or a `serve`-mode copy of it). Do not plan to point this Mac at it over the LAN. Running Whisper locally on the Mac is the correct plan.
- `kimaki-whisper-shim` is not part of the current stack. The live repo is **`Xipzer/Wendy`** (checked out as `~/WebstormProjects/kimaki-whisper` on every node).
- The 5090 box has one brain process, not three; the profiles are launch configs of the same llama.cpp.

## 9. Wendy and Whisper — the part you actually have to run

This is the missing half. The LLM above is only one of Wendy's four organs.

### 9.1 What Wendy is

A voice-first agency assistant for the owner (Discord id `1373950239303532656`).
She joins whatever voice channel he is in, hears **only him** (she subscribes to
his user id's audio stream — other people in the call are never decoded), thinks
with a local LLM, speaks back, and *acts*: she reads and dispatches to his Kimaki
agent threads, watches them, tells him when they finish, and reads/answers his
Telegram. He uses her to run and supervise work while away from a keyboard or in
parallel with it. She is **not** a chatbot; most of her value is the tool loop.

Repo: `Xipzer/Wendy` → checkout at `~/WebstormProjects/kimaki-whisper` (already
cloned and built on this Mac). Read in this order: `WENDY.md`, `src/wendy.ts`
(the loop), `src/brain/guards.ts` (the deterministic policy layer),
`src/node/identity.ts`, `docs/PROJECTOR-HANDOFF.md` (a sibling of this doc).

### 9.2 Her four organs and what each machine needs

```
  ears    Whisper STT    speaches  :8000  /v1/audio/transcriptions   Systran/faster-whisper-large-v3
  mouth   Kokoro TTS     speaches  :8000  /v1/audio/speech           speaches-ai/Kokoro-82M-v1.0-ONNX, voice af_heart
  brain   Qwen3.8-27B    llama.cpp :8080  /v1/chat/completions       alias "local-fast", tools + reasoning_content
  hands   kimaki CLI     local             session/read/send/list     her view of the world = THIS machine's Kimaki
```

**Ears and mouth are one process** (`speaches`, a Python server). Wendy talks to
it via `speachesUrl` in config. Both endpoints must answer or she is deaf or mute.

**The brain must speak the llama.cpp dialect she expects:** OpenAI chat
completions with `tools`, streaming, and `reasoning_content` in deltas (she
records her own chain-of-thought in diagnostics from that field). She sends
`model: "local-fast"` — so whatever serves the brain must expose that alias.
This matters for §2 of this document: if you go LM Studio / Ollama / MLX, the
endpoint must still answer as an OpenAI-compatible server with tool calling, and
you must alias the model as `local-fast` (or set a different alias in the brain
client — `src/brain/client.ts`, `laneModel()`). Reasoning content is optional
but tool calling is not: without it she cannot do anything.

**Hands are local by construction.** Every thread she can see comes from `kimaki
session list` on the machine she is running on. Her memory travels between
nodes (§9.5); her eyes do not. On this Mac she can only see and act on this
Mac's Kimaki projects. She is told this in every prompt (`nodeBlock()`), so she
will say "that thread isn't reachable from here" rather than pretend.

### 9.3 The transcription endpoint (`:7070`) — what Kimaki calls

Kimaki transcribes Discord voice notes by POSTing an OpenAI-style
`chat/completions` body carrying `input_audio` (base64, ogg) to
`OPENAI_BASE_URL`, and expects a `transcriptionResult` tool call back. Wendy's
process serves exactly that on `127.0.0.1:7070` (`src/server.ts`) and forwards
the audio to speaches. Two modes:

- **full Wendy** (`node dist/cli.js`) — serves `:7070` *and* connects to Discord
  as her. **One live Wendy per bot token, ever** (Discord allows one gateway per
  token; Telegram 409s a second poller). Running her here while she runs on the
  printer produces two assistants answering over each other — this happened, it
  is not theoretical.
- **`serve` mode** (`node dist/cli.js serve`) — `:7070` only, no gateway. Safe to
  run alongside the real Wendy elsewhere. Optionally opens a *retranscribe-only*
  gateway on `serveBotToken` (this node's own Kimaki bot, a different identity).

Kimaki must be launched with `OPENAI_BASE_URL=http://127.0.0.1:7070/v1` **in its
own environment**. Every transcription failure this week was one of three
ordering bugs: Kimaki started before `:7070` existed (`ECONNREFUSED`); Kimaki
inherited a shell without the variable and called real OpenAI (`Incorrect API
key`); speaches was not running behind the sidecar (`backend unreachable`).
The cure is a launcher that checks each dependency and waits for a real `200`
before exec'ing Kimaki — `~/bin/kimaki-prereqs` on the printer is the reference;
port it here.

### 9.4 Config — `~/.kimaki-whisper/config.json` (+ `node.json` overrides)

Keys she reads: `botToken` (Discord, hers), `foreignBotToken` (Wendy#9995, used
in servers where the main bot is absent), `ownerId`, `brainUrl`, `speachesUrl`,
`port`, `ttsVoice`, `telegramBotToken`, `telegramVips`, `wendyChannelId`,
`brainWakeCommand` / `brainStartCommand` / `brainStopCommand`, `visionUrl` /
`visionModel` (optional side-channel), `serveBotToken` (serve mode only),
`spawnModels` (aliases → provider/model ids she may spawn agents on).

`node.json` on this Mac already exists and is applied on top of `config.json` at
promote time (`wendy-node.sh`). It should say, for a standalone Mac:

```json
{ "name": "mac", "role": "standby", "label": "the M4 Max laptop - last node standing",
  "peers": [],
  "brainUrl": "http://127.0.0.1:8080", "speachesUrl": "http://localhost:8000", "port": 7070,
  "brainStartCommand": "<whatever starts the local brain>", "brainStopCommand": "<stops it>" }
```

Wake/stop commands run through `bash -c`; she calls them when the brain is
unreachable and reports honestly whether it came back (`brainControl()`).

### 9.5 Multi-node: how she moves, and the rules

`wendy-node.sh` (in the repo) — `status | sync <from> | promote [from] |
demote <to> | handover <from> <to>`. Her state is ~5 MB: `workspace/` (memory,
journal, dispatch ledger, pins, triggers, history), `telegram/` (profiles, poll
offset), `config.json`. The 750 MB ONNX runtime and the diagnostics are per-node
and never travel. `promote` uses a pushed snapshot in `~/.kimaki-whisper/incoming/`
if one exists (the design is that the active node pushes every 2 minutes via
`wendy-sync.sh`), else pulls from the named node, then stops that node, applies
`node.json`, and starts her here under `restart-wendy.sh` (a supervisor that
respawns on crash and drains an in-flight reply before a restart).

**Rules learned the hard way — do not relearn them:**
1. One Wendy. Before promoting, confirm nothing else holds the token
   (`wendy-node.sh status`).
2. Never kill by regex across machines. Three outages this week were
   `pkill -f` patterns matching the wrong process, including one that killed the
   primary from a command run on another host. Use pid files / the service manager.
3. `pgrep -f` matches its own shell — use `dist/cli.j[s]` style patterns.
4. Two launchers racing SIGTERM each other. Wait for `armed` in
   `~/.kimaki-whisper/wendy.log` before launching again.
5. Never restart Kimaki from inside a Kimaki thread — you drop your own session.
6. A standby's retranscribe must *post* the text, not feed it to the agent
   (serve mode does this); otherwise the agent answers itself.

### 9.6 Current state of the estate — read before you assume anything

- **Printer**: Wendy active, healthy, single instance. Brain: stopped by the owner
  ("kill Wendy brain for now"); she will say "waking it" and try the wake command.
- **Projector**: **everything except the brain was torn down by the owner's
  instruction** after a reactive setup went badly. The repo checkout, a CPU
  speaches install (`~/speaches-server`, pinned to commit `993994f`, CPU
  `onnxruntime` — see the traps below), node.json, and the 21 GB model file are
  still on disk, inert. Do not restart them; a proper design is pending.
- **This Mac** — measured over ssh 2026-09-19, not assumed:
  - **Wendy is NOT cloned here.** `~/WebstormProjects` holds only ContextTemple,
    MeloNX, opencode-anthropic-oauth-fix. `~/.kimaki-whisper/node.json` exists
    (brain via `launchctl` `wendy.brain`) but **no such LaunchAgent exists** and
    there is no `config.json`. First job: `git clone git@github.com:Xipzer/Wendy
    ~/WebstormProjects/kimaki-whisper && npm ci && npm run build`.
  - Node is **v24.14.1 via nvm**, not Homebrew. `bun` is **not installed**.
  - Homebrew has `llama-server`, `mtplx`, `whisper-server`, `uv`
    (`/opt/homebrew/bin` — absent from non-login ssh shells; use `zsh -lc`).
    `mlx_lm.server` is not installed.
  - Models on disk: `~/models/Qwen3.8-27B-Uncensored-Q6_K.gguf` (21 GB),
    `~/models/huihui-vision/`, and in the HF cache
    `mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit` (21 GB, complete) plus a stub of
    `Youssofal/Qwen3.6-27B-Abliterated-Heretic-Uncensored-MLX-4bit` (376 KB —
    not downloaded). The 35B-A3B MLX build is the obvious §2 candidate and is
    already here.
  - speaches: `~/speaches-server` with venv and `run-speaches-mac.sh` (CPU int8,
    preloads `Systran/faster-whisper-large-v3`, `WHISPER__TTL=-1`). Not running.
  - **A Kimaki is running** (pid 57293, up >1 day, the owner's own). Do not
    restart it from inside a thread. `~/.zshrc` already exports
    `OPENAI_BASE_URL=http://localhost:7070/v1` + `OPENAI_API_KEY=sk-local-shim`;
    `bot_api_keys` in `~/.kimaki/discord-sessions.db` is empty (good: nothing
    overrides the env). Nothing is listening on `:7070`, `:8000`, or `:8080`, so
    voice notes here currently fail.
  - Leftovers from the old design (§9.9): `~/kimaki-whisper-shim/` (Bun shim —
    cannot run, no bun) and `~/whisper-models/ggml-large-v3.bin` (2.9 GB for
    `whisper-server`). Both are obsolete; keep or delete, never run.

### 9.7 Traps specific to speaches (all hit on the projector)

- Clone drift: a fresh `main` pulled an `onnx-asr` that broke `NemoConformerTdt`
  imports. Pin the commit the printer runs (`993994f`) and `onnx-asr==0.7.0`,
  `faster-whisper==1.1.1`, `ctranslate2==4.5.0`. Mirror the printer's venv if in
  doubt; `uv` sometimes refuses to reinstall a package it thinks is present —
  unpacking the wheel into site-packages worked when nothing else did.
- The silero VAD runs under `onnxruntime`. A GPU build without matching kernels
  500s every request with a `Conv` NOT_IMPLEMENTED. On CPU or Apple, install the
  plain `onnxruntime` wheel.
- Turbo model ids are not registered under `Systran/` in speaches' registry;
  `Systran/faster-whisper-large-v3` is what works. On this Mac, CPU int8 large-v3
  will transcribe a short clip in ~5–6 s. Evaluate `WHISPER__INFERENCE_DEVICE`
  options for Metal, but the CPU path is a known-good baseline.
- Set `WHISPER__TTL=-1` and preload the model; a cold load on the first voice
  note costs ~30 s and reads as "she's dead".

### 9.9 The two older Mac guides — what still holds and what is dead

Two earlier documents were written for this machine ("Local LLM Operations
Guide" and "Local Voice-Note Transcription — macOS"). Read them for the
reasoning; do not follow their instructions where they conflict with this doc:

| Old claim | Now |
|---|---|
| A separate Bun **shim** (`~/kimaki-whisper-shim`) answers `:7070` | Superseded. Wendy's own process (or `serve` mode) is the `:7070` endpoint. The shim's request/response contract is what Wendy implements in `src/server.ts`; the code is no longer maintained. |
| `whisper-server` (whisper.cpp, Metal) is the recommended STT backend | Not what the estate runs. Wendy needs speaches for **TTS as well as STT** on one `speachesUrl`; whisper.cpp has no `/v1/audio/speech`. Use speaches. Metal for faster-whisper is unproven; CPU int8 is the baseline. |
| Patch Kimaki's `bin.js` to force `OPENAI_BASE_URL` | Don't. It rots on every `npx kimaki@latest`. Set the env in the launcher (prereq gate, §9.3). The `.zshrc` export is already in place as backup. |
| Clear `bot_api_keys` in the DB | Already empty here; still the right check if "Incorrect API key" ever appears. |
| 36 GB unified memory | `sysctl hw.memsize` reports 39 GB; the budgeting logic is unchanged. |
| "Ignore NVFP4", MoE > dense for bandwidth, MTPLX depth-3, Q4 to coexist with apps, measure-don't-trust | All still valid. The 35B-A3B MLX build already on disk is the practical starting point for §2; the 27B Q6 GGUF is 21 GB and will not coexist with the owner's open apps. |
| Vision via `huihui-vision` mmproj profile | Still relevant for Wendy's optional `visionUrl`/`visionModel` side-channel; run it as a separate profile, never on the fast brain port. |

### 9.8 Bringing this Mac up, in order — prove each step before the next

1. **Brain**: start `llama-server` (or your MLX choice) on `:8080` with the
   alias `local-fast`, tools enabled. Prove: `curl :8080/v1/models`; then one
   chat request **with a tools array** returns a `tool_calls` message.
2. **Ears/mouth**: start speaches on `:8000`. Prove: `/health` → 200; a real
   transcription returns text; `/v1/audio/speech` returns audio.
3. **`:7070`**: clone + build Wendy, run `node dist/cli.js serve` (safe while the
   printer owns the bot token). Then port `kimaki-prereqs` and relaunch Kimaki
   through it — from a terminal, not from inside a thread. Prove: a Discord voice note transcribes locally.
4. **Wendy standalone (only when the printer is NOT running her)**: `./wendy-node.sh
   promote printer` — or, if the printer is unreachable, promote from the local
   snapshot. Prove: `armed` in the log, she joins the owner's VC, greets, answers
   one question that requires a tool.
5. Hand back when the printer returns: `./wendy-node.sh demote printer`.

Report each step with the command, the observed output, and the timing.

## 8. Open questions — verify, don't assume

1. **Is there an abliterated Qwen3.8-27B in MLX format?** If not, decide between
   converting one (`mlx_lm.convert`) or accepting GGUF + llama.cpp.
2. **Real tok/s at Q4 on this machine**, at depth, on realistic material. The
   table in §1 is arithmetic, not measurement.
3. **Does MLX speculative decoding work with this model**, and what does it buy?
4. **huihui vs Heretic refusal rate** on the owner's actual audit prompts. This
   is the comparison that matters most and has never been run.
5. **Largest usable context** at Q4 with acceptable memory pressure.
6. **Thermal behaviour** over a sustained run.

Report measurements with the config, depth, corpus and run count attached. A
number without those is not a result.
