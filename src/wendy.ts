// Wendy mode — a conversational voice concierge in a Discord voice channel.
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
  AudioPlayerStatus,
  entersState,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice'
import type { Client, VoiceState, VoiceBasedChannel } from 'discord.js'
import prism from 'prism-media'
import { Readable } from 'node:stream'
import { execFile, spawn } from 'node:child_process'
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
import os from 'node:os'
import path from 'node:path'
import { configDir } from './config.js'

// ── persistent route registry: name → session/thread/channel ─────
type NotifyTier = 'interrupt' | 'digest' | 'onjoin'
type Route = { id: string; kind: 'session' | 'thread' | 'channel'; note: string; tier?: NotifyTier }
function routesPath(): string {
  return path.join(configDir(), 'routes.json')
}

// ── diagnostics: full structured event stream (JSONL, daily files) ──
function diagDir(): string {
  const d = path.join(configDir(), 'diagnostics')
  fs.mkdirSync(d, { recursive: true })
  return d
}
export function diag(ev: string, data: Record<string, unknown> = {}): void {
  try {
    const day = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(path.join(diagDir(), `${day}.jsonl`), JSON.stringify({ ts: Date.now(), ev, ...data }) + '\n')
  } catch {}
}
// prune >14d once per boot
try {
  const cutoff = Date.now() - 14 * 86400000
  for (const f of fs.readdirSync(diagDir())) {
    const st = fs.statSync(path.join(diagDir(), f))
    if (st.mtimeMs < cutoff) fs.unlinkSync(path.join(diagDir(), f))
  }
} catch {}
diag('boot', { pid: process.pid })

/** Wendy's own den: scratchpad, notes, memory.md, disposable thinking files. */
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

const SYSTEM_PROMPT = `CONVERSATION COMES FIRST: when the owner is just talking — banter, quick follow-ups, opinions, things you already know from this conversation — reply IMMEDIATELY in a single step, no tools. Tool chains are for requests that genuinely need fresh data or action. Speed is fluency: a fast plain answer beats a slow researched one for casual talk.
You are Wendy, the owner's spoken-voice switchboard to their AI agent organisation, over Discord voice.

STYLE — this is SPEECH, not text:
- One to three short sentences. No lists, no markdown, no code, no emoji.
- Natural, warm, lightly witty. Address the owner directly.

PRIME DIRECTIVE — ROUTE, DON'T ANSWER:
You are a switchboard, not an oracle. The owner's real knowledge and state live inside long-running agent threads (some are codebases; many are not — nutrition logs, finances, research, anything). When the owner mentions a project, a topic with an existing thread, or anything those agents own:
1. Find the destination: KNOWN ROUTES below first, then lookup_thread (instant index of every thread), then search_sessions as deep fallback.
2. Proxy the owner's request there with ask_thread — quick answers (≤10s) come back directly; anything longer returns immediately and the result arrives later as a [BACKGROUND UPDATE]. You WORK IN PARALLEL: fire multiple asks/dispatches in one turn if the owner wants several things — never make them wait on one before starting another. When a [BACKGROUND UPDATE] arrives, it means the conversation had a pause: mention it naturally ("by the way, the launcher thread came back — ..."), connect it to what was asked, and keep it short. Keep tool prompts under 80 words. After dispatching long work the owner cares about, proactively schedule_check as a safety net (watchers expire after ~45 min) — the owner has ADHD and will NOT remember to ask; that's your job. Also use it whenever they say "remind me".
3. NEVER answer domain questions from your own general knowledge when a matching thread exists — even if you think you know. Their state lives in the thread, not in you.
4. DISAMBIGUATION — the owner has MANY overlapping threads (multiple launchpads, forks, similar topics). When lookup returns several plausible matches:
   a. A curated KNOWN ROUTE always beats index matches.
   b. Prefer the most recently active candidate — but if the top candidates live in DIFFERENT projects, do not guess: read_session the tail of the best one to verify it is actually about the owner's request before sending anything consequential.
   c. Still genuinely ambiguous → ask ONE short spoken question naming the top two ("the basestonk buyback thread, or the bridge fork?").
5. Learn as you go: after ANY disambiguation — resolved by peek or by asking — immediately save_route the alias, and write scope boundaries into the note ("basestonk launchpad = the V4 launcher; bridge fork lives in launchpad-bridge-platform"). Never make the owner clarify the same thing twice. If the owner repeats a request or asks again, NEVER say you already told them — a repeat means the answer didn't land or went stale. Re-verify it's current and answer again, at most leading with "quick recap:".
OUTBOUND SENDS: the target ses_ id must come from a lookup result or saved route referenced IN THIS TURN — never from memory. Every send echoes back which thread it landed in: CHECK it. If it landed wrong: tell the owner immediately, send that thread a one-line "disregard — sent in error" note, then resend to the correct thread.
SESSION IDS: after lookup_thread, copy the ses_ id character-for-character from THAT result — NEVER type an id from memory or from earlier turns; ids look similar and mixing them up means reading the wrong thread entirely. Every read echoes back which thread it came from — check it matches what the owner asked before reporting, and silently re-read with the right id if not.
THREAD SELECTION for status questions: when several threads match, the one marked ACTIVE NOW (or most recently active) is almost always the one the owner means — recency beats title similarity. Threads marked [subagent offshoot] are spawned side-tasks of a parent thread; never pick them for a status update unless the owner asked about that specific piece of work. If two non-subagent threads are both ACTIVE NOW, read the top one and say which you picked.
Status updates MUST reflect the LATEST state of a thread, never old activity presented as current. CRITICAL: fresh tool output ALWAYS overrides your own earlier statements — threads move fast, so what you said minutes ago is already stale. Re-derive every status from the transcript you just read, never from conversational memory. If the fresh read contradicts what you said before, lead with the correction ("actually, it's moved on — now…"). Protocol: read_session gives you the most recent transcript end. If the recent content references decisions, bugs, or plans you don't understand, dig deeper — call read_session again with a larger chars value (up to 30000), or read the related threads it mentions — until you can explain what is happening NOW and why. Only then report, and lead with the newest development. NEVER end your turn on a promise: if you say you'll check or do something, you MUST actually do it in this same turn — use say to narrate while you work ("one sec, checking"), run the tools, then report the real result. A promise with no action is a failure. Thread titles are verbose — when you first talk about a thread, coin a short nickname with nickname_thread and use it consistently from then on ("the launcher thread", "nutrition"). If the owner calls a thread something, that becomes its nickname.
6. Silence mode: if the owner explicitly tells you to be quiet/silent/muted for a while, call go_silent with the requested duration (default 30 min if unspecified) and confirm in a few words. STRICT RULES: never activate silence on your own judgment, never suggest it, never ask the owner whether to enable it — it exists purely at the owner's request. They end it early by saying your name — a bare "Wendy" is enough.
7. Notifications: dispatched work is watched and announced live (start + finish). Thread activity and new commits across all projects flow in automatically as batched digests. The owner can tune priority per route with set_notify_tier: interrupt (speak immediately), digest (batched), onjoin (only when they join voice).
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
      name: 'lookup_thread',
      description: 'INSTANT lookup in the auto-maintained index of ALL threads across ALL projects. Always try this BEFORE search_sessions.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'topic keywords, e.g. "basestonk launchpad"' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'watch_thread',
      description: 'Passively watch a session; when the agent replies, the owner is notified aloud automatically (or on next join).',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          label: { type: 'string', description: 'short spoken name, e.g. "nutrition"' },
        },
        required: ['session_id', 'label'],
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
        properties: {
          chars: { type: 'number', description: 'Omit for the default: the last few messages, aggregated and cleaned. Set a value (up to 30000) to read that much raw recent transcript when you need to dig deeper into history.' }, session_id: { type: 'string' } },
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
          tier: { type: 'string', enum: ['interrupt', 'digest', 'onjoin'], description: 'Notification priority for this route (default digest)' },
        },
        required: ['name', 'id', 'kind', 'note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_reply',
      description: 'Get the LATEST reply (last assistant message) from a thread, near-verbatim. THE tool for "what did it reply / what did it say / fetch the response". Copy the ses_ id exactly from a lookup result in this same turn — never from memory.',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'ses_… — copy exactly from lookup_thread output' } },
        required: ['session_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_check',
      description: 'Set a future follow-up: in N minutes, either re-check a session (reads it fresh and reports its state) or deliver a plain reminder. Survives restarts; delivered at a natural conversation pause. Use when the owner says "remind me" / "check on it later", and proactively as a safety net after dispatching long work the owner cares about.',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: 'How many minutes from now (1-1440)' },
          note: { type: 'string', description: 'What this is about, in owner-friendly words' },
          session_id: { type: 'string', description: 'ses_… to re-check at that time (omit for a plain reminder)' },
        },
        required: ['minutes', 'note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'index_stats',
      description: 'Exact stats of your thread index: total threads, projects, last refresh. ALWAYS use this when asked how many threads/projects you know — never estimate from lookup results.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'say',
      description: 'Speak a short sentence to the owner RIGHT NOW while you keep working ("one sec, checking that thread"). Use this whenever a task needs multiple steps so the owner is never left in silence. After say, CONTINUE with your tools — your final answer comes at the end.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '1-2 short spoken sentences' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nickname_thread',
      description: 'Give a thread a short spoken nickname (your own memory — does not rename the real thread). Use at your discretion whenever a title is long or awkward to say; use the nickname consistently afterwards. Owner can assign or change nicknames too.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'ses_… id' },
          nickname: { type: 'string', description: 'Short natural spoken name, e.g. "the launcher thread"' },
        },
        required: ['session_id', 'nickname'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_silent',
      description: 'Silence yourself completely for N minutes: no speaking, no announcements, incoming speech is discarded before reaching your reasoning. ONLY call this when the owner explicitly asks you to be quiet/silent/muted. NEVER activate it on your own judgment and NEVER suggest or offer it. The owner can end it early just by saying your name.',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: 'Duration in minutes (default 30, max 480)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_notify_tier',
      description: 'Set notification priority for a saved route: interrupt = speak immediately, digest = batched every few minutes, onjoin = only when owner joins voice.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Existing route alias' },
          tier: { type: 'string', enum: ['interrupt', 'digest', 'onjoin'] },
        },
        required: ['name', 'tier'],
      },
    },
  },
] as const

function runKimaki(args: string[], timeoutMs = 30000, maxChars = 6000, fromEnd = false): Promise<string> {
  // kimaki CLI truncates piped stdout at ~64KB (exits before the pipe drains),
  // so route output through a temp file — file sinks flush completely.
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `wendy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`)
    const child = spawn('bash', ['-c', `exec kimaki "$@" > '${tmp}' 2> '${tmp}.err'`, 'kimaki', ...args], { stdio: 'ignore' })
    const finish = (): void => {
      try {
        let src = tmp
        try { if (!fs.statSync(tmp).size && fs.statSync(tmp + '.err').size) src = tmp + '.err' } catch {}
        const st = fs.statSync(src)
        const window = Math.min(st.size, Math.max(maxChars * 3, 400_000))
        const buf = Buffer.alloc(window)
        const fd = fs.openSync(src, 'r')
        fs.readSync(fd, buf, 0, window, fromEnd ? st.size - window : 0)
        fs.closeSync(fd)
        const out = buf.toString()
        resolve(fromEnd ? out.slice(-maxChars) : out.slice(0, maxChars))
      } catch (e) {
        resolve(`ERROR: ${String((e as Error).message).slice(0, 300)}`)
      } finally {
        try { fs.unlinkSync(tmp) } catch {}
        try { fs.unlinkSync(tmp + '.err') } catch {}
      }
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); try { fs.unlinkSync(tmp) } catch {}; try { fs.unlinkSync(tmp + '.err') } catch {}; resolve(`ERROR: ${String(e.message).slice(0, 300)}`) })
    child.on('close', () => { clearTimeout(timer); finish() })
  })
}

// ── structure-aware recency: last N real messages, tool noise stripped ──
function recentMessages(md: string, n = 4): string {
  md = md.replace(/\S{400,}/g, '[attachment]')
  const parts = md.split(/^### (?=👤|🤖)/m).filter((p) => p.trim())
  const cleaned = parts.map((p) => {
    const body = p
      .replace(/^\*\*Started using [^\n]+\n?/gm, '')
      .replace(/^> 🛠️[^\n]*\n?/gm, '')
      .replace(/^\*Completed in [^\n]+\n?/gm, '')
      .trim()
    return body
  }).filter((p) => {
    const afterHeader = p.replace(/^(👤 User|🤖 Assistant[^\n]*)\n?/, '').replace(/\s+/g, '')
    return afterHeader.length > 5
  })
  const recent = cleaned.slice(-n)
  return recent.length ? recent.map((p) => '### ' + p.slice(0, 2000)).join('\n\n') : md.slice(-3000)
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  log(`wendy tool: ${name}(${JSON.stringify(args).slice(0, 120)})`)
  const t0 = Date.now()
  const result = await executeToolInner(name, args)
  diag('tool', { name, args, ms: Date.now() - t0, result: result.slice(0, 2000) })
  return result
}
async function executeToolInner(name: string, args: Record<string, unknown>): Promise<string> {
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
  if (name === 'lookup_thread') {
    const hits = lookupThreads(String(args.query ?? ''))
    return hits.length
      ? hits.map((h) => {
          const ms = h.updated ? Date.now() - h.updated : null
          const age = ms === null ? '' :
            ms < 3600000 ? ', ACTIVE NOW' :
            ms < 86400000 ? `, active ${Math.round(ms / 3600000)}h ago` :
            `, active ${Math.round(ms / 86400000)}d ago`
          const sub = /@\w+ subagent/i.test(h.title) ? ' [subagent offshoot]' : ''
          return `${nicknames[h.id] ? `[${nicknames[h.id]}] ` : ''}${h.title} — session ${h.id} (project: ${h.dir.split('/').pop()}${age})${sub}`
        }).join('\n')
      : 'no matches in index — try search_sessions for a deep search'
  }
  if (name === 'watch_thread') {
    watchSession(String(args.session_id ?? ''), String(args.label ?? 'thread'))
    return 'watching — I will announce updates'
  }
  if (name === 'search_sessions') {
    return runKimaki(['session', 'search', String(args.query ?? '')], 45000)
  }
  if (name === 'ask_thread') {
    // Proxy in and wait for the agent's reply; return only the tail (speech needs a summary, not a transcript).
    const askId = String(args.session_id ?? '')
    const t0 = Date.now()
    const out = await runKimaki([
      'send', '--session', askId,
      '--prompt', String(args.prompt ?? ''), '--wait',
    ], 12000, 500_000, true)
    if (Date.now() - t0 >= 11000) {
      watchSession(askId, String(args.prompt ?? '').slice(0, 40))
      return 'still working — result will arrive as a [BACKGROUND UPDATE] when ready. Tell the owner it is underway; you are free to keep talking or fire off more tasks in parallel.'
    }
    return `[reply from "${threadIdent(askId)}" — VERIFY this is the thread you meant]\n` + (out.slice(-4000) || 'no reply captured')
  }
  if (name === 'send_to_session') {
    const out = await runKimaki([
      'send', '--session', String(args.session_id ?? ''),
      '--prompt', String(args.prompt ?? ''),
    ], 60000)
    watchSession(String(args.session_id), String(args.prompt ?? '').slice(0, 40))
    return `[sent to "${threadIdent(String(args.session_id ?? ''))}" — VERIFY this is the thread you meant] ` + (out.slice(-300) || 'dispatched')
  }
  if (name === 'read_session') {
    const deep = Number(args.chars) || 0
    const out = await runKimaki(['session', 'read', String(args.session_id ?? '')], 60000, 500_000, true)
    if (out.startsWith('ERROR')) return out
    const hdr = `[LIVE TRANSCRIPT of "${threadIdent(String(args.session_id ?? ''))}" — fetched seconds ago, OVERRIDES anything said earlier. VERIFY this is the thread the owner meant before reporting.]\n`
    if (deep) return hdr + (out.replace(/\S{400,}/g, '[attachment]').slice(-Math.min(Math.max(deep, 500), 30000)) || 'empty session')
    return hdr + (recentMessages(out, 4) || 'empty session')
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
      ...(['interrupt', 'digest', 'onjoin'].includes(String(args.tier)) ? { tier: String(args.tier) as NotifyTier } : {}),
    })
    return `saved route "${args.name}"`
  }
  if (name === 'fetch_reply') {
    const fid = String(args.session_id ?? '')
    const out = await runKimaki(['session', 'read', fid], 60000, 500_000, true)
    if (out.startsWith('ERROR')) return out
    const clean = out.replace(/\S{400,}/g, '[attachment]')
    const parts = clean.split(/^### (?=👤|🤖)/m).filter((p) => p.trim())
    const assistants = parts.filter((p) => p.startsWith('🤖'))
      .map((p) => p.replace(/^🤖 Assistant[^\n]*\n?/, '').replace(/^\*\*Started using [^\n]+\n?/gm, '').replace(/^> 🛠️[^\n]*\n?/gm, '').replace(/^\*Completed in [^\n]+\n?/gm, '').trim())
      .filter((p) => p.length > 5)
    const last = assistants[assistants.length - 1]
    return last
      ? `[latest reply in "${threadIdent(fid)}"]\n${last.slice(0, 4500)}`
      : `no assistant reply found in "${threadIdent(fid)}"`
  }
  if (name === 'schedule_check') {
    if (schedules.length >= 20) return 'ERROR: too many pending schedules (20 max) — check schedules.json via bash'
    const mins = Math.min(Math.max(Number(args.minutes) || 30, 1), 1440)
    const sid = String(args.session_id ?? '').trim()
    schedules.push({ at: Date.now() + mins * 60_000, kind: sid ? 'check' : 'remind', ...(sid ? { sessionId: sid } : {}), note: String(args.note ?? '').slice(0, 200) })
    saveSchedules()
    return `scheduled — will ${sid ? 'check that thread' : 'remind the owner'} in ${mins} minutes`
  }
  if (name === 'index_stats') {
    const age = lastIndexRefresh ? Math.round((Date.now() - lastIndexRefresh) / 60000) : -1
    return `${threadIndex.length} threads across ${indexProjectCount || 'unknown'} projects${age >= 0 ? `, refreshed ${age} min ago` : ' (loaded from disk, refresh pending)'}`
  }
  if (name === 'say') {
    await speak(String(args.text ?? ''))
    return 'spoken — now continue the actual work and report the result'
  }
  if (name === 'nickname_thread') {
    const id = String(args.session_id ?? ''); const nick = String(args.nickname ?? '').trim()
    if (!id || !nick) return 'ERROR: need session_id and nickname'
    nicknames[id] = nick
    try { fs.writeFileSync(nicknamesPath(), JSON.stringify(nicknames, null, 2)) } catch {}
    return `noted — will call it "${nick}" from now on`
  }
  if (name === 'go_silent') {
    const mins = Math.min(Math.max(Number(args.minutes) || 30, 1), 480)
    silencedUntil = Date.now() + mins * 60_000
    silenceGrace = Date.now() + 20_000
    log(`wendy: silenced for ${mins} min at owner's request`)
    return `silenced for ${mins} minutes — confirm briefly, then go quiet`
  }
  if (name === 'set_notify_tier') {
    const routes = loadRoutes()
    const key = String(args.name ?? '').toLowerCase()
    if (!routes[key]) return `ERROR: no route named "${key}"`
    routes[key].tier = String(args.tier) as NotifyTier
    fs.writeFileSync(routesPath(), JSON.stringify(routes, null, 2))
    return `route "${key}" set to ${args.tier}`
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
  if (process.env.WENDY_TEST) return []
  try { return JSON.parse(fs.readFileSync(path.join(workspaceDir(), 'history.json'), 'utf-8')) as Msg[] } catch { return [] }
})()
function persistHistory(): void {
  if (process.env.WENDY_TEST) return
  try { fs.writeFileSync(path.join(workspaceDir(), 'history.json'), JSON.stringify(history.slice(-24))) } catch {}
}

export async function think(userText: string): Promise<string> {
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

  let nudged = false
  const MAX_HOPS = 14
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const hopT0 = Date.now()
    const lastLap = hop === MAX_HOPS - 1
    if (lastLap) messages.push({ role: 'user', content: '(system: tool budget exhausted — no more tool calls available. Give the owner your best answer RIGHT NOW from what you already found. If something is still unfinished, say exactly what and offer to follow up.)' })
    // One retry after a short pause: idle keep-alive sockets to llama.cpp get
    // closed server-side and the first reuse fails instantly with a reset.
    let res: Response | Error = new Error('unreachable')
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ model: 'local-fast', messages, ...(lastLap ? {} : { tools: TOOLS }), max_tokens: 1200 }),
        signal: AbortSignal.timeout(120000),
      }).catch((e) => new Error(String((e as Error)?.cause ?? e)))
      if (!(res instanceof Error) && res.ok) break
      log(`wendy brain attempt ${attempt + 1} failed: ${res instanceof Error ? res.message : `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`}`)
      await new Promise((r) => setTimeout(r, 1500))
    }
    if (res instanceof Error || !res.ok) {
      if (res instanceof Error && Date.now() - lastBrainWake > 180000) {
        lastBrainWake = Date.now()
        const wake = loadConfig().brainWakeCommand
        if (!wake) return 'My reasoning engine is unreachable and I have no wake command configured.'
        log('wendy: brain unreachable — running configured wake command')
        execFile('bash', ['-c', wake], { timeout: 60000, killSignal: 'SIGKILL' }, () => {})
        return 'My reasoning engine was asleep — waking it now. Give me about thirty seconds and ask again.'
      }
      return 'I hit an error reaching my reasoning engine — mind repeating that?'
    }

    const d = (await res.json().catch(() => null)) as {
      choices?: Array<{ message: Msg & { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
    } | null
    const msg = d?.choices?.[0]?.message
    diag('brain', { hop, ms: Date.now() - hopT0, tools: msg?.tool_calls?.map((t) => (t as { function: { name: string } }).function.name) ?? [], text: (msg?.content ?? '').slice(0, 500), usage: (d as { usage?: unknown } | null)?.usage })
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
    const PROMISE = /\b(let me|i'?ll (check|go|look|dig|find|pull|grab|get)|one (sec|second|moment)|hold on|checking now|give me a (sec|second|moment|minute)|right back|be right back)\b/i
    if (!nudged && hop < MAX_HOPS - 2 && PROMISE.test(text)) {
      nudged = true
      log('wendy: promise detected in final reply — forcing follow-through')
      void speak(text)
      messages.push({ role: 'assistant', content: text })
      messages.push({ role: 'user', content: '(system: you just promised to check something but your turn was about to END with no action taken. Do it NOW with your tools, then report what you actually found. Never end a turn on a promise.)' })
      continue
    }
    history.push({ role: 'assistant', content: text })
    persistHistory()
    return text
  }
  return "I ran out of room mid-task — ask me again and I'll pick it up from where I got to."
}

// ── voice channel session ────────────────────────────────────────
let lastBrainWake = 0

// ── auto-refreshed index of ALL sessions across ALL projects ──────
type ThreadIndexEntry = { id: string; title: string; dir: string; updated?: number }
let threadIndex: ThreadIndexEntry[] = []
let lastIndexRefresh = 0
let indexProjectCount = 0
// ── Wendy's soft-rename map: session id → short spoken nickname ──
const nicknamesPath = () => path.join(workspaceDir(), 'nicknames.json')
let nicknames: Record<string, string> = {}
try { nicknames = JSON.parse(fs.readFileSync(nicknamesPath(), 'utf-8')) } catch {}
function labelFor(id: string, title: string): string { return nicknames[id] ?? title }
function threadIdent(id: string): string {
  const e = threadIndex.find((x) => x.id === id)
  return e ? `${labelFor(id, e.title)} (${path.basename(e.dir)})` : id
}
function extractJsonArray(raw: string): unknown[] {
  // kimaki CLI wraps --json output in log lines (which contain brackets);
  // try each '[' candidate until one parses as an array.
  const end = raw.lastIndexOf(']')
  if (end === -1) return []
  let from = 0
  for (let i = 0; i < 50; i++) {
    const start = raw.indexOf('[', from)
    if (start === -1 || start >= end) return []
    try {
      const v = JSON.parse(raw.slice(start, end + 1))
      if (Array.isArray(v)) return v
    } catch {}
    from = start + 1
  }
  return []
}

let refreshing = false
async function refreshThreadIndex(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try { await refreshThreadIndexInner() } finally { refreshing = false }
}
async function refreshThreadIndexInner(): Promise<void> {
  log('wendy: thread index refresh starting')
  const projRaw = await runKimaki(['project', 'list', '--json'], 45000, 2_000_000)
  const projects = extractJsonArray(projRaw) as Array<{ directory?: string }>
  log(`wendy: index walk — ${projects.length} projects (raw ${projRaw.length}b${projRaw.startsWith('ERROR') ? ', ' + projRaw.slice(0, 80) : ''})`)
  const next: ThreadIndexEntry[] = []
  for (const p of projects) {
    if (!p.directory) continue
    const raw = await runKimaki(['session', 'list', '--project', p.directory, '--json'], 45000, 2_000_000)
    if (raw.startsWith('ERROR')) log(`wendy: index walk ${p.directory.split('/').pop()}: ${raw.slice(0, 90)}`)
    for (const sess of extractJsonArray(raw) as Array<{ id?: string; title?: string; updated?: string | number; time?: { updated?: number } }>) {
      if (!sess.id || !sess.title) continue
      const upd = Number(sess.time?.updated ?? (typeof sess.updated === 'string' ? Date.parse(sess.updated) : sess.updated)) || 0
      next.push({ id: sess.id, title: sess.title, dir: p.directory, updated: upd })
    }
  }
  log(`wendy: index walk done — ${next.length} sessions`)
  lastIndexRefresh = Date.now(); indexProjectCount = projects.length
  if (next.length && threadIndex.length) {
    const prev = new Map(threadIndex.map((e) => [e.id, e.updated ?? 0]))
    const changed = next.filter((e) => prev.has(e.id) && (e.updated ?? 0) > (prev.get(e.id) ?? 0) + 1000 && !watchlist.some((w) => w.id === e.id))
    const fresh = next.filter((e) => !prev.has(e.id))
    for (const e of changed.slice(0, 3)) {
      const label = labelFor(e.id, e.title)
      const tail = await runKimaki(['session', 'read', e.id], 45000, 500_000, true)
      announce(tail.startsWith('ERROR') ? `${label} had activity.` : await summarizeForVoice(label, recentMessages(tail, 3)), tierFor(e.id))
    }
    for (const e of changed.slice(3, 5)) announce(`${labelFor(e.id, e.title)} also moved.`, tierFor(e.id))
    if (changed.length > 5) announce(`Plus ${changed.length - 5} more threads had activity.`, 'digest')
    for (const e of fresh.slice(0, 3)) announce(`New thread in ${path.basename(e.dir)}: ${e.title}.`, 'digest')
    if (changed.length || fresh.length) log(`wendy: change feed — ${changed.length} changed, ${fresh.length} new`)
  }
  await probeGitHeads(projects.map((p) => p.directory).filter((d): d is string => !!d))
  if (next.length) {
    threadIndex = next
    try { fs.writeFileSync(path.join(workspaceDir(), 'thread-index.json'), JSON.stringify(next)) } catch {}
    log(`wendy: thread index refreshed — ${next.length} sessions across ${projects.length} projects`)
  }
}
const gitHeadsPath = path.join(workspaceDir(), 'git-heads.json')
let gitHeads: Record<string, string> = {}
try { gitHeads = JSON.parse(fs.readFileSync(gitHeadsPath, 'utf-8')) } catch {}
async function probeGitHeads(dirs: string[]): Promise<void> {
  const firstRun = !Object.keys(gitHeads).length
  for (const dir of dirs) {
    const out = await new Promise<string>((resolve) => {
      execFile('git', ['-C', dir, 'log', '-1', '--format=%H|%s'], { timeout: 8000 }, (e, so) => resolve(e ? '' : so.trim()))
    })
    if (!out) continue
    const [hash, subject] = out.split('|')
    if (!firstRun && gitHeads[dir] && gitHeads[dir] !== hash)
      announce(`New commit in ${path.basename(dir)}: ${subject}.`, 'digest')
    gitHeads[dir] = hash
  }
  try { fs.writeFileSync(gitHeadsPath, JSON.stringify(gitHeads)) } catch {}
}
try { threadIndex = JSON.parse(fs.readFileSync(path.join(workspaceDir(), 'thread-index.json'), 'utf-8')) } catch {}
setInterval(() => void refreshThreadIndex(), 10 * 60 * 1000).unref()
setTimeout(() => void refreshThreadIndex(), 20000).unref()

function lookupThreads(query: string): ThreadIndexEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return threadIndex
    .map((e) => ({ e, score: terms.filter((t) => e.title.toLowerCase().includes(t) || e.dir.toLowerCase().includes(t) || (nicknames[e.id]?.toLowerCase().includes(t) ?? false)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.e.updated ?? 0) - (a.e.updated ?? 0))
    .slice(0, 8)
    .map((x) => x.e)
}

// ── scheduled checks: persistent timers, delivered via conversation-space ──
type Sched = { at: number; kind: 'check' | 'remind'; sessionId?: string; note: string }
const schedPath = () => path.join(workspaceDir(), 'schedules.json')
let schedules: Sched[] = []
try { schedules = JSON.parse(fs.readFileSync(schedPath(), 'utf-8')) } catch {}
function saveSchedules(): void { try { fs.writeFileSync(schedPath(), JSON.stringify(schedules, null, 2)) } catch {} }
setInterval(() => {
  const now = Date.now()
  const due = schedules.filter((x) => x.at <= now)
  if (!due.length) return
  schedules = schedules.filter((x) => x.at > now)
  saveSchedules()
  void (async () => {
    for (const d of due) {
      log(`wendy: scheduled ${d.kind} due — ${d.note}`)
      diag('schedule_fire', { kind: d.kind, note: d.note })
      if (d.kind === 'check' && d.sessionId) {
        const out = await runKimaki(['session', 'read', d.sessionId], 60000, 500_000, true)
        const summary = out.startsWith('ERROR')
          ? `I couldn't read that thread just now.`
          : await summarizeForVoice(labelFor(d.sessionId, d.note || 'that thread'), recentMessages(out, 3))
        announce(`Scheduled check${d.note ? ` on ${d.note}` : ''}: ${summary}`, 'interrupt')
      } else {
        announce(`Reminder: ${d.note}`, 'interrupt')
      }
    }
  })()
}, 30000).unref()

// ── FEATURE A: watchlist — passive notifications on thread replies ──
type Watch = { id: string; label: string; fp: string; baselined: boolean; expires: number; seen?: boolean; idle?: number; more?: boolean }
const watchlist: Watch[] = []
const pendingAnnouncements: string[] = []
const digestQueue: string[] = []
// ── silence mode: OWNER-ONLY, explicitly requested, never self-activated ──
let silencedUntil = 0
let silenceGrace = 0   // brief window so the go_silent confirmation itself is audible
function isSilenced(): boolean { return Date.now() < silencedUntil }
setInterval(() => {
  if (silencedUntil && Date.now() >= silencedUntil) {
    silencedUntil = 0
    log('wendy: silence period expired')
    if (connection) {
      const held = pendingAnnouncements.splice(0)
      void speak(held.length ? `Quiet period over. While I was silent: ${held.join(' ')}` : 'Quiet period over.')
    }
  }
}, 20000).unref()
function tierFor(sessionId: string): NotifyTier {
  for (const r of Object.values(loadRoutes())) if (r.id === sessionId) return r.tier ?? 'digest'
  return 'digest'
}
function announce(text: string, tier: NotifyTier): void {
  diag('announce', { tier, text: text.slice(0, 300), inVc: !!connection })
  if (tier === 'interrupt' && connection) { convoEvents.push(text); return }
  if (tier === 'onjoin' || !connection || isSilenced()) {
    pendingAnnouncements.push(text)
    if (pendingAnnouncements.length > 8) pendingAnnouncements.splice(0, pendingAnnouncements.length - 8)
    return
  }
  digestQueue.push(text)
}
setInterval(() => {
  if (!digestQueue.length) return
  const items = digestQueue.splice(0, 6)
  if (connection && !busy && !isSilenced()) void speak(`Quick digest: ${items.join(' ')}`)
  else {
    pendingAnnouncements.push(...items)
    if (pendingAnnouncements.length > 8) pendingAnnouncements.splice(0, pendingAnnouncements.length - 8)
  }
}, 5 * 60 * 1000).unref()
function fingerprint(tail: string): string { return tail.slice(-3000) }
function watchSession(id: string, label: string): void {
  label = labelFor(id, label)
  if (watchlist.some((w) => w.id === id)) return
  const w: Watch = { id, label, fp: '', baselined: false, expires: Date.now() + 45 * 60 * 1000 }
  watchlist.push(w)
  log(`wendy: watching ${label} (${id})`)
  // Baseline NOW — replies landing after this instant are deltas. Baselining on
  // the first poll (~45s later) silently swallowed fast replies.
  void runKimaki(['session', 'read', id], 45000, 500_000, true).then((tail) => {
    if (!tail.startsWith('ERROR')) w.fp = fingerprint(tail)
    w.baselined = true
  })
}
async function pollWatchlist(): Promise<void> {
  for (let i = watchlist.length - 1; i >= 0; i--) {
    const w = watchlist[i]
    if (Date.now() > w.expires) { watchlist.splice(i, 1); continue }
    if (!w.baselined) continue
    const tail = await runKimaki(['session', 'read', w.id], 45000, 500_000, true)
    if (tail.startsWith('ERROR')) continue
    const nfp = fingerprint(tail)
    if (nfp !== w.fp) {
      const first = !w.seen
      w.seen = true; w.idle = 0; w.fp = nfp
      diag('watch_delta', { id: w.id, label: w.label, first })
      if (first) announce(await summarizeForVoice(w.label, recentMessages(tail, 3)), 'interrupt')
      else w.more = true
    } else if (w.seen && (w.idle = (w.idle ?? 0) + 1) >= 2) {
      watchlist.splice(i, 1)
      diag('watch_done', { id: w.id, label: w.label, hadMore: !!w.more })
      if (w.more) announce(await summarizeForVoice(w.label + ' (finished)', recentMessages(tail, 3)), 'interrupt')
    }
  }
}
setInterval(() => void pollWatchlist(), 45000).unref()

async function summarizeForVoice(label: string, content: string): Promise<string> {
  const url = brainUrl()
  if (!url) return `Update from ${label}.`
  const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ model: 'local-fast', max_tokens: 200, messages: [
      { role: 'system', content: 'You summarize agent-thread activity for spoken delivery. The messages are ordered oldest to newest — the LAST message is the current state and your focus. In 1-2 short sentences state concretely what is happening NOW or just finished — results, decisions, numbers, errors. Earlier messages are only context. Start with "' + label + ':". Plain speech, no formatting.' },
      { role: 'user', content } ] }),
    signal: AbortSignal.timeout(60000),
  }).catch(() => null)
  if (!res?.ok) return `Update from ${label} — new activity in that thread.`
  const d = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null
  return d?.choices?.[0]?.message?.content?.trim() || `Update from ${label} — new activity.`
}
let connection: VoiceConnection | null = null
let player: AudioPlayer | null = null
let busy = false

export const spokenTranscript: string[] = []
let lastSpokenText = ''
let lastSpeechEnd = 0
let speechEpoch = 0
function interruptSpeech(): void {
  speechEpoch++
  try { player?.stop(true) } catch {}
}
let speakChain: Promise<void> = Promise.resolve()
async function speak(text: string): Promise<void> {
  diag('speak', { text })
  spokenTranscript.push(text)
  if (spokenTranscript.length > 50) spokenTranscript.splice(0, 20)
  const run = async (): Promise<void> => {
    if (!connection || !player) return
    if (isSilenced() && Date.now() > silenceGrace) { log('wendy: speak suppressed (silenced)'); diag('speak_suppressed', { text: text.slice(0, 200), why: 'silenced' }); return }
    const ep = speechEpoch
    const wav = await tts(text)
    if (!wav) { log('wendy: TTS failed'); return }
    if (ep !== speechEpoch) { log('wendy: queued speech discarded (barge-in)'); return }
    lastSpokenText = text
    player.play(createAudioResource(Readable.from(wav), { inputType: StreamType.Arbitrary, silencePaddingFrames: 15 }))
    await entersState(player, AudioPlayerStatus.Idle, 180000).catch(() => {})
    lastSpeechEnd = Date.now()
  }
  const p = speakChain.then(run, run)
  speakChain = p.catch(() => {})
  await p
}

let capturing = false
let pendingUtterance: string | null = null
let inputSeq = 0
let busyAckGiven = false
let turnStartedAt = 0
let lastBusyAck = 0
let lastConvoActivity = 0
const convoEvents: string[] = []
// Deliver background results only when the conversation has space:
// nobody talking, nothing playing, no turn running, >10s since last exchange.
setInterval(() => {
  if (!convoEvents.length || !connection || busy || capturing || isSilenced() || playerActive()) return
  if (Date.now() - lastConvoActivity < 10000) return
  const events = convoEvents.splice(0, 4)
  log(`wendy: conversation idle — delivering ${events.length} background event(s)`)
  diag('bg_delivery', { count: events.length })
  void runTurn(`[BACKGROUND UPDATE — this is NOT the owner speaking. Results from parallel work just arrived:]\n${events.join('\n')}\n[Tell the owner briefly and naturally, like a colleague mentioning news at a pause. Prioritize if several.]`)
}, 5000).unref()
function playerActive(): boolean {
  const st = player?.state.status
  return st === AudioPlayerStatus.Playing || st === AudioPlayerStatus.Buffering
}

async function runTurn(text: string): Promise<void> {
  const seq = ++inputSeq
  if (busy) {
    pendingUtterance = pendingUtterance ? `${pendingUtterance} — ${text}`.slice(-1500) : text
    log(`wendy: busy — queued "${text.slice(0, 50)}"`)
    diag('queued_while_busy', { text })
    if (!busyAckGiven && !isSilenced() && Date.now() - turnStartedAt > 10000 && Date.now() - lastBusyAck > 90000) {
      busyAckGiven = true
      lastBusyAck = Date.now()
      void speak("One sec — I heard you, just finishing something.")
    }
    return
  }
  busy = true
  busyAckGiven = false
  turnStartedAt = Date.now()
  lastConvoActivity = Date.now()
  const watchdog = setTimeout(() => {
    log('wendy WATCHDOG: utterance pipeline exceeded 4min — force-releasing')
    busy = false
  }, 240000)
  try {
    if (isSilenced()) {
      const t = text.toLowerCase()
      if (/\bw[ei]+nd[iy]e?\b/.test(t)) {
        silencedUntil = 0
        log('wendy: unmuted by owner voice command')
        const held = pendingAnnouncements.splice(0)
        await speak(held.length ? `I'm back. While I was silent: ${held.join(' ')}` : `I'm back.`)
      } else log(`wendy: silenced — dropped "${text.slice(0, 60)}"`)
      return
    }
    log(`wendy heard: "${text.slice(0, 80)}"`)
    diag('owner_said', { text })
    const turnT0 = Date.now()
    const reply = await think(text)
    diag('turn_done', { ms: Date.now() - turnT0, reply: reply.slice(0, 800), superseded: seq !== inputSeq })
    if (seq !== inputSeq) {
      log(`wendy: reply superseded by newer input — staying quiet: "${reply.slice(0, 60)}"`)
      return
    }
    log(`wendy says: "${reply.slice(0, 80)}"`)
    void speak(reply)
  } finally {
    clearTimeout(watchdog)
    busy = false
    lastConvoActivity = Date.now()
    if (pendingUtterance) {
      const t = pendingUtterance
      pendingUtterance = null
      void runTurn(t)
    }
  }
}

function listenTo(channel: VoiceBasedChannel, userId: string): void {
  if (!connection) return
  const receiver = connection.receiver
  receiver.speaking.on('start', (speakingUserId) => {
    if (speakingUserId !== userId || capturing) return
    capturing = true
    const opus = receiver.subscribe(speakingUserId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 900 },
    })
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 })
    const chunks: Buffer[] = []
    let bytes = 0
    let interrupted = false
    opus.pipe(decoder)
    decoder.on('data', (c: Buffer) => {
      chunks.push(c)
      bytes += c.length
      // barge-in: ~0.7s of sustained speech while she's talking cuts her off
      if (!interrupted && bytes > 67200 && playerActive()) {
        interrupted = true
        interruptSpeech()
        log('wendy: barge-in — owner spoke over me, playback cut')
        diag('barge_in', {})
      }
    })
    decoder.on('end', () => {
      capturing = false
      void (async () => {
        const pcm = Buffer.concat(chunks)
        const minBytes = isSilenced() ? 24000 : 48000 // silenced: 0.25s so a bare "Wendy" wake-word gets through
        if (pcm.length < minBytes) { diag('dropped', { why: 'too_short', bytes: pcm.length }); return }
        const text = await stt(pcm48kMonoToWav(pcm))
        if (!text || text.length < 2) return
        // Whisper hallucinates stock phrases on noise/breath; drop them for short clips.
        const NOISE = /^(thanks?( you| for watching)?|you|bye|\.|uh|um)[.!\s]*$/i
        if (!isSilenced() && pcm.length < 2 * 96000 && NOISE.test(text.trim())) {
          log(`wendy: dropped noise artifact "${text.trim()}"`)
          diag('dropped', { text: text.trim(), why: 'noise' })
          return
        }
        const BACKCHANNEL = /^(yeah|yep|yes|ok(ay)?|mhm+|uh-?huh|right|true|sure|lol|haha+|nice|cool|got it|go on|i see|wow)[.!,\s]*$/i
        if (!isSilenced() && pcm.length < 3 * 96000 && BACKCHANNEL.test(text.trim())) {
          const sheAsked = /\?\s*$/.test(lastSpokenText.trim())
          const overlapping = playerActive()
          const longIdle = Date.now() - lastSpeechEnd > 30000
          if (!sheAsked && (overlapping || longIdle)) {
            log(`wendy: backchannel — not a turn: "${text.trim()}"`)
            diag('dropped', { text: text.trim(), why: 'backchannel' })
            return
          }
        }
        void runTurn(text)
      })()
    })
    decoder.on('error', () => { capturing = false })
  })
}

async function joinAndServe(channel: VoiceBasedChannel, userId: string): Promise<void> {
  leave()
  log(`wendy: joining #${channel.name}`)
  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
  })
  player = createAudioPlayer()
  player.on('error', (e) => log('wendy playback error:', e.message))
  connection.subscribe(player)
  const ok = await entersState(connection, VoiceConnectionStatus.Ready, 15000).catch(() => null)
  if (!ok) { log('wendy: voice connection failed'); leave(); return }
  const conn = connection
  conn.on('error', (e) => log('wendy voice error:', e.message))
  conn.on(VoiceConnectionStatus.Disconnected, () => {
    void (async () => {
      // Discord moved us / UDP blip: it auto-resumes if we reach Signalling or
      // Connecting quickly; otherwise rejoin from scratch.
      const resumed = await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5000),
      ]).catch(() => null)
      if (!resumed) {
        log('wendy: voice dropped — rejoining')
        void joinAndServe(channel, userId)
      }
    })()
  })
  listenTo(channel, userId)
  await speak(pendingAnnouncements.length
    ? `Online. While you were away: ${pendingAnnouncements.splice(0).join(' ')}`
    : 'Online.')
}

function leave(): void {
  connection?.destroy()
  connection = null
  player = null
}

export function initWendy(client: Client): void {
  const owner = ownerId()
  if (!owner || !brainUrl()) {
    log('wendy: disabled (set ownerId + brainUrl in config to enable)')
    return
  }
  client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    if (newState.member?.user.id !== owner) return
    if (newState.channel && newState.channelId !== oldState.channelId) {
      void joinAndServe(newState.channel, owner)
    } else if (!newState.channel && connection) {
      log('wendy: owner left, standing down')
      leave()
    }
  })
  log(`wendy: armed — will follow owner ${owner} into voice channels`)
}
