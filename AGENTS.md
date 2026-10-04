## Kimaki-fork changes need a Wendy end-to-end gate (owner requirement)

Any change here that adopts a new Kimaki-fork capability (session status/read/model/recover, command registration, event APIs), or any Kimaki-fork change Wendy depends on, is not done until it passes an end-to-end run of the real brain:

1. Build this branch and point `kimaki` calls at the fork CLI (`~/WebstormProjects/kimaki-tailored`) via PATH, not the live npx copy.
2. Drive `think()` with real tools (pattern: `test/sim-messy.mjs`, which backs up and restores state) using spoken-style scenarios covering the new feature and existing flows: thread status, latest reply, ask/send, lookup by name, model switch, blocked thread. Send only to a sandbox thread.
3. Run the same scenarios against production (master + published kimaki) as the baseline and compare correctness, tool calls per turn, turn latency, and errors. Regressions block the change.
4. If the brain misuses or ignores the feature, add rails (tool spec wording, prompt rules, guards) in the same change.
5. Record results in the fork at `docs/analysis/wendy-e2e-<date>.md`.
