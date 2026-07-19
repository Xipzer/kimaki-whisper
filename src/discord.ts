// Second gateway connection on the SAME bot token as Kimaki. Discord allows
// multiple sessions per bot; Kimaki silently ignores slash commands it doesn't
// recognize (verified: bare `return` in its interaction handler), so the sidecar
// can own /whisper-* without any Kimaki changes.
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  ChatInputCommandInteraction,
  Message,
} from 'discord.js'
import { spawn } from 'node:child_process'
import { loadConfig, saveConfig, DEFAULT_PORT, log } from './config.js'
import { MODEL_TIERS, tierById, recommendTier, installRuntime, getPipeline } from './transcribe/local-onnx.js'
import { transcribeAudioBytes, startServer, isServerRunning, stopServer } from './server.js'

function prefix(): string {
  return loadConfig().commandPrefix ?? 'whisper'
}

function buildCommands() {
  const p = prefix()
  return [
    new SlashCommandBuilder()
      .setName(`${p}-setup`)
      .setDescription('Set up local voice transcription (sidecar) — pick a model, Kimaki handles the rest')
      .addStringOption((o) =>
        o.setName('model').setDescription('Built-in local model (auto = best for this machine)').setRequired(false)
          .addChoices(
            { name: 'Auto — recommended for this machine', value: 'auto' },
            ...MODEL_TIERS.map((t) => ({ name: `${t.label} — ${t.approxSize}`, value: t.id })),
            { name: 'Off — disable sidecar transcription', value: 'off' },
          ))
      .addStringOption((o) =>
        o.setName('backend-url').setDescription('Advanced: proxy to an OpenAI-compatible /v1 backend (e.g. GPU speaches)').setRequired(false))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder().setName(`${p}-start`).setDescription('Start the sidecar transcription endpoint').setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName(`${p}-stop`).setDescription('Stop the sidecar transcription endpoint').setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName(`${p}-status`).setDescription('Sidecar transcription status').setDMPermission(false).toJSON(),
  ]
}

async function safeReply(i: ChatInputCommandInteraction, content: string): Promise<void> {
  // Another process (a Kimaki build that implements /whisper-*) may have acked
  // first — swallow "already acknowledged" instead of crashing.
  try {
    if (i.deferred || i.replied) await i.editReply(content)
    else await i.reply({ content, flags: MessageFlags.Ephemeral })
  } catch (e) {
    log('reply skipped (another handler acked first?):', (e as Error).message)
  }
}

async function handleSetup(i: ChatInputCommandInteraction): Promise<void> {
  const model = i.options.getString('model')
  const backendUrl = i.options.getString('backend-url')

  try { await i.deferReply({ flags: MessageFlags.Ephemeral }) } catch { return }

  if (backendUrl) {
    saveConfig({ backendUrl, model: undefined })
    startServer()
    return safeReply(i, `🎤 Sidecar proxying to backend: ${backendUrl}\nPoint Kimaki at http://127.0.0.1:${loadConfig().port ?? DEFAULT_PORT}/v1`)
  }
  if (!model) {
    const rec = recommendTier()
    return safeReply(i, `🎤 **Sidecar setup**\nRecommended for this machine: **${rec.tier.label}** (${rec.tier.approxSize}) — ${rec.reason}.\nRun \`/${prefix()}-setup model: Auto\` to configure it.`)
  }
  if (model === 'off') {
    saveConfig({ model: undefined, backendUrl: undefined })
    return safeReply(i, '🎤 Sidecar transcription **disabled**.')
  }

  const tier = model === 'auto' ? recommendTier().tier : tierById(model)
  if (!tier) return safeReply(i, `⚠️ Unknown model: ${model}`)

  await safeReply(i, `🎤 Setting up **${tier.label}** (${tier.approxSize}, one-time download)...`)
  const inst = await installRuntime()
  if (inst instanceof Error) return safeReply(i, `⚠️ ${inst.message}`)
  const pipe = await getPipeline({ hfModel: tier.hfModel, onProgress: () => {} })
  if (pipe instanceof Error) return safeReply(i, `⚠️ ${pipe.message}`)

  saveConfig({ model: tier.id, backendUrl: undefined })
  startServer()
  const port = loadConfig().port ?? DEFAULT_PORT
  return safeReply(i, `✅ **${tier.label}** ready — transcription runs locally, in-process.\nOne-time wiring: launch Kimaki with \`OPENAI_BASE_URL=http://127.0.0.1:${port}/v1 OPENAI_API_KEY=local\` (add to your shell profile).`)
}

async function handleLifecycle(i: ChatInputCommandInteraction, action: 'start' | 'stop' | 'status'): Promise<void> {
  const cfg = loadConfig()
  const port = cfg.port ?? DEFAULT_PORT
  if (action === 'start') {
    if (!cfg.model && !cfg.backendUrl) return safeReply(i, `⚠️ Not configured — run \`/${prefix()}-setup\` first.`)
    startServer()
    return safeReply(i, `🎤 Sidecar endpoint running at http://127.0.0.1:${port}/v1`)
  }
  if (action === 'stop') {
    stopServer()
    return safeReply(i, '🛑 Sidecar endpoint stopped (RAM freed).')
  }
  const source = cfg.backendUrl ? `backend ${cfg.backendUrl}` : cfg.model ? `built-in ${cfg.model}` : 'not configured'
  return safeReply(i, `🎤 Sidecar: **${isServerRunning() ? 'running' : 'stopped'}** on :${port} — source: ${source}`)
}

const RETRANSCRIBE = /^\s*(?:re-?transcribe|retry(?:\s+transcription)?|transcribe(?:\s+(?:this|that|again))?)\s*$/i

function isVoiceAttachment(a: { contentType: string | null; name: string }): boolean {
  if (a.contentType?.startsWith('audio/')) return true
  return /\.(ogg|oga|opus|mp3|m4a|wav)$/i.test(a.name)
}

async function handleRetranscribe(message: Message): Promise<void> {
  if (message.author.bot) return
  if (!message.reference?.messageId || !RETRANSCRIBE.test(message.content)) return

  const parent = await message.fetchReference().catch(() => null)
  if (!parent) return
  const audio = parent.attachments.find((a) => isVoiceAttachment(a))
  if (!audio) return

  log(`retranscribe requested for message ${parent.id}`)
  const res = await fetch(audio.url).catch(() => null)
  if (!res?.ok) {
    await message.reply('⚠️ Could not fetch the original audio.').catch(() => {})
    return
  }
  const bytes = Buffer.from(await res.arrayBuffer())
  const text = await transcribeAudioBytes(bytes)
  if (text instanceof Error) {
    await message.reply(`⚠️ Re-transcription failed: ${text.message}`).catch(() => {})
    return
  }

  // Feed the transcription into the Kimaki session via its public CLI seam.
  const prompt = `Voice message transcription from Discord user:\n${text}`
  const child = spawn('kimaki', ['send', '--thread', message.channelId, '--prompt', prompt], {
    shell: false, stdio: 'ignore', detached: true,
  })
  child.on('error', () => log('kimaki send failed — is kimaki on PATH?'))
  child.unref()
  await message.react('📝').catch(() => {})
}

export async function startDiscord(token: string): Promise<void> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel],
  })

  client.on('interactionCreate', (i) => {
    if (!i.isChatInputCommand()) return
    const p = prefix()
    if (i.commandName === `${p}-setup`) return void handleSetup(i)
    if (i.commandName === `${p}-start`) return void handleLifecycle(i, 'start')
    if (i.commandName === `${p}-stop`) return void handleLifecycle(i, 'stop')
    if (i.commandName === `${p}-status`) return void handleLifecycle(i, 'status')
  })

  client.on('messageCreate', (m) => void handleRetranscribe(m))

  await client.login(token)
  const appId = client.application?.id ?? (await client.application?.fetch())?.id
  if (!appId) throw new Error('could not resolve application id')

  // CRITICAL: never bulk-PUT — that would REPLACE the guild's whole command set
  // and wipe Kimaki's commands. POST upserts one command at a time, additively.
  const rest = new REST().setToken(token)
  const registerAll = async () => {
    const commands = buildCommands()
    const guilds = await client.guilds.fetch()
    for (const [guildId] of guilds) {
      for (const cmd of commands) {
        await rest.post(Routes.applicationGuildCommands(appId, guildId), { body: cmd }).catch((e) => {
          log(`register ${cmd.name} in ${guildId} failed:`, (e as Error).message)
        })
      }
    }
    log(`/${prefix()}-* registered in ${guilds.size} guild(s)`)
  }
  await registerAll()
  // Kimaki bulk-PUTs its own set on restart, which wipes ours — re-register
  // periodically (POST is an upsert; 4 cmds × 4/day stays far under rate limits).
  setInterval(() => void registerAll(), 6 * 60 * 60 * 1000).unref()
  log(`connected as ${client.user?.tag}`)
}
