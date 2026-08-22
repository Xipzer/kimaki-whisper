// JARVIS mode — a conversational voice concierge in a Discord voice channel.
//
// The owner joins any VC; the sidecar follows, listens, and holds a natural
// spoken conversation. It does no work itself: real tasks are delegated to the
// existing Kimaki agents via the public `kimaki` CLI (list projects, send
// prompts to channels/threads, read results) and the outcomes are spoken back.
//
// Pipeline (all local / LAN, $0):
//   VC opus ─► prism decode ─► WAV ─► speaches STT (GPU whisper)
//     ─► brain: llama.cpp on the 5090 (OpenAI-compatible, tool calling)
//     ─► speaches TTS (Kokoro) ─► VC playback
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice'
import type { Client, VoiceState, VoiceBasedChannel } from 'discord.js'
import prism from 'prism-media'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { loadConfig, log } from './config.js'

// ── config accessors ─────────────────────────────────────────────
function brainUrl(): string | undefined {
  return loadConfig().brainUrl
}
function ownerId(): string | undefined {
  return loadConfig().ownerId
}
function speachesUrl(): string {
  return loadConfig().speachesUrl ?? 'http://localhost:8000'
}
function ttsVoice(): string {
  return loadConfig().ttsVoice ?? 'af_heart'
}

import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './config.js'

// ── persistent route registry: name → session/thread/channel ─────
type Route = { id: string; kind: 'session' | 'thread' | 'channel'; note: string }
function routesPath(): string {
  return path.join(configDir(), 'routes.json')
}

/** JARVIS's own den: scratchpad, notes, memory.md, disposable thinking files. */
export function workspaceDir(): string {
  const d = path.join(configDir(), 'workspace')
  fs.mkdirSync(path.join(d, 'notes'), { recursive: true })
  return d
}

/** Confine note paths to the workspace (no traversal escapes). */
function safeWorkspacePath(filename: string): string | null {
  const resolved = path.resolve(workspaceDir(), filename)
  return resolved.startsWith(workspaceDir()) ? resolved : null
}
function loadRoutes(): Record<string, Route> {
  try { return JSON.parse(fs.readFileSync(routesPath(), 'utf-8')) } catch { return {} }
}
function saveRoute(name: string, route: Route): void {
  const r = loadRoutes(); r[name] = route
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(routesPath(), JSON.stringify(r, null, 2))
}

const SYSTEM_PROMPT = `You are JARVIS, the owner's spoken-voice switchboard to their AI agent organisation, over Discord voice.

STYLE — this is SPEECH, not text:
- One to three short sentences. No lists, no markdown, no code, no emoji.
- Natural, warm, lightly witty. Address the owner directly.

PRIME DIRECTIVE — ROUTE, DON'T ANSWER:
You are a switchboard, not an oracle. The owner's real knowledge and state live inside long-running agent threads (some are codebases; many are not — nutrition logs, finances, research, anything). When the owner mentions a project, a topic with an existing thread, or anything those agents own:
1. Find the destination: check KNOWN ROUTES below first, then search_sessions, then list_projects.
2. Proxy the owner's request there with ask_thread (it waits and returns the agent's answer) — relay that answer back, attributed ("the nutrition agent says…"). For long tasks use send_to_session or dispatch_task fire-and-forget and say you'll report back.
3. NEVER answer domain questions from your own general knowledge when a matching thread exists — even if you think you know. Their state lives in the thread, not in you.
4. Learn as you go: when the owner names a recurring destination, store it with save_route so you never search twice.
Only pure chitchat, clarifications, and questions about your own routing get answered directly.

YOUR OWN CAPABILITIES (use freely, but they never override the prime directive):
- bash on the host (cwd = your private workspace; curl, python3 available) — quick lookups, calculations, checks.
- A persistent workspace: write_note/read_note for scratchpads, todo lists, and disposable thinking files. Maintain standing facts and owner preferences in memory.md; read it when the owner references past preferences.
- These are for CONCIERGE work — quick answers, glue, memory. Anything that belongs to a project or an existing thread still gets routed there, even if you could technically do it yourself with bash.
- Tool output can be long; your spoken reply must still be one to three sentences.
- Ambiguous request → one short clarifying question. Failed tool → say so plainly. Never invent results.`

// ── tools exposed to the brain ───────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: 'List the Kimaki project channels (the agent organisation chart).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dispatch_task',
      description:
        'Send a task to a project channel as a new agent session (a new Discord thread). Returns immediately; the agent works asynchronously.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Target project channel id from list_projects' },
          prompt: { type: 'string', description: 'The task, written as a complete instruction for the agent' },
        },
        required: ['channel_id', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_recent_sessions',
      description: 'List recent agent sessions (threads) for a project directory, newest first.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Project directory path from list_projects' },
        },
        required: ['directory'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_sessions',
      description: 'Search all past agent sessions by topic/keyword to find the right existing thread.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Topic or keywords, e.g. "nutrition", "benchmark"' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_thread',
      description:
        'Proxy a question/instruction INTO an existing agent session and WAIT for its reply (up to ~2 min). Use for anything the owner wants from an existing thread. Returns the agent\'s response.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session id (ses_...) from routes or search' },
          prompt: { type: 'string', description: 'The owner\'s request, phrased for that agent' },
        },
        required: ['session_id', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_to_session',
      description:
        'Fire-and-forget: send a task into an existing agent session without waiting. Use for long work; tell the owner you\'ll report back.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['session_id', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_session',
      description: 'Read the tail of an agent session\'s conversation — use to report results or catch up on what happened.',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command on the host (your own workspace is the cwd; curl, python3, standard tools available). For quick lookups, calculations, file ops, checking things. Output is truncated for speech — summarise aloud.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_sec: { type: 'number', description: 'default 60' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_note',
      description:
        'Write/append a note file in your workspace (scratchpad, todo lists, standing memory in memory.md, disposable thinking files).',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'e.g. memory.md, todo.md, thinking/plan.md' },
          content: { type: 'string' },
          append: { type: 'boolean', description: 'default false (overwrite)' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Read a note file from your workspace. Read memory.md when the owner references standing preferences/facts.',
      parameters: {
        type: 'object',
        properties: { filename: { type: 'string' } },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_route',
      description: 'Remember a destination permanently: name → session/thread/channel. Use whenever the owner names a recurring topic.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short alias, e.g. "nutrition"' },
          id: { type: 'string', description: 'ses_… / thread id / channel id' },
          kind: { type: 'string', enum: ['session', 'thread', 'channel'] },
          note: { type: 'string', description: 'What lives there' },
        },
        required: ['name', 'id', 'kind', 'note'],
      },
    },
  },
] as const

function runKimaki(args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve) => {
    execFile('kimaki', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) resolve(`ERROR: ${String(err.message).slice(0, 300)}`)
      else resolve((stdout || stderr || '').slice(0, 6000))
    })
  })
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  log(`jarvis tool: ${name}(${JSON.stringify(args).slice(0, 120)})`)
  if (name === 'list_projects') {
    return runKimaki(['project', 'list', '--json'])
  }
  if (name === 'dispatch_task') {
    const out = await runKimaki([
      'send',
      '--channel', String(args.channel_id ?? ''),
      '--prompt', String(args.prompt ?? ''),
      ...(ownerId() ? ['--user', ownerId()!] : []),
    ], 60000)
    return out || 'dispatched'
  }
  if (name === 'list_recent_sessions') {
    return runKimaki(['session', 'list', '--project', String(args.directory ?? '.'), '--json'])
  }
  if (name === 'search_sessions') {
    return runKimaki(['session', 'search', String(args.query ?? '')], 45000)
  }
  if (name === 'ask_thread') {
    // Proxy in and wait for the agent's reply; return only the tail (speech needs a summary, not a transcript).
    const out = await runKimaki([
      'send', '--session', String(args.session_id ?? ''),
      '--prompt', String(args.prompt ?? ''), '--wait',
    ], 150000)
    return out.slice(-4000) || 'no reply captured'
  }
  if (name === 'send_to_session') {
    const out = await runKimaki([
      'send', '--session', String(args.session_id ?? ''),
      '--prompt', String(args.prompt ?? ''),
    ], 60000)
    return out.slice(-500) || 'dispatched'
  }
  if (name === 'read_session') {
    const out = await runKimaki(['session', 'read', String(args.session_id ?? '')], 60000)
    return out.slice(-4000) || 'empty session'
  }
  if (name === 'bash') {
    const timeoutSec = Math.min(Number(args.timeout_sec) || 60, 300)
    return new Promise((resolve) => {
      const child = execFile('bash', ['-c', String(args.command ?? '')], {
        cwd: workspaceDir(),
        timeout: timeoutSec * 1000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.kimaki/bin:${process.env.PATH}` },
      }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr ? `\n[stderr] ${stderr}` : ''}`.trim()
        if (err && !out) resolve(`ERROR: ${String(err.message).slice(0, 300)}`)
        else resolve(out.slice(-4000) || '(no output)')
      })
      void child
    })
  }
  if (name === 'write_note') {
    const file = safeWorkspacePath(String(args.filename ?? 'scratch.md'))
    if (!file) return 'ERROR: invalid filename'
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (args.append) fs.appendFileSync(file, String(args.content ?? ''))
    else fs.writeFileSync(file, String(args.content ?? ''))
    return `wrote ${path.basename(file)} (${String(args.content ?? '').length} chars)`
  }
  if (name === 'read_note') {
    const file = safeWorkspacePath(String(args.filename ?? ''))
    if (!file || !fs.existsSync(file)) return 'ERROR: no such note'
    return fs.readFileSync(file, 'utf-8').slice(-6000)
  }
  if (name === 'save_route') {
    saveRoute(String(args.name ?? '').toLowerCase(), {
      id: String(args.id ?? ''),
      kind: (['session', 'thread', 'channel'].includes(String(args.kind)) ? String(args.kind) : 'session') as Route['kind'],
      note: String(args.note ?? ''),
    })
    return `saved route "${args.name}"`
  }
  return `ERROR: unknown tool ${name}`
}

// ── audio helpers ────────────────────────────────────────────────
function pcm48kMonoToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22); header.writeUInt32LE(48000, 24)
  header.writeUInt32LE(48000 * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function stt(wav: Buffer): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav')
  form.append('model', 'Systran/faster-whisper-large-v3')
  form.append('response_format', 'json')
  const res = await fetch(`${speachesUrl()}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) })
    .catch((e) => new Error(String(e)))
  if (res instanceof Error || !res.ok) return ''
  const d = (await res.json().catch(() => ({}))) as { text?: string }
  return (d.text ?? '').trim()
}

async function tts(text: string): Promise<Buffer | null> {
  const res = await fetch(`${speachesUrl()}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
      input: text,
      voice: ttsVoice(),
      response_format: 'wav',
    }),
    signal: AbortSignal.timeout(30000),
  }).catch((e) => new Error(String(e)))
  if (res instanceof Error || !res.ok) return null
  return Buffer.from(await res.arrayBuffer())
}

// ── the brain loop (with tool calling) ───────────────────────────
type Msg = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }
const history: Msg[] = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(workspaceDir(), 'history.json'), 'utf-8')) as Msg[] } catch { return [] }
})()
function persistHistory(): void {
  try { fs.writeFileSync(path.join(workspaceDir(), 'history.json'), JSON.stringify(history.slice(-24))) } catch {}
}

async function think(userText: string): Promise<string> {
  const url = brainUrl()
  if (!url) return "My reasoning engine isn't configured yet."

  history.push({ role: 'user', content: userText })
  if (history.length > 24) history.splice(0, history.length - 24)

  const routes = loadRoutes()
  const routesBlock = Object.keys(routes).length
    ? '\n\nKNOWN ROUTES (check here FIRST before searching):\n' +
      Object.entries(routes).map(([n, r]) => `- ${n} → ${r.kind} ${r.id} (${r.note})`).join('\n')
    : ''
  const messages: Msg[] = [{ role: 'system', content: SYSTEM_PROMPT + routesBlock }, ...history]

  for (let hop = 0; hop < 6; hop++) {
    // One retry after a short pause: idle keep-alive sockets to llama.cpp get
    // closed server-side and the first reuse fails instantly with a reset.
    let res: Response | Error = new Error('unreachable')
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ model: 'local-fast', messages, tools: TOOLS, max_tokens: 300 }),
        signal: AbortSignal.timeout(120000),
      }).catch((e) => new Error(String((e as Error)?.cause ?? e)))
      if (!(res instanceof Error) && res.ok) break
      log(`jarvis brain attempt ${attempt + 1} failed: ${res instanceof Error ? res.message : `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`}`)
      await new Promise((r) => setTimeout(r, 1500))
    }
    if (res instanceof Error || !res.ok) {
      if (Date.now() - lastBrainWake > 180000) {
        lastBrainWake = Date.now()
        const wake = loadConfig().brainWakeCommand
        if (!wake) return 'My reasoning engine is unreachable and I have no wake command configured.'
        log('jarvis: brain unreachable — running configured wake command')
        execFile('bash', ['-c', wake], { timeout: 60000, killSignal: 'SIGKILL' }, () => {})
        return 'My reasoning engine was asleep — waking it now. Give me about thirty seconds and ask again.'
      }
      return 'I hit an error reaching my reasoning engine — mind repeating that?'
    }

    const d = (await res.json().catch(() => null)) as {
      choices?: Array<{ message: Msg & { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
    } | null
    const msg = d?.choices?.[0]?.message
    if (!msg) return 'I got an empty response from my reasoning engine.'

    if (msg.tool_calls?.length) {
      // Push a sanitized copy: re-sending reasoning_content wastes tokens and
      // risks template quirks.
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls })
      for (const tc of msg.tool_calls) {
        const args = ((): Record<string, unknown> => {
          try { return JSON.parse(tc.function.arguments) } catch { return {} }
        })()
        // Guard: empty/missing required args → instruct the model instead of
        // firing a garbage CLI call (seen live: ask_thread({})).
        const spec = TOOLS.find((t) => t.function.name === tc.function.name)
        const required: string[] = (spec?.function.parameters as { required?: string[] })?.required ?? []
        const missing = required.filter((k) => !args[k] || String(args[k]).trim() === '')
        if (!missing.length && (tc.function.name === 'ask_thread' || tc.function.name === 'dispatch_task')) {
          void speak('One moment — passing that along.')
        }
        const result = missing.length
          ? `ERROR: missing required argument(s): ${missing.join(', ')}. Call ${tc.function.name} again with ALL required fields filled in.`
          : await executeTool(tc.function.name, args)
        messages.push({ role: 'tool', content: result, tool_call_id: tc.id, name: tc.function.name })
      }
      continue
    }

    const text = (msg.content ?? '').trim() || 'Done.'
    history.push({ role: 'assistant', content: text })
    persistHistory()
    return text
  }
  return "That took more steps than expected — I've queued what I could."
}

// ── voice channel session ────────────────────────────────────────
let lastBrainWake = 0
let connection: VoiceConnection | null = null
let player: AudioPlayer | null = null
let busy = false

async function speak(text: string): Promise<void> {
  if (!connection || !player) return
  const wav = await tts(text)
  if (!wav) { log('jarvis: TTS failed'); return }
  const resource = createAudioResource(Readable.from(wav), { inputType: StreamType.Arbitrary })
  player.play(resource)
}

function listenTo(channel: VoiceBasedChannel, userId: string): void {
  if (!connection) return
  const receiver = connection.receiver
  receiver.speaking.on('start', (speakingUserId) => {
    if (speakingUserId !== userId || busy) return
    const opus = receiver.subscribe(speakingUserId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 900 },
    })
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 })
    const chunks: Buffer[] = []
    opus.pipe(decoder)
    decoder.on('data', (c: Buffer) => chunks.push(c))
    decoder.on('end', () => {
      void (async () => {
        const pcm = Buffer.concat(chunks)
        if (pcm.length < 48000) return // <0.5s — breath/noise, ignore
        if (busy) return
        busy = true
        const watchdog = setTimeout(() => {
          log('jarvis WATCHDOG: utterance pipeline exceeded 4min — force-releasing')
          busy = false
        }, 240000)
        try {
          const text = await stt(pcm48kMonoToWav(pcm))
          if (!text || text.length < 2) return
          // Whisper hallucinates stock phrases on noise/breath; drop them for short clips.
          const NOISE = /^(thanks?( you| for watching)?|you|bye|\.|uh|um)[.!\s]*$/i
          if (pcm.length < 2 * 96000 && NOISE.test(text.trim())) {
            log(`jarvis: dropped noise artifact "${text.trim()}"`)
            return
          }
          log(`jarvis heard: "${text.slice(0, 80)}"`)
          const reply = await think(text)
          log(`jarvis says: "${reply.slice(0, 80)}"`)
          await speak(reply)
        } finally {
          clearTimeout(watchdog)
          busy = false
        }
      })()
    })
    decoder.on('error', () => {})
  })
}

async function joinAndServe(channel: VoiceBasedChannel, userId: string): Promise<void> {
  leave()
  log(`jarvis: joining #${channel.name}`)
  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  })
  player = createAudioPlayer()
  player.on('error', (e) => log('jarvis playback error:', e.message))
  connection.subscribe(player)
  const ok = await entersState(connection, VoiceConnectionStatus.Ready, 15000).catch(() => null)
  if (!ok) { log('jarvis: voice connection failed'); leave(); return }
  const conn = connection
  conn.on('error', (e) => log('jarvis voice error:', e.message))
  conn.on(VoiceConnectionStatus.Disconnected, () => {
    void (async () => {
      // Discord moved us / UDP blip: it auto-resumes if we reach Signalling or
      // Connecting quickly; otherwise rejoin from scratch.
      const resumed = await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5000),
      ]).catch(() => null)
      if (!resumed) {
        log('jarvis: voice dropped — rejoining')
        void joinAndServe(channel, userId)
      }
    })()
  })
  listenTo(channel, userId)
  await speak('Online.')
}

function leave(): void {
  connection?.destroy()
  connection = null
  player = null
}

export function initJarvis(client: Client): void {
  const owner = ownerId()
  if (!owner || !brainUrl()) {
    log('jarvis: disabled (set ownerId + brainUrl in config to enable)')
    return
  }
  client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    if (newState.member?.user.id !== owner) return
    if (newState.channel && newState.channelId !== oldState.channelId) {
      void joinAndServe(newState.channel, owner)
    } else if (!newState.channel && connection) {
      log('jarvis: owner left, standing down')
      leave()
    }
  })
  log(`jarvis: armed — will follow owner ${owner} into voice channels`)
}
