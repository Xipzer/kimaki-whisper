# Telegram DM Triage (official Business API - zero ban risk)

Read-only ingestion of the owner's personal Telegram DMs through the official
Business API ("Secretary Mode" as of 2026). No userbot, no MTProto, no session
string - a regular bot that Telegram itself connects to the personal account,
revocable with one switch. There is nothing to ban.

## Research summary (write-safety question)

- **MTProto userbot writes: the caution is justified.** Telegram actively
  flags user-API automation; write behavior is the primary trigger; bans are
  real. Do NOT enable any MTProto write path on the personal account, ever.
- **Business API replies are officially sanctioned.** If/when a write path is
  wanted, it goes through the business connection (with per-message owner
  approval as the default) - a product decision, not a ToS risk. Currently NOT
  implemented: this build is strictly read-only.
- **Groups**: handled via the regular Bot API (still sanctioned, zero risk):
  add @XipzWendyBot to a group, then either promote it to admin there (any
  admin sees all messages; give it a single harmless right) OR turn Group
  Privacy off in BotFather (/setprivacy) so it sees all messages in groups
  it joins. Ingestion is ALLOWLIST-gated regardless: only chat ids listed in
  config `telegramGroups` are stored; everything else is discarded at the
  door. telegram_inbox lists seen-but-unlisted groups with their ids for
  easy allowlisting.
- Other limits: no history from before the connection; replies (if ever
  enabled) only within 24h of an incoming message.

## Owner setup (one time, ~5 minutes)

1. @BotFather -> `/newbot` -> name it (e.g. `xipz_secretary_bot`). Copy the token.
2. BotFather -> Bot Settings -> **Business Mode / Secretary Mode -> ON**.
3. Telegram app -> Settings -> **Telegram Business -> Chatbots** -> pick the bot.
   - Grant read; leave "Reply to messages" OFF (read-only build).
   - Scope: "All private chats" or "Exclude contacts" (recommended: exclude
     contacts keeps friends out of the pipeline entirely).
4. Config (`~/.kimaki-whisper/config.json`):

```json
{
  "telegramBotToken": "123456:ABC...",
  "telegramVips": ["someusername", "441234567890"]
}
```

5. Restart the sidecar. Log line: `telegram: business-API collector started`.

## How it surfaces

| Tier | Who | Behavior |
|---|---|---|
| VIP | `telegramVips` (usernames or ids) | immediate [HIGH] via Wendy, with a one-line summary + suggested reply |
| Known | anyone the owner has replied to (learned automatically from outgoing business messages) | [MED] digest items |
| Other | everyone else (the 90-95%) | stored only; collapsed by sender into the on-demand digest |

Ask Wendy: "anything important on Telegram?" -> `telegram_inbox` returns the
triage. Nothing about the Other tier is ever proactively announced - by design,
this must not become a second compulsive inbox.

## Storage

`~/.kimaki-whisper/telegram/`: `inbox.jsonl` (raw ingested DMs),
`contacts.json` (learned known-tier), `state.json` (poll offset).

## Media and image vision

Every non-text message is ingested with its type and caption - `[PHOTO 1280x720]`,
`[STICKER 😂 from "pack"]`, `[GIF]`, `[VOICE NOTE 12s]`, `[FILE "spec.pdf" (application/pdf)]`,
`[POLL: ...]` - so she always knows *what* arrived and from whom.

**Seeing inside images is optional and off by default.** The 5090's vision profile
(C) cannot run alongside her text brain, so captioning needs a separate small
endpoint (e.g. a Qwen2-VL served on the 4070S). Once one exists:

```json
{ "visionUrl": "http://127.0.0.1:8100", "visionModel": "local-vision" }
```

Photos are then downloaded and captioned asynchronously (never blocking ingestion),
appending `- shows: ...` to the message. Without it she is explicitly instructed to
say she cannot see the image rather than guess.
