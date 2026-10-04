## Kimaki-fork changes need a Wendy end-to-end gate (owner requirement)

Wendy (`~/WebstormProjects/kimaki-whisper`, read its README + docs/OPERATIONS.md first) is a live voice presence in Discord voice channels: Kyutai STT -> local brain -> ~20 tools that drive Kimaki -> Kyutai TTS. Her work lives in the #wendy channel (her spawn_agent threads, the "Wendy activity (read-only)" mirror). Any Kimaki-fork change (`~/WebstormProjects/kimaki-tailored`) that Wendy calls, parses, or depends on is NOT done until it passes a Wendy end-to-end run, on top of unit tests and tsc:

1. run the candidate as the real Wendy (live node or a promoted standby via `wendy-node.sh`), with her `kimaki` calls going to this fork's CLI. agree the slot and rollback with the owner first; never swap production silently.
2. speak the scenarios to her in a voice channel (owner live, or synthesized owner audio). she must do the work through her own tools; any threads she creates go to #wendy, never to project channels. cover the new feature and existing flows: thread status, latest reply, ask/send, lookup by spoken name, model switch, blocked thread, chatter.
3. verify from her side: activity mirror, `~/.kimaki-whisper/diagnostics/*.jsonl` (utterance, brain hops, tool calls, first_audio), and ground truth from Kimaki.
4. run the same spoken script against the current production Wendy as the baseline; compare correctness, tool calls per turn, time to first audio, turn time, errors. any regression blocks the change. if the brain misuses or ignores the feature, add rails in Wendy in the same change.
5. `scripts/bench-voice.mjs` and `think()` sims are pre-checks only, not the gate. record results in the fork's `docs/analysis/wendy-e2e-<date>.md`.

