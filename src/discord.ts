// Second gateway connection on the SAME bot token as Kimaki. Discord allows
// multiple sessions per bot; Kimaki silently ignores slash commands it doesn't
// recognize (verified: bare `return` in its interaction handler), so the sidecar
// can own /whisper-* without any Kimaki changes.
import { execFile } from 'node:child_process'
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
import { sendPanel, handlePanelInteraction } from './panel.js'
import { wendySnapshot } from './wendy.js'
import { initWendy, wendySleep, wendyWake, wendySetDnd, wendySilence, wendyUnsilence, wendyStatus } from './wendy.js'

// Set once Discord is connected: lets any subsystem re-assert our commands.
export let reRegisterCommands: (() => Promise<void>) | null = null
function prefix(): string {
  return loadConfig().commandPrefix ?? 'whisper'
}

function buildCommands() {
  const p = prefix()
  return [
    new SlashCommandBuilder()
      .setName(`${p}-setup`)
      .setDescription('Set up local voice transcription (sidecar) - pick a model, Kimaki handles the rest')
      .addStringOption((o) =>
        o.setName('model').setDescription('Built-in local model (auto = best for this machine)').setRequired(false)
          .addChoices(
            { name: 'Auto - recommended for this machine', value: 'auto' },
            ...MODEL_TIERS.map((t) => ({ name: `${t.label} - ${t.approxSize}`, value: t.id })),
            { name: 'Off - disable sidecar transcription', value: 'off' },
          ))
      .addStringOption((o) =>
        o.setName('backend-url').setDescription('Advanced: proxy to an OpenAI-compatible /v1 backend (e.g. GPU speaches)').setRequired(false))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder().setName(`${p}-start`).setDescription('Start the sidecar transcription endpoint').setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName(`${p}-stop`).setDescription('Stop the sidecar transcription endpoint').setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName(`${p}-status`).setDescription('Sidecar transcription status').setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName('wendy-wake').setDescription('Wake Wendy - she follows you into voice again').setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName('wendy-sleep').setDescription('Put Wendy to sleep - no voice, no speaking, updates accumulate').setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName('wendy-status').setDescription('Wendy vitals: mode, brain, queues, index').setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName('wendy-dnd').setDescription('Toggle do-not-disturb for updates')
      .addBooleanOption((o) => o.setName('on').setDescription('true = no update offers').setRequired(true)).setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName('wendy-silence').setDescription('Silence Wendy for N minutes (0 lifts silence)')
      .addIntegerOption((o) => o.setName('minutes').setDescription('duration; 0 = unsilence').setRequired(true)).setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName('wendy-brain').setDescription('Control the LLM brain on the GPU host')
      .addStringOption((o) => o.setName('action').setDescription('what to do').setRequired(true)
        .addChoices({ name: 'start', value: 'start' }, { name: 'stop', value: 'stop' }, { name: 'restart', value: 'restart' })).setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName('wendy').setDescription('Wendy control panel - status, queues, agents, logs, controls').setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName('wendy-start').setDescription('Start Wendy (wake from sleep)').setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName('wendy-stop').setDescription('Stop Wendy + GPU (no voice, no replies; updates keep accumulating)')
      .addBooleanOption((o) => o.setName('force').setDescription('stop even while mid-conversation in voice').setRequired(false)).setDMPermission(false).toJSON(),
    new SlashCommandBuilder().setName('wendy-restart').setDescription('Restart the Wendy process (supervisor respawns it)').setDMPermission(false).toJSON(),
  ]
}

async function handleWendyCommand(i: ChatInputCommandInteraction): Promise<void> {
  const owner = loadConfig().ownerId
  if (owner && i.user.id !== owner) return safeReply(i, 'Wendy only answers to her owner.')
  try { await i.deferReply({ flags: MessageFlags.Ephemeral }) } catch { return }
  const name = i.commandName
  if (name === 'wendy-wake' || name === 'wendy-start') return safeReply(i, wendyWake())
  if (name === 'wendy-stop') {
    const snap = wendySnapshot()
    if (snap.inVc && !i.options.getBoolean('force')) {
      return safeReply(i, '⚠️ She is in a voice channel with you right now - stopping ends the conversation and shuts down the GPU. Run `/wendy-stop force:true` if you really mean it, or leave voice first.')
    }
    return safeReply(i, wendySleep())
  }
  if (name === 'wendy-sleep') return safeReply(i, wendySleep())
  if (name === 'wendy-status') return safeReply(i, await wendyStatus())
  if (name === 'wendy-dnd') return safeReply(i, wendySetDnd(Boolean(i.options.getBoolean('on'))))
  if (name === 'wendy-silence') {
    const m = i.options.getInteger('minutes') ?? 0
    return safeReply(i, m <= 0 ? wendyUnsilence() : wendySilence(m))
  }
  if (name === 'wendy-brain') {
    const action = i.options.getString('action')
    const wake = loadConfig().brainWakeCommand
    const stopCmd = (wake ?? '').replace(/start\s+\w+/, 'stop')
    const cmds: Record<string, string> = {
      start: wake ?? '',
      stop: stopCmd !== wake ? stopCmd : '',
      restart: wake && stopCmd !== wake ? `${stopCmd} ; sleep 3 ; ${wake}` : '',
    }
    const cmd = cmds[action ?? '']
    if (!cmd) return safeReply(i, 'No brain wake command configured.')
    execFile('bash', ['-c', cmd], { timeout: 120000, killSignal: 'SIGKILL' }, (err: Error | null, so: string, se: string) => {
      void safeReply(i, err ? `brain ${action} failed: ${String(err.message).slice(0, 150)}` : `brain ${action}: done\n${(so || se || '').trim().split('\n').slice(-2).join('\n').slice(0, 300)}`)
    })
    return
  }
  if (name === 'wendy-restart') {
    await safeReply(i, 'Restarting - back in ~20 seconds.')
    setTimeout(() => process.exit(0), 800)
    return
  }
}

async function safeReply(i: ChatInputCommandInteraction, content: string): Promise<void> {
  // Another process (a Kimaki build that implements /whisper-*) may have acked
  // first - swallow "already acknowledged" instead of crashing.
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
    return safeReply(i, `🎤 **Sidecar setup**\nRecommended for this machine: **${rec.tier.label}** (${rec.tier.approxSize}) - ${rec.reason}.\nRun \`/${prefix()}-setup model: Auto\` to configure it.`)
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
  return safeReply(i, `✅ **${tier.label}** ready - transcription runs locally, in-process.\nOne-time wiring: launch Kimaki with \`OPENAI_BASE_URL=http://127.0.0.1:${port}/v1 OPENAI_API_KEY=local\` (add to your shell profile).`)
}

async function handleLifecycle(i: ChatInputCommandInteraction, action: 'start' | 'stop' | 'status'): Promise<void> {
  const cfg = loadConfig()
  const port = cfg.port ?? DEFAULT_PORT
  if (action === 'start') {
    if (!cfg.model && !cfg.backendUrl) return safeReply(i, `⚠️ Not configured - run \`/${prefix()}-setup\` first.`)
    startServer()
    return safeReply(i, `🎤 Sidecar endpoint running at http://127.0.0.1:${port}/v1`)
  }
  if (action === 'stop') {
    stopServer()
    return safeReply(i, '🛑 Sidecar endpoint stopped (RAM freed).')
  }
  const source = cfg.backendUrl ? `backend ${cfg.backendUrl}` : cfg.model ? `built-in ${cfg.model}` : 'not configured'
  return safeReply(i, `🎤 Sidecar: **${isServerRunning() ? 'running' : 'stopped'}** on :${port} - source: ${source}`)
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

  if (retranscribeMode === 'post') {
    // Standby node: this bot IS the local Kimaki's bot, so a `kimaki send`
    // would loop the agent on itself. Post the text plainly; the owner reads
    // it, and forwards it to the agent only if he wants to.
    await message.reply(`📝 **Re-transcribed:**\n> ${text.replace(/\n/g, '\n> ')}`).catch(() => {})
    return
  }
  // Primary: feed the transcription into the Kimaki session via its CLI seam.
  const prompt = `Voice message transcription from Discord user:\n${text}`
  const child = spawn('kimaki', ['send', '--thread', message.channelId, '--prompt', prompt], {
    shell: false, stdio: 'ignore', detached: true,
  })
  child.on('error', () => log('kimaki send failed - is kimaki on PATH?'))
  child.unref()
  await message.react('📝').catch(() => {})
}

/** Gateway that ONLY answers "retranscribe" - for standby nodes running the
 *  serve-only sidecar under a different bot identity than Wendy's. No slash
 *  commands, no panel, no voice. */
let retranscribeMode: 'feed' | 'post' = 'feed'
export async function startRetranscribeOnly(token: string): Promise<void> {
  retranscribeMode = 'post'
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel],
  })
  client.on('messageCreate', (m) => void handleRetranscribe(m))
  await client.login(token)
  log(`retranscribe-only gateway connected as ${client.user?.tag}`)
}

export async function startDiscord(token: string): Promise<void> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Message, Partials.Channel],
  })

  client.on('interactionCreate', (i) => {
    if ((i.isButton() || i.isStringSelectMenu()) && i.customId.startsWith('wp:')) return void handlePanelInteraction(i)
    if (!i.isChatInputCommand()) return
    const p = prefix()
    if (i.commandName === `${p}-setup`) return void handleSetup(i)
    if (i.commandName === `${p}-start`) return void handleLifecycle(i, 'start')
    if (i.commandName === `${p}-stop`) return void handleLifecycle(i, 'stop')
    if (i.commandName === `${p}-status`) return void handleLifecycle(i, 'status')
    if (i.commandName === 'wendy') return void sendPanel(i)
    if (i.commandName.startsWith('wendy-')) return void handleWendyCommand(i)
  })

  client.on('messageCreate', (m) => {
    // Escape hatch: when a bulk-PUT has wiped our slash commands, the owner
    // cannot use /wendy to fix it. Plain text works regardless.
    if (!m.author.bot && m.content.trim().toLowerCase() === '!wendy-commands') {
      void (async () => {
        await m.react('⏳').catch(() => {})
        await registerAll()
        await m.reply('Slash commands re-registered: `/wendy`, `/wendy-wake`, `/wendy-sleep`, `/wendy-status`. Give Discord a few seconds.').catch(() => {})
      })()
      return
    }
    void handleRetranscribe(m)
  })
  initWendy(client)

  await client.login(token)
  const appId = client.application?.id ?? (await client.application?.fetch())?.id
  if (!appId) throw new Error('could not resolve application id')

  // CRITICAL: never bulk-PUT - that would REPLACE the guild's whole command set
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
  reRegisterCommands = registerAll
  // Kimaki bulk-PUTs its own set on restart, which WIPES ours (observed: all
  // four commands gone from all three guilds). A 6h re-assert left the owner
  // without /wendy for hours, so also detect the wipe every 10 minutes and
  // heal immediately - one cheap GET per guild.
  const healIfWiped = async (): Promise<void> => {
    try {
      const guilds = await client.guilds.fetch()
      for (const [guildId] of guilds) {
        const existing = (await rest.get(Routes.applicationGuildCommands(appId, guildId)).catch(() => null)) as Array<{ name: string }> | null
        if (existing && !existing.some((c) => c.name === 'wendy')) {
          log(`commands wiped in guild ${guildId} - re-registering`)
          await registerAll()
          return
        }
      }
    } catch { /* transient */ }
  }
  setInterval(() => void healIfWiped(), 10 * 60 * 1000).unref()
  setInterval(() => void registerAll(), 6 * 60 * 60 * 1000).unref()
  log(`connected as ${client.user?.tag}`)
}
