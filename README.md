# kimaki-whisper

Local, free, private **voice-note transcription for [Kimaki](https://github.com/remorses/kimaki)** — as a **sidecar**: a small companion process that needs **zero changes to Kimaki itself**.

```
npx kimaki-whisper           # run the sidecar
/whisper-setup model: Auto   # in Discord — downloads + configures a local model
```

Audio never leaves your machine. No API keys, no Python, no GPU required (GPU optional).

## How it works (no Kimaki changes)

```
                 ┌── Discord (same bot token) ──┐
      gateway #1 │                              │ gateway #2
   ┌─────────────┤                              ├──────────────┐
   ▼             └──────────────────────────────┘              ▼
 KIMAKI (stock)                                     KIMAKI-WHISPER SIDECAR
 ├─ ignores unknown slash commands                  ├─ registers /whisper-* itself
 ├─ voice notes → OPENAI_BASE_URL                   ├─ OpenAI-compatible endpoint on
 │   (built-in behavior)                            │   127.0.0.1:7071 (ONNX whisper
 └─ `kimaki send` CLI                               │   in-process, or GPU backend proxy)
                                                    └─ reply "retranscribe" to any voice
                                                        note → re-transcribes + injects
                                                        via `kimaki send`
```

- **Slash commands**: registered additively (per-command POST) on the same bot; Kimaki silently ignores commands it doesn't know, the sidecar answers them.
- **Transcription**: Kimaki already routes voice-note transcription to any OpenAI-compatible endpoint via `OPENAI_BASE_URL`. The sidecar *is* that endpoint.
- **Missed voice notes**: reply `retranscribe` to any voice note — the sidecar re-fetches the audio and injects the transcription into the session through Kimaki's public `kimaki send` CLI.

## Setup

1. **Run the sidecar** (it finds your bot token from Kimaki's config automatically, or paste it once):

   ```bash
   npx kimaki-whisper
   # if token auto-detection fails:
   npx kimaki-whisper setup --token <your bot token>
   ```

2. **Pick a model** — in Discord: `/whisper-setup model: Auto` (recommends by your machine's RAM/CPU), or in the terminal: `kimaki-whisper setup --model auto`.

   | Tier | Model | Download |
   |---|---|---|
   | Fast | whisper-tiny | ~110 MB |
   | Balanced | whisper-base | ~200 MB |
   | Accurate | whisper-small | ~600 MB |
   | Best | large-v3-turbo | ~1 GB |

   The ONNX inference runtime installs on demand into `~/.kimaki-whisper/` (not bundled — keeps `npx` fast).

3. **Wire Kimaki (one line, once)** — add to your shell profile and restart Kimaki:

   ```bash
   export OPENAI_API_KEY=local OPENAI_BASE_URL=http://127.0.0.1:7071/v1
   ```

   > This is the only manual step, because a sidecar can't set another process's environment. Everything else is automatic.

## GPU / advanced

Have a GPU backend (e.g. [speaches](https://github.com/speaches-ai/speaches) running faster-whisper large-v3)? Proxy to it instead of the built-in model:

```
/whisper-setup backend-url: http://localhost:8000/v1
```

## Commands

| Discord | Terminal | |
|---|---|---|
| `/whisper-setup` | `kimaki-whisper setup` | pick model / backend |
| `/whisper-start` | — | start the endpoint |
| `/whisper-stop` | — | stop it (free RAM) |
| `/whisper-status` | `kimaki-whisper status` | health/config |

Reply **`retranscribe`** to any voice note to recover a missed transcription.

## Notes

- If your Kimaki build already implements `/whisper-*` natively (e.g. the PR branch), both would answer — set `commandPrefix` in `~/.kimaki-whisper/config.json` (e.g. `"kw"`) to use `/kw-*` instead.
- Kimaki re-registers its command set on restart, which removes the sidecar's commands until the sidecar's periodic re-registration (6h) or restart. Restart the sidecar after upgrading Kimaki for instant re-registration.

MIT
