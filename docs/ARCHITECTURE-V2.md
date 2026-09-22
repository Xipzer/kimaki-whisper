# Wendy V2 — voice architecture, designed from zero (2026-09-22)

> **Built and measured the same day.** See §6 for results and deviations. Operate it via `docs/OPERATIONS.md`.

No backwards compatibility. No bias toward what exists. The goal is the best
self-hosted, tool-using, real-time voice assistant buildable today on this
estate (printer 4070S 12 GB, projector 5090 32 GB, M4 Max standby).

## 0. The one decision that shapes everything

**Cascaded streaming pipeline, not a speech-to-speech model.**

End-to-end S2S (Moshi, Qwen3-Omni, Qwen3.5-Omni) is the eventual winner on
latency and prosody, but as of today the only self-hostable path runs the
Talker at ~146 s per reply on Transformers; the fast Talker exists only behind
Alibaba's cloud API (arXiv 2603.05413, Mar 2026; Qwen3.5-Omni weights are
cloud-only). Wendy's value is the **tool loop** — reading agent threads,
dispatching, Telegram — which lives in text. A cascade keeps the brain
swappable and the tool loop untouched, and the SOTA streaming pieces on each
side now bring a cascade to ~1–2 s time-to-first-word with coherent prosody.

Every component below streams and speaks a websocket protocol; nothing waits
for a complete utterance or a complete reply.

## 1. Measured baseline (tonight)

```
you stop talking
 │ 0.3 s   Discord opus-close ends capture
 │ 0.7–1.4 s Whisper on the whole clip (after you finish)
 │ 10.0 s  brain prefill: 20.8k prompt tokens, cached_tokens = 0, EVERY turn
 │ 0.2 s   decode (84 tok/s, DFlash)
 │ 0.5–1 s Kokoro on the whole reply (streaming off)
 ▼ first word   ≈ 11–13 s
```

Cadence fault ("every word a question"): Kokoro is batch-only; each streamed
chunk is synthesised as a standalone utterance with a terminal contour, and no
prosodic context carries across chunks. No chunking rule fixes that; the TTS
must see text as a stream with lookahead.

## 2. Target architecture

```
                         ┌──────────────────────── wendy-core (Node/TS, one per node) ───────────────────────┐
 Discord VC              │                                                                                    │
 owner's opus ──48k──►   │  audio-in ──24k pcm/20ms──► ws ► kyutai-stt (moshi-server)                         │
                         │                           ◄─ words + word timestamps + VAD scores every 20 ms ─┘   │
                         │        turn-taking FSM  ◄──── semantic end-of-turn (pause score > θ)               │
                         │        LISTEN → THINK → SPEAK → (BARGE-IN) → LISTEN                                │
                         │                                                                                    │
                         │  brain ► llama.cpp @5090  Qwen3.8-27B-Uncensored Q6 + DFlash drafter              │
                         │          -np 2 --cache-reuse 256   slot0 = conversation   slot1 = background        │
                         │          cache-stable prompt: [static system+tools+memory] [history] [turn-local]  │
                         │          streaming deltas ─► tool calls executed here ─► text words ───────────┐  │
                         │                                                                                 ▼  │
                         │  audio-out ◄──24k pcm──◄ ws ◄ kyutai-tts (moshi-server) ◄── words as they arrive  │
                         │  ► opus ► Discord                     (text-streaming TTS, ~220 ms to first audio) │
                         │                                                                                    │
                         │  :7070  Kimaki transcription endpoint ─► same kyutai-stt, batch mode                │
                         │  own-domain gateway (this device's Kimaki bot)   wendy gateway (primary only)      │
                         └────────────────────────────────────────────────────────────────────────────────────┘
```

### Components and why

| Organ | Choice | Why it beats the alternatives today |
|---|---|---|
| **Ears** | **Kyutai STT 1B `stt-1b-en_fr`** via `moshi-server` (Rust, websocket) | Streaming words with **0.5 s** algorithmic delay, word timestamps, and a **semantic VAD** that predicts end-of-turn (pause score every 20 ms) — this replaces Discord opus-close + RMS gates + whole-clip Whisper. 2.5 GB VRAM. Batchable, so the `:7070` Kimaki endpoint uses the same server. MLX build exists for the Mac. CC-BY-4.0. Voxtral Realtime is CC-BY-NC; Whisper has no streaming or VAD. |
| **Brain** | **llama.cpp on the 5090**, Qwen3.8-27B-Uncensored Q6 + DFlash — kept | Already 84–93 tok/s. The 10 s is not the model, it is a zero cache hit. Fix: (a) stable prefix — static system prompt + tool specs + `memory.md` first, per-turn material (journal hits, node block, routes) appended to the **latest user message**; (b) `-np 2`, `id_slot 0` for the conversation, `id_slot 1` for background lanes so summaries never evict the conversation KV; (c) `--cache-reuse 256` so history eviction shifts rather than invalidates. Expected prefill: 20k → ~1–2k tokens ≈ 0.5–1 s. (d) reasoning budget by turn class: conversational turns `/no_think`, tool turns think. |
| **Mouth** | **Kyutai TTS 1.6B** via `moshi-server` | The only mature open TTS that is **streaming in text**: it consumes LLM words as they arrive and generates with lookahead (delayed-streams), 220 ms first audio, coherent prosody across the whole reply — the structural fix for the cadence fault. Production Rust server (runs unmute.sh), 5.3 GB VRAM, MLX build for the Mac. Preset voices only (no cloning). Qwen3-TTS 0.6B/1.7B (Apache, 97 ms, VoiceDesign) is the quality successor but its streaming server is immature (vLLM-Omni offline-only, forks vary); it goes behind the same `TtsEngine` interface as a swap-in when serving matures. |
| **Turn-taking** | FSM driven by STT VAD scores | End-of-turn = semantic pause, not silence length. Barge-in = STT reports owner speech while SPEAKING → cancel TTS stream immediately (websocket close), keep what was said in history as "interrupted after: …". Fragments cannot supersede a reply: an utterance shorter than 3 words or 0.6 s while THINKING is appended to the pending input, never a new sequence. |
| **Hands** | unchanged: `kimaki` CLI, Telegram, tool specs, guards, ledgers, attention queue | The value; not touched except to run on the new turn FSM. |
| **Nodes** | as built tonight: one process, role-driven, own-domain gateway everywhere | Organs are URLs. Printer hosts ears+mouth on the 4070S (8 GB of 12), brain on the 5090. Standby nodes run the identical `moshi-server` pair (CUDA on projector, MLX on Mac) and either their own brain or the 5090 over the tailnet. |

### Latency budget (target, single user)

```
 owner stops                                  0 ms
 semantic end-of-turn                 200–400 ms   (VAD threshold crossing)
 STT flush (1B delay)                     500 ms
 brain TTFT (cached prefix, 1–2k new)  300–800 ms   (5090, DFlash)
 TTS first audio                          220 ms
 opus + Discord jitter buffer             100 ms
 ────────────────────────────────────────────────
 time to first word                   1.3 – 2.0 s   (from 11–13 s)
```

Phase 2 shaves further: **pre-thought** — start prefilling history + partial
transcript while he is still talking (the STT gives words live), so at
end-of-turn only the last few words are new.

## 3. What is bulldozed

- `speaches` (Whisper + Kokoro), the RMS/self-calibrating gates, capture
  segmentation and "monologue buffer" rotation, sentence-chunked TTS,
  `streamSpeech`, opus-close end-of-turn detection, the ONNX runtime tier.
- `src/wendy.ts` as a 2,500-line monolith. Replaced by:

```
src/
  audio/    discord-in.ts (owner stream → 24k pcm)   discord-out.ts (24k pcm → opus player)
  stt/      kyutai.ts   (ws client: words, timestamps, vad; batch helper for :7070)
  tts/      engine.ts   (TtsEngine interface)  kyutai.ts   (ws client, text in / pcm out, cancel)
  brain/    client.ts   (streaming, slots, cache-stable builder)  prompt.ts  guards.ts  lanes.ts
  turn/     fsm.ts      (LISTEN/THINK/SPEAK/BARGE, fragment rule, superseded carry)
  tools/    state/  attention/  node/  telegram/   ← survive as they are
  server.ts (:7070 via stt batch)   cli.ts   discord.ts (gateways)
deploy/
  moshi/    stt.toml  tts.toml  docker-compose.yml (CUDA)   mac/ (MLX launchers)
  llama/    profile-A.bat additions: -np 2 --cache-reuse 256
```

## 4. Build order — each step proven before the next

1. **Brain cache** (no new software): cache-stable prompt builder + slots +
   `--cache-reuse`. Prove: `cached_tokens` ≈ prompt_tokens − new tokens on
   turn 2; TTFT < 1 s in the `brain` diag line.
2. **moshi-server on the printer** (CUDA, WSL2): `stt-1b-en_fr` + `tts-1.6b`,
   one config each, systemd units. Prove: `curl` health; a 10 s wav streamed
   at 20 ms frames returns words with timestamps and pause scores; a text
   stream returns pcm with first packet < 400 ms.
3. **Turn FSM + audio-in/out** against the two servers, dry-run harness (feed a
   wav, get pcm) with no Discord. Prove: end-to-end first-audio < 2 s on the
   bench, barge-in cancels within one frame.
4. **Wire Discord**: owner stream in, player out, gateways unchanged. Prove: in
   #Wendy, one tool-requiring question, first word < 2.5 s, no "question
   intonation", interruption works.
5. **`:7070` on kyutai batch**; remove speaches. Prove: a Kimaki voice note
   transcribes.
6. **Standby parity**: projector CUDA pair, Mac MLX pair; `wendy-node.sh`
   handover proves an identical experience from another node.
7. **Phase 2**: pre-thought prefill; Qwen3-TTS adapter when its streaming
   server is solid; voice design for Wendy.

## 5. Risks, stated

- Kyutai TTS: preset voices, EN/FR only, CC-BY-4.0 weights (attribution).
  Acceptable for Wendy; swap path defined.
- `moshi-server` needs a CUDA build under WSL2 (Rust + cuDNN); x86_64 only —
  fine for printer/projector; Mac uses MLX scripts (different launcher, same
  protocol shape) — verify the MLX TTS keeps real-time at 8-bit.
- 4070S budget: STT 2.5 + TTS 5.3 = 7.8 GB of 12; nothing else Wendy-related
  on that GPU once speaches is gone.
- STT delay is 0.5 s by design; the 2.6B EN model has better WER but 2.5 s
  delay — wrong trade for conversation.

## 6. Built — measured results (2026-09-22)

| Step | Proof |
|---|---|
| 1 brain cache | warm turn: `prompt_n=16`, `cached=11341`, **0.6 s total** (was 10 s). Slots 0/1 confirmed via `/slots`. |
| 2 kyutai | `deploy/kyutai/server.py` — STT words + VAD every 80 ms, TTS first audio **~750 ms** warm, RTF 0.31. 6.0 GiB VRAM. |
| 3 loop bench | `scripts/bench-voice.mjs`, 16.8 s owner clip, real 5090: end-of-turn +0.98 s, brain first sentence +1.0 s, **first audio 2.9 s** after the owner stopped (warm); 6.8 s cold cache. |
| 4 live | wired: `src/voice/loop.ts` replaces capture/gates/chunking in `wendy.ts`; Wendy reloaded on V2. |
| 5 :7070 | **kept on speaches** by decision — Whisper large-v3 stays the accuracy reference for Kimaki voice notes; Kyutai serves the live loop only. |

Deviations from the plan, and why:
- **PyTorch server instead of `moshi-server` (Rust).** The Rust build needs a
  CUDA/cuDNN toolchain under WSL2 that was not worth the night; the Python
  server implements the same wire contract. Cost: ~0.5 s extra TTS first audio
  (0.75 s vs ~0.25 s). Swapping to the Rust server later changes nothing above it.
- **speaches stays** for the Kimaki `:7070` endpoint (see step 5).
- **Voice:** `ex04-ex02_happy` (female). Expresso `ex03` is male — the first
  sample shipped with it by mistake.

Remaining latency, where it is, and the next cut for each:
```
 end-of-turn   0.98 s   VAD crossing + 650 ms guard + 0.5 s model delay   → tune guard to ~400 ms once false-cuts are measured
 brain         1.0 s    reasoning_effort low still spends ~40 tokens       → /no_think for conversational turns
 tts           0.9 s    python step loop                                   → moshi-server (Rust) ≈ 0.25 s
 ─────────────────────
               2.9 s    target after the three cuts ≈ 1.6 s
```
