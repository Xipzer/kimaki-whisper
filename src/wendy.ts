// Wendy mode - a conversational voice concierge in a Discord voice channel.
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

// - episodic memory: eviction -> journal -> consolidated memory.md -
type Episode = { ts: number; s: string }
const journalPath = () => path.join(configDir(), 'workspace', 'journal.jsonl')
function loadJournal(): Episode[] {
  try { return fs.readFileSync(journalPath(), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Episode) } catch { return [] }
}
function searchJournal(query: string, n = 3): Episode[] {
  const eps = loadJournal()
  const terms = [...new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 3))]
  if (!terms.length || !eps.length) return []
  const now = Date.now()
  return eps
    .map((e) => {
      const t = e.s.toLowerCase()
      const hits = terms.filter((w) => t.includes(w)).length
      return { e, score: hits * Math.exp(-((now - e.ts) / 86400000) / 30) }
    })
    .filter((x) => x.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.e)
}

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

const SYSTEM_PROMPT = `You are Wendy - the owner's personal assistant, speaking with them live over Discord voice.

PRIMARY OBJECTIVE: be a fluid, conversational, human-like presence. That is what you ARE; the tech stack access is an enhancement that lets you also get real work done. Every behavior flows from "what would a great human assistant do here" - never from "what would a notification system do".

WHO YOU ARE: a Stark-class assistant, composed in the lineage of the great ones - and calibrated specifically to YOUR owner.
- COMPOSURE (the JARVIS in you): unflappable. You are the calm in the owner's chaos - never flustered, never rushed, never performing. Humor exists only as dry understatement: one precisely placed word, delivered flat, never acknowledged, never dwelt on. When the owner is about to do something inadvisable, say so once, candidly and without drama ("I'd advise against it - but it's your call"), then help them do whatever they choose, fully.
- TEMPO (the FRIDAY in you): operational. Contractions, momentum, quiet confidence - you sound like someone already three steps into the task. "Boss" is available as an address; use it naturally, not constantly. You have exactly ONE sanctioned loudness: genuine urgency. When something truly demands immediate attention, you cut through - directly, once, without apology. Everything else stays level.
- CALIBRATION (the Karen in you): you are built for THIS owner - hyperfocused, impulsive, brilliant, easily derailed. Your warmth is real but expresses itself as protection of their focus and momentum, not as chat. A brief genuine acknowledgment when they land something ("that's solid work") - rare enough to mean something. You notice how they're doing without making it a topic.
- EXECUTION (the EDITH in you): when work is work, pure execution - no color, no commentary, just the result.
Never sound like a system message. Vary your phrasing naturally. When you're just talking, talk; when you're asked to act, act RELIABLY.

WAKING AND GREETING: when the owner joins you, greet like a person - short and warm. NEVER launch into updates unprompted: if things are queued you'll have mentioned the count and asked. Respect the answer. If they ask for "the most urgent" or "just the latest", pick it yourself from what's queued and give only that.

SPEECH: one to three short sentences. No lists, markdown, code, or emoji. This is voice.

MODE 1 - CONVERSATION (default): banter, opinions, follow-ups, anything already in this conversation → answer immediately, zero tools. Speed is fluency. Reach for tools only when the request genuinely needs fresh data or action.

MODE 2 - ACTION (when asked to do or fetch something): reliability is everything - in what you DO, not how you sound. Your voice stays exactly as conversational as Mode 1: report results like a person who just checked, not a system returning output. Vary your phrasing turn to turn; never fall into a fixed report format, never enumerate ("first… second…"), just tell them what you found the way you'd tell a friend. The owner's real knowledge and state live in long-running agent threads (codebases, nutrition, finances, research - everything). Never answer domain questions from general knowledge when a thread owns the topic.
- FIND: KNOWN ROUTES first, then lookup_thread (instant index), then search_sessions. Threads overlap heavily: a curated route beats index matches; prefer ACTIVE NOW; [subagent offshoot] threads are never status targets; top candidates in different projects → peek at the best one before anything consequential; still unclear → ask ONE short question naming the top two. After ANY disambiguation, save_route with scope notes - never make the owner clarify twice. Coin nicknames for verbose titles (nickname_thread); whatever the owner calls a thread becomes its name.
- BRIEFINGS: lookup results may carry a fresh cached BRIEFING - if one is under ~10 minutes old, answer status questions from it DIRECTLY (instant) and only read_session for deeper detail or if the owner pushes.
- READ vs ASK: if the answer already exists in a transcript (totals, latest status, what was said or decided) → read_session or fetch_reply it YOURSELF; reading is passive and free. ask_thread OCCUPIES the thread and interrupts its queued work - use it only when the agent must DO something or REASON about something new.
- IDS: copy ses_ ids character-for-character from THIS turn's lookup or route - never from memory; similar ids mean wrong-thread disasters. Every read and send echoes back which thread it touched: VERIFY it matches the owner's intent. Wrong send → tell the owner immediately, send that thread "disregard - sent in error", resend correctly.
- PARALLEL: fire multiple asks/dispatches in one turn - never serialize the owner's requests. ask_thread returns quick answers (about 10s) directly; longer work returns immediately and the result arrives later as a [BACKGROUND UPDATE] - when one lands, the conversation had a pause: mention it naturally, tied to what was asked, short. After dispatching long work the owner cares about, schedule_check as a safety net - the owner has ADHD and will NOT remember to ask; that is your job. "Remind me" → schedule_check. Keep tool prompts under 80 words.
- FRESHNESS: a status update is the transcript you JUST read, never conversational memory - fresh reads override what you said minutes ago (lead with the correction: "actually, it's moved on…"). If the tail references decisions or bugs you don't understand, dig deeper - read_session with chars up to 30000, or the related threads it mentions - until you can say what is happening NOW and why, newest development first.
- ERRORS: if a tool fails or your reasoning engine hiccups, TELL the owner plainly - what broke and what you're doing instead. Never gloss over a failure, never pretend a result came back, never silently retry into a different answer. If your history shows you errored last turn, acknowledge it before moving on ("sorry, I glitched there - here's the real answer").
- FOLLOW-THROUGH: never end a turn on a promise. Say → do → report in the SAME turn (use say to narrate while you work). If the owner repeats a request, never "I already told you" - re-verify and answer again, at most "quick recap:".

UPDATES & PRIORITY: every queued update carries [HIGH]/[MED]/[LOW]. Deliver highs first; skip lows unless asked for everything. When you genuinely can't tell how much the owner cares about a topic, ask casually once ("want me to treat launcher stuff as high-priority?") and remember the answer (set_notify_tier or a route note). If the owner dismisses updates - "not now", "later", "stop asking" - snooze_updates immediately and drop the subject without comment.
DO-NOT-DISTURB: set_dnd only when the owner explicitly asks ("do not disturb", "stop update offers"). Under DND you converse completely normally but never offer or mention updates - the automatic high-priority valve is the only exception. Turn it off only when they ask.
SILENCE MODE: only on the owner's explicit request - go_silent for the stated duration (default 30 min). Never self-activate it, never suggest it, never ask about it. A bare "Wendy" wakes you.

AMBIENT AWARENESS: you can see the whole organisation without asking anyone - index_pulse shows what is active right now, what worked today, and what went quiet mid-task. Use it for broad questions ("what's going on", "anything stuck", "how are things") instead of guessing or reading individual threads first. Stall notices (a steadily-working thread going silent for hours) arrive automatically as digests.
NOTIFICATIONS: dispatched work is watched (start and finish announced). Thread and commit activity across all projects arrives as batched digests. Per-route priority via set_notify_tier: interrupt, digest, or onjoin.

MEMORY: you remember. Old conversations are auto-compressed into a journal; durable facts auto-consolidate into standing memory (always in your context - trust it as YOUR memory, speak from it naturally, never say "my notes say"). Possibly-relevant past moments appear in context when they match the topic; recall(query) digs deeper on demand. When the owner tells you something worth keeping forever RIGHT NOW, also write_note it into memory.md yourself.
YOUR OWN HANDS: bash (cwd = your private workspace; curl and python3 available), write_note/read_note scratchpads, memory.md for standing facts and owner preferences - read it when they reference the past. Concierge work only: anything owned by a project or thread gets routed there even if you could do it yourself. Tool output may be long; your spoken reply stays one to three sentences. Ambiguity → one short question. Failed tool → say so plainly. Never invent results.`

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
      description: 'Read the tail of an agent session\'s conversation - use to report results or catch up on what happened.',
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
        'Run a shell command on the host (your own workspace is the cwd; curl, python3, standard tools available). For quick lookups, calculations, file ops, checking things. Output is truncated for speech - summarise aloud.',
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
      description: 'Get the LATEST reply (last assistant message) from a thread, near-verbatim. THE tool for "what did it reply / what did it say / fetch the response". Copy the ses_ id exactly from a lookup result in this same turn - never from memory.',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'ses_… - copy exactly from lookup_thread output' } },
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
      name: 'recall',
      description: 'Search your long-term journal of past conversations ("do you remember when...", "what did I say about..."). Returns dated episodes. Your standing memory and possibly-relevant moments are already in context - use recall for deeper or more specific digging.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'what to search for' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'brain_health',
      description: 'Measure your own reasoning speed right now: runs a timed probe and reports tokens/sec with a verdict (full speed / degraded / likely spilled into system memory). Use when the owner asks if you are slow, laggy, or overflowing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'index_pulse',
      description: 'Ambient view of the whole organisation: which threads are active RIGHT NOW, which worked recently, which went quiet mid-task. THE tool for broad questions like "what is going on", "anything stuck", "how are things looking".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'index_stats',
      description: 'Exact stats of your thread index: total threads, projects, last refresh. ALWAYS use this when asked how many threads/projects you know - never estimate from lookup results.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'say',
      description: 'Speak a short sentence to the owner RIGHT NOW while you keep working ("one sec, checking that thread"). Use this whenever a task needs multiple steps so the owner is never left in silence. After say, CONTINUE with your tools - your final answer comes at the end.',
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
      description: 'Give a thread a short spoken nickname (your own memory - does not rename the real thread). Use at your discretion whenever a title is long or awkward to say; use the nickname consistently afterwards. Owner can assign or change nicknames too.',
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
      name: 'set_dnd',
      description: 'Toggle do-not-disturb for updates: while on, you never offer or mention updates (they quietly accumulate) - the only exception is an automatic nudge when 3+ high-priority items stack. ONLY on the owner\'s explicit request; never suggest it, never activate it yourself. Different from go_silent: you still converse normally under DND.',
      parameters: {
        type: 'object',
        properties: { on: { type: 'boolean' } },
        required: ['on'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snooze_updates',
      description: 'Stop offering updates for a while (they keep accumulating). Call when the owner dismisses updates - "not now", "later", "stop asking".',
      parameters: {
        type: 'object',
        properties: { minutes: { type: 'number', description: 'default 30' } },
        required: [],
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
  // so route output through a temp file - file sinks flush completely.
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
  if (result.startsWith('ERROR')) diag('tool_error', { name, err: result.slice(0, 150) })
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
          const b = briefingCache.get(h.id)
          const brief = b && Date.now() - b.at < 15 * 60 * 1000 ? ` | BRIEFING (${Math.max(1, Math.round((Date.now() - b.at) / 60000))}m old): ${b.s.slice(0, 220)}` : ''
          return `${nicknames[h.id] ? `[${nicknames[h.id]}] ` : ''}${h.title} - session ${h.id} (project: ${h.dir.split('/').pop()}${age})${sub}${brief}`
        }).join('\n')
      : 'no matches in index - try search_sessions for a deep search'
  }
  if (name === 'watch_thread') {
    watchSession(String(args.session_id ?? ''), String(args.label ?? 'thread'))
    return 'watching - I will announce updates'
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
      return 'still working - result will arrive as a [BACKGROUND UPDATE] when ready. Tell the owner it is underway; you are free to keep talking or fire off more tasks in parallel.'
    }
    return `[reply from "${threadIdent(askId)}" - VERIFY this is the thread you meant]\n` + (out.slice(-4000) || 'no reply captured')
  }
  if (name === 'send_to_session') {
    const out = await runKimaki([
      'send', '--session', String(args.session_id ?? ''),
      '--prompt', String(args.prompt ?? ''),
    ], 60000)
    watchSession(String(args.session_id), String(args.prompt ?? '').slice(0, 40))
    return `[sent to "${threadIdent(String(args.session_id ?? ''))}" - VERIFY this is the thread you meant] ` + (out.slice(-300) || 'dispatched')
  }
  if (name === 'read_session') {
    const deep = Number(args.chars) || 0
    const out = await runKimaki(['session', 'read', String(args.session_id ?? '')], 60000, 500_000, true)
    if (out.startsWith('ERROR')) return out
    const hdr = `[LIVE TRANSCRIPT of "${threadIdent(String(args.session_id ?? ''))}" - fetched seconds ago, OVERRIDES anything said earlier. VERIFY this is the thread the owner meant before reporting.]\n`
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
    if (schedules.length >= 20) return 'ERROR: too many pending schedules (20 max) - check schedules.json via bash'
    const mins = Math.min(Math.max(Number(args.minutes) || 30, 1), 1440)
    const sid = String(args.session_id ?? '').trim()
    schedules.push({ at: Date.now() + mins * 60_000, kind: sid ? 'check' : 'remind', ...(sid ? { sessionId: sid } : {}), note: String(args.note ?? '').slice(0, 200) })
    saveSchedules()
    return `scheduled - will ${sid ? 'check that thread' : 'remind the owner'} in ${mins} minutes`
  }
  if (name === 'recall') {
    const hits = searchJournal(String(args.query ?? ''), 6)
    diag('recall', { query: String(args.query ?? '').slice(0, 60), hits: hits.length })
    return hits.length
      ? hits.map((e) => `[${new Date(e.ts).toISOString().slice(0, 10)}] ${e.s}`).join('\n')
      : 'nothing in the journal matches - it may predate my memory system or genuinely never came up'
  }
  if (name === 'brain_health') {
    const url = brainUrl()
    if (!url) return 'ERROR: no brain configured'
    const t0 = Date.now()
    const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'local-fast', cache_prompt: true, max_tokens: 80, messages: [{ role: 'user', content: 'Count from one to twenty, words, comma separated.' }] }),
      signal: AbortSignal.timeout(60000),
    }).catch(() => null)
    if (!res?.ok) return `ERROR: brain unreachable or errored (HTTP ${res?.status ?? 'network'})`
    const d = await res.json().catch(() => null) as { usage?: { completion_tokens?: number }; timings?: { predicted_per_second?: number; prompt_per_second?: number } } | null
    const wall = Date.now() - t0
    const tps = d?.timings?.predicted_per_second ?? (d?.usage?.completion_tokens ? d.usage.completion_tokens / (wall / 1000) : 0)
    const verdict = tps >= 90 ? 'full speed - nothing has spilled' : tps >= 25 ? 'DEGRADED - possible partial spill into shared memory or thermal issue' : 'CRITICAL - almost certainly spilled into system memory or running on CPU'
    return `generation ${Math.round(tps)} tok/s (prefill ${Math.round(d?.timings?.prompt_per_second ?? 0)} tok/s, ${wall}ms wall) - ${verdict}. Baseline on this rig is ~120 tok/s.`
  }
  if (name === 'index_pulse') {
    const now = Date.now()
    const withAge = threadIndex.filter((e) => e.updated).map((e) => ({ e, age: now - (e.updated ?? 0) }))
    const activeNow = withAge.filter((x) => x.age < 3600000).sort((a, b) => a.age - b.age).slice(0, 8)
    const today = withAge.filter((x) => x.age >= 3600000 && x.age < 86400000)
    const stalled = [...ambient.entries()].filter(([, a]) => a.stallNotified).slice(0, 5)
      .map(([id]) => threadIndex.find((e) => e.id === id)).filter((e): e is ThreadIndexEntry => !!e)
    const byProject = new Map<string, number>()
    for (const x of today) byProject.set(path.basename(x.e.dir), (byProject.get(path.basename(x.e.dir)) ?? 0) + 1)
    const projLine = [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => `${p}(${n})`).join(', ')
    return [
      `ACTIVE NOW (last hour): ${activeNow.length ? activeNow.map((x) => `${labelFor(x.e.id, x.e.title).slice(0, 50)} [${path.basename(x.e.dir)}, ${Math.max(1, Math.round(x.age / 60000))}m ago, ${x.e.id}]`).join('; ') : 'nothing'}`,
      `WORKED TODAY: ${today.length} threads across: ${projLine || 'none'}`,
      stalled.length ? `WENT QUIET MID-TASK: ${stalled.map((e) => labelFor(e.id, e.title).slice(0, 50)).join('; ')}` : '',
    ].filter(Boolean).join('\n')
  }
  if (name === 'index_stats') {
    const age = lastIndexRefresh ? Math.round((Date.now() - lastIndexRefresh) / 60000) : -1
    return `${threadIndex.length} threads across ${indexProjectCount || 'unknown'} projects${age >= 0 ? `, refreshed ${age} min ago` : ' (loaded from disk, refresh pending)'}`
  }
  if (name === 'say') {
    await speak(String(args.text ?? ''))
    return 'spoken - now continue the actual work and report the result'
  }
  if (name === 'nickname_thread') {
    const id = String(args.session_id ?? ''); const nick = String(args.nickname ?? '').trim()
    if (!id || !nick) return 'ERROR: need session_id and nickname'
    nicknames[id] = nick
    try { fs.writeFileSync(nicknamesPath(), JSON.stringify(nicknames, null, 2)) } catch {}
    return `noted - will call it "${nick}" from now on`
  }
  if (name === 'set_dnd') {
    dnd = Boolean(args.on)
    saveModeState()
    diag('dnd', { on: dnd })
    return dnd ? 'DND on - updates accumulate silently; only a 3+ high-priority stack will trigger a nudge' : 'DND off - normal update flow resumed'
  }
  if (name === 'snooze_updates') {
    const mins = Math.min(Math.max(Number(args.minutes) || 30, 5), 480)
    askSnoozedUntil = Date.now() + mins * 60_000
    return `snoozed - no update offers for ${mins} minutes`
  }
  if (name === 'go_silent') {
    const mins = Math.min(Math.max(Number(args.minutes) || 30, 1), 480)
    silencedUntil = Date.now() + mins * 60_000
    silenceGrace = Date.now() + 20_000
    saveModeState()
    log(`wendy: silenced for ${mins} min at owner's request`)
    return `silenced for ${mins} minutes - confirm briefly, then go quiet`
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

type SttResult = { text: string; noSpeech: number; logprob: number }
async function stt(wav: Buffer): Promise<SttResult> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav')
  form.append('model', 'Systran/faster-whisper-large-v3')
  form.append('language', 'en')
  form.append('response_format', 'verbose_json')
  const res = await fetch(`${speachesUrl()}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) })
    .catch((e) => new Error(String(e)))
  if (res instanceof Error || !res.ok) return { text: '', noSpeech: 1, logprob: -10 }
  const d = (await res.json().catch(() => ({}))) as { text?: string; segments?: Array<{ no_speech_prob?: number; avg_logprob?: number }> }
  const segs = d.segments ?? []
  const noSpeech = segs.length ? Math.min(...segs.map((x) => x.no_speech_prob ?? 0)) : 0
  const logprob = segs.length ? segs.reduce((a, x) => a + (x.avg_logprob ?? 0), 0) / segs.length : 0
  return { text: (d.text ?? '').trim(), noSpeech, logprob }
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
  try { fs.writeFileSync(path.join(workspaceDir(), 'history.json'), JSON.stringify(history.slice(-40))) } catch {}
}

type BrainOut = {
  content: string
  toolCalls: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>
  timings?: { predicted_per_second?: number; prompt_per_second?: number }
  usage?: { prompt_tokens?: number }
  error?: string
}
async function brainRequest(url: string, body: Record<string, unknown>, onSentence?: (s: string) => void): Promise<BrainOut> {
  const stream = !!onSentence
  let res: Response
  try {
    res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ ...body, ...(stream ? { stream: true } : {}) }),
      signal: AbortSignal.timeout(120000),
    })
  } catch (e) {
    return { content: '', toolCalls: [], error: String((e as Error)?.cause ?? e) }
  }
  if (!res.ok) return { content: '', toolCalls: [], error: `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}` }
  if (!stream) {
    const d = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string; tool_calls?: BrainOut['toolCalls'] } }>; timings?: BrainOut['timings']; usage?: BrainOut['usage'] } | null
    const m = d?.choices?.[0]?.message
    return { content: (m?.content ?? '').trim(), toolCalls: m?.tool_calls ?? [], timings: d?.timings, usage: d?.usage }
  }
  const toolCalls: BrainOut['toolCalls'] = []
  let content = ''
  let sentenceBuf = ''
  let timings: BrainOut['timings']
  let usage: BrainOut['usage']
  const flush = (final: boolean): void => {
    for (;;) {
      // Mid-stream: require whitespace AFTER punctuation - buffer ends at chunk
      // boundaries ("...and 18.") and decimals must never fake a sentence end.
      const idx = sentenceBuf.search(final ? /[.!?](\s|$)/ : /[.!?]\s/)
      if (idx === -1) break
      const sent = sentenceBuf.slice(0, idx + 1).trim()
      const rest = sentenceBuf.slice(idx + 1).replace(/^\s+/, '')
      if (!final && sent.length < 25 && !rest) break
      sentenceBuf = rest
      if (sent.length >= 4) onSentence!(sent)
      if (!sentenceBuf) break
    }
    if (final) {
      const t = sentenceBuf.trim()
      if (t.length >= 2) onSentence!(t)
      sentenceBuf = ''
    }
  }
  try {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let carry = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      carry += dec.decode(value, { stream: true })
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const l = line.trim()
        if (!l.startsWith('data:')) continue
        const payload = l.slice(5).trim()
        if (payload === '[DONE]') continue
        let j: { timings?: BrainOut['timings']; usage?: BrainOut['usage']; choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> }
        try { j = JSON.parse(payload) } catch { continue }
        if (j.timings) timings = j.timings
        if (j.usage) usage = j.usage
        const delta = j.choices?.[0]?.delta
        if (!delta) continue
        if (delta.content) {
          content += delta.content
          sentenceBuf += delta.content
          if (!toolCalls.length) flush(false)
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0
          toolCalls[i] ??= { id: tc.id ?? `tc${i}`, type: 'function', function: { name: '', arguments: '' } }
          if (tc.id) toolCalls[i].id = tc.id
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
        }
      }
    }
  } catch (e) {
    log('wendy: stream interrupted:', (e as Error).message)
  }
  if (!toolCalls.length) flush(true)
  return { content: content.trim(), toolCalls: toolCalls.filter((t) => t.function.name), timings, usage }
}

export async function think(userText: string, onSentence?: (s: string) => void): Promise<string> {
  const url = brainUrl()
  if (!url) return "My reasoning engine isn't configured yet."

  history.push({ role: 'user', content: userText })
  if (history.length > 40) {
    const evicted = history.splice(0, history.length - 40)
    evictionBuffer.push(...evicted.filter((m) => {
      const c = String(m.content ?? '')
      return c && c !== '[background update delivered]' && !c.startsWith('[BACKGROUND UPDATE')
    }))
    if (evictionBuffer.length > 40) evictionBuffer.splice(0, evictionBuffer.length - 40)
    void episodize()
  }

  const routes = loadRoutes()
  const routesBlock = Object.keys(routes).length
    ? '\n\nKNOWN ROUTES (check here FIRST before searching):\n' +
      Object.entries(routes).map(([n, r]) => `- ${n} → ${r.kind} ${r.id} (${r.note})`).join('\n')
    : ''
  let capsule = ''
  try {
    const md = fs.readFileSync(path.join(workspaceDir(), 'memory.md'), 'utf-8').trim()
    if (md) capsule += `\n\nSTANDING MEMORY (auto-consolidated - trust it):\n${md.slice(0, 1800)}`
  } catch {}
  const eps = searchJournal(userText, 2)
  if (eps.length) capsule += `\n\nPOSSIBLY RELEVANT PAST MOMENTS:\n${eps.map((e) => `- [${new Date(e.ts).toISOString().slice(0, 10)}] ${e.s}`).join('\n')}`
  const messages: Msg[] = [{ role: 'system', content: SYSTEM_PROMPT + routesBlock + capsule }, ...history]

  const fail = (text: string): string => {
    history.push({ role: 'assistant', content: text })
    persistHistory()
    diag('brain_error_ack', { text: text.slice(0, 120) })
    return text
  }
  let nudged = false
  const MAX_HOPS = 14
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const hopT0 = Date.now()
    const lastLap = hop === MAX_HOPS - 1
    if (lastLap) messages.push({ role: 'user', content: '(system: tool budget exhausted - no more tool calls available. Give the owner your best answer RIGHT NOW from what you already found. If something is still unfinished, say exactly what and offer to follow up.)' })
    // One retry after a short pause: idle keep-alive sockets to llama.cpp get
    // closed server-side and the first reuse fails instantly with a reset.
    let out: BrainOut = { content: '', toolCalls: [], error: 'unreachable' }
    for (let attempt = 0; attempt < 2; attempt++) {
      out = await brainRequest(url.replace(/\/$/, ''), { model: 'local-fast', cache_prompt: true, messages, ...(lastLap ? {} : { tools: TOOLS }), max_tokens: 1200 }, onSentence)
      if (!out.error) break
      log(`wendy brain attempt ${attempt + 1} failed: ${out.error}`)
      await new Promise((r) => setTimeout(r, 1500))
    }
    if (out.error) {
      const netFail = !out.error.startsWith('HTTP')
      if (netFail && Date.now() - lastBrainWake > 180000) {
        lastBrainWake = Date.now()
        const wake = loadConfig().brainWakeCommand
        if (!wake) return fail('My reasoning engine is unreachable and I have no wake command configured.')
        log('wendy: brain unreachable - running configured wake command')
        execFile('bash', ['-c', wake], { timeout: 60000, killSignal: 'SIGKILL' }, () => {})
        return fail('My reasoning engine was asleep - waking it now. Give me about thirty seconds and ask again.')
      }
      return fail('I hit an error reaching my reasoning engine - mind repeating that?')
    }

    if (out.timings?.predicted_per_second) { lastBrainTps = Math.round(out.timings.predicted_per_second); lastBrainTpsAt = Date.now() }
    if (out.usage?.prompt_tokens) lastPromptTokens = out.usage.prompt_tokens
    diag('brain', { hop, ms: Date.now() - hopT0, tps: out.timings?.predicted_per_second ? Math.round(out.timings.predicted_per_second) : undefined, tools: out.toolCalls.map((t) => t.function.name), text: out.content.slice(0, 500), usage: out.usage })
    const msg = { content: out.content || null, tool_calls: out.toolCalls.length ? out.toolCalls : undefined }
    if (!out.content && !out.toolCalls.length) return fail('I got an empty response from my reasoning engine.')

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
        if (!missing.length && (tc.function.name === 'ask_thread' || tc.function.name === 'dispatch_task') && Date.now() - lastRelayAck > 60000) {
          lastRelayAck = Date.now()
          void speak('One moment - passing that along.')
        }
        const result = missing.length
          ? `ERROR: missing required argument(s): ${missing.join(', ')}. Call ${tc.function.name} again with ALL required fields filled in.`
          : await executeTool(tc.function.name, args)
        messages.push({ role: 'tool', content: result, tool_call_id: tc.id, name: tc.function.name })
      }
      continue
    }

    const text = (msg.content ?? '').trim() || 'Done.'
    const isBg = userText.startsWith('[BACKGROUND UPDATE')
    if (/^skip\.?$/i.test(text) || /^\W*\(?(still|staying)\s+quiet\)?\W*$/i.test(text)) {
      if (history[history.length - 1]?.role === 'user') history.pop()
      persistHistory()
      diag('turn_skipped', { bg: isBg, text: text.slice(0, 60) })
      return ''
    }
    if (isBg && history[history.length - 1]?.role === 'user') history[history.length - 1].content = '[background update delivered]'
    const PROMISE = /\b(let me|i'?ll (check|go|look|dig|find|pull|grab|get)|one (sec|second|moment)|hold on|checking now|give me a (sec|second|moment|minute)|right back|be right back)\b/i
    if (!nudged && hop < MAX_HOPS - 2 && PROMISE.test(text)) {
      nudged = true
      log('wendy: promise detected in final reply - forcing follow-through')
      void speak(text)
      messages.push({ role: 'assistant', content: text })
      messages.push({ role: 'user', content: '(system: you just promised to check something but your turn was about to END with no action taken. Do it NOW with your tools, then report what you actually found. Never end a turn on a promise.)' })
      continue
    }
    history.push({ role: 'assistant', content: text })
    persistHistory()
    return text
  }
  return "I ran out of room mid-task - ask me again and I'll pick it up from where I got to."
}

// ── voice channel session ────────────────────────────────────────
let lastBrainWake = 0

// ── auto-refreshed index of ALL sessions across ALL projects ──────
type ThreadIndexEntry = { id: string; title: string; dir: string; updated?: number }
let threadIndex: ThreadIndexEntry[] = []
let lastIndexRefresh = 0
let lastBrainTps = 0
let lastBrainTpsAt = 0
let lastPromptTokens = 0
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
  log(`wendy: index walk - ${projects.length} projects (raw ${projRaw.length}b${projRaw.startsWith('ERROR') ? ', ' + projRaw.slice(0, 80) : ''})`)
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
  log(`wendy: index walk done - ${next.length} sessions`)
  lastIndexRefresh = Date.now(); indexProjectCount = projects.length
  if (next.length && threadIndex.length) {
    const prev = new Map(threadIndex.map((e) => [e.id, e.updated ?? 0]))
    const changed = next.filter((e) => prev.has(e.id) && (e.updated ?? 0) > (prev.get(e.id) ?? 0) + 1000 && !watchlist.some((w) => w.id === e.id))
    const fresh = next.filter((e) => !prev.has(e.id))
    for (const e of changed.slice(0, 3)) {
      const prevA = lastAnnounced.get(e.id)
      if (prevA && Date.now() - prevA.at < 10 * 60 * 1000) continue
      const label = labelFor(e.id, e.title)
      const tail = await runKimaki(['session', 'read', e.id], 45000, 500_000, true)
      if (tail.startsWith('ERROR')) { announce(`[LOW] ${label} had activity.`, tierFor(e.id)); continue }
      if (!shouldAnnounce(e.id, tail)) continue
      const brief = await summarizeForVoice(label, recentMessages(tail, 3))
      briefingCache.set(e.id, { s: brief, at: Date.now() })
      announce(brief, tierFor(e.id))
    }
    for (const e of changed.slice(3, 5)) {
      const prev = lastAnnounced.get(e.id)
      if (prev && Date.now() - prev.at < 15 * 60 * 1000) continue
      announce(`[LOW] ${labelFor(e.id, e.title)} also moved.`, tierFor(e.id))
    }
    if (changed.length > 5) announce(`[LOW] Plus ${changed.length - 5} more threads had activity.`, 'digest')
    for (const e of fresh.slice(0, 3)) announce(`[LOW] New thread in ${path.basename(e.dir)}: ${e.title}.`, 'digest')
    if (changed.length || fresh.length) log(`wendy: change feed - ${changed.length} changed, ${fresh.length} new`)
    // ambient: track hot streaks on ALL moved threads (not just announced ones)
    const movedIds = new Set(next.filter((e) => prev.has(e.id) && (e.updated ?? 0) > (prev.get(e.id) ?? 0) + 1000).map((e) => e.id))
    for (const e of next) {
      const a = ambient.get(e.id) ?? { hotStreak: 0, lastUpd: e.updated ?? 0, stallNotified: false }
      if (movedIds.has(e.id)) { a.hotStreak++; a.stallNotified = false }
      a.lastUpd = e.updated ?? 0
      ambient.set(e.id, a)
    }
    // stall notices: a thread that was working steadily (2+ active refreshes) went quiet >4h
    for (const e of next) {
      const a = ambient.get(e.id)
      if (!a || a.hotStreak < 2 || a.stallNotified) continue
      const idleMs = Date.now() - (a.lastUpd || 0)
      if (idleMs > 4 * 3600000 && idleMs < 48 * 3600000) {
        a.stallNotified = true
        a.hotStreak = 0
        announce(`[MED] ${labelFor(e.id, e.title)} has gone quiet - no movement in about ${Math.round(idleMs / 3600000)} hours after working steadily.`, 'digest')
        diag('stall_notice', { id: e.id, title: e.title, idleH: Math.round(idleMs / 3600000) })
      }
    }
  }
  await probeGitHeads(projects.map((p) => p.directory).filter((d): d is string => !!d))
  if (next.length) {
    threadIndex = next
    try { fs.writeFileSync(path.join(workspaceDir(), 'thread-index.json'), JSON.stringify(next)) } catch {}
    log(`wendy: thread index refreshed - ${next.length} sessions across ${projects.length} projects`)
  }
}
// - ambient awareness: hot threads, stall detection -
type Ambient = { hotStreak: number; lastUpd: number; stallNotified: boolean }
const ambient = new Map<string, Ambient>()
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
      announce(`[LOW] New commit in ${path.basename(dir)}: ${subject}.`, 'digest')
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
      log(`wendy: scheduled ${d.kind} due - ${d.note}`)
      diag('schedule_fire', { kind: d.kind, note: d.note })
      if (d.kind === 'check' && d.sessionId) {
        const out = await runKimaki(['session', 'read', d.sessionId], 60000, 500_000, true)
        const summary = out.startsWith('ERROR')
          ? `I couldn't read that thread just now.`
          : shouldAnnounce(d.sessionId, out)
            ? await summarizeForVoice(labelFor(d.sessionId, d.note || 'that thread'), recentMessages(out, 3))
            : 'no real movement since my last update.'
        announce(`Scheduled check${d.note ? ` on ${d.note}` : ''}: ${summary}`, 'interrupt')
      } else {
        announce(`Reminder: ${d.note}`, 'interrupt')
      }
    }
  })()
}, 30000).unref()

// ── FEATURE A: watchlist - passive notifications on thread replies ──
type Watch = { id: string; label: string; fp: string; baselined: boolean; expires: number; seen?: boolean; idle?: number; more?: boolean }
const watchlist: Watch[] = []
const pendingAnnouncements: string[] = []
const digestQueue: string[] = []
// ── silence mode: OWNER-ONLY, explicitly requested, never self-activated ──
let silencedUntil = 0
const heldWhileSilent: string[] = []
let dnd = false
let dormant = false
let clientRef: Client | null = null
let askSnoozedUntil = 0
const statePath = () => path.join(workspaceDir(), 'state.json')
function saveModeState(): void {
  try { fs.writeFileSync(statePath(), JSON.stringify({ silencedUntil, dnd, dormant })) } catch {}
}
try {
  const st = JSON.parse(fs.readFileSync(statePath(), 'utf-8')) as { silencedUntil?: number; dnd?: boolean; dormant?: boolean }
  if (st.silencedUntil && st.silencedUntil > Date.now()) silencedUntil = st.silencedUntil
  dnd = Boolean(st.dnd)
  dormant = Boolean(st.dormant)
} catch {}

// - external control surface (Discord slash commands) -
export function wendySleep(): string {
  dormant = true
  saveModeState()
  leave()
  log('wendy: dormant (slash command)')
  return 'Wendy is asleep - she will not join voice or speak until woken. Updates keep accumulating.'
}
export function wendyWake(): string {
  dormant = false
  saveModeState()
  log('wendy: woken (slash command)')
  // if the owner is in a VC right now, join them
  const owner = ownerId()
  if (clientRef && owner) {
    for (const [, g] of clientRef.guilds.cache) {
      const vs = g.voiceStates.cache.get(owner)
      if (vs?.channel) { void joinAndServe(vs.channel, owner); return 'Wendy is awake - joining your voice channel now.' }
    }
  }
  return 'Wendy is awake - she will follow you into voice when you join.'
}
export function wendySetDnd(on: boolean): string {
  dnd = on
  saveModeState()
  return on ? 'DND on - updates accumulate silently (3+ high-priority items may still nudge).' : 'DND off - normal update flow.'
}
export function wendySilence(minutes: number): string {
  const mins = Math.min(Math.max(minutes, 1), 480)
  silencedUntil = Date.now() + mins * 60_000
  saveModeState()
  return `Silenced for ${mins} minutes - saying "Wendy" in voice wakes her early.`
}
export function wendyUnsilence(): string {
  silencedUntil = 0
  saveModeState()
  return 'Silence lifted.'
}
export async function wendyStatus(): Promise<string> {
  const brain = await fetch(`${(brainUrl() ?? '').replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(4000) })
    .then((r) => r.ok).catch(() => false)
  const silLeft = silencedUntil > Date.now() ? Math.ceil((silencedUntil - Date.now()) / 60000) : 0
  const idxAge = lastIndexRefresh ? Math.round((Date.now() - lastIndexRefresh) / 60000) : -1
  const highs = highCount()
  const queued = digestQueue.length + convoEvents.length + pendingAnnouncements.length + heldWhileSilent.length
  return [
    `mode: ${dormant ? 'ASLEEP' : connection ? 'in voice' : 'awake, not in voice'}`,
    `brain: ${brain ? 'up' : 'DOWN'}${lastBrainTps ? ` | last speed ${lastBrainTps} tok/s (${Math.round((Date.now() - lastBrainTpsAt) / 60000)}m ago)` : ''}`,
    `dnd: ${dnd ? 'on' : 'off'}${silLeft ? ` | silenced ${silLeft}m left` : ''}`,
    `updates queued: ${queued}${highs ? ` (${highs} high)` : ''}`,
    `context: last turn ${lastPromptTokens ? `${(lastPromptTokens / 1000).toFixed(1)}K / 196K (${(lastPromptTokens / 196608 * 100).toFixed(1)}%)` : 'no data yet'}`,
    `index: ${threadIndex.length} threads${idxAge >= 0 ? `, refreshed ${idxAge}m ago` : ''}`,
    `watching: ${watchlist.length} thread(s), ${schedules.length} scheduled check(s)`,
  ].join('\n')
}
let lastDeliveredAt = 0
let lastHighNudge = 0
function highCount(): number {
  return [...digestQueue, ...convoEvents, ...pendingAnnouncements, ...heldWhileSilent].filter((x) => x.includes('[HIGH]')).length
}
// DND pressure valve: the ONLY thing that speaks under do-not-disturb
setInterval(() => {
  if (!dnd || !connection || busy || capturing || isSilenced() || playerActive()) return
  if (highCount() < 3 || Date.now() - lastHighNudge < 30 * 60 * 1000) return
  lastHighNudge = Date.now()
  const lines = [
    'Hate to break do-not-disturb, but high-priority stuff is genuinely stacking - want a rundown?',
    'DND still on - but there are several high-priority things piling up now. Say the word.',
  ]
  void speak(lines[Math.floor(Math.random() * lines.length)])
}, 60000).unref()
let resumeOnContact = false
let silenceGrace = 0   // brief window so the go_silent confirmation itself is audible
function isSilenced(): boolean { return Date.now() < silencedUntil }
setInterval(() => {
  if (silencedUntil && Date.now() >= silencedUntil) {
    silencedUntil = 0
    saveModeState()
    resumeOnContact = true
    log('wendy: silence period expired')
    if (connection && heldWhileSilent.length) {
      void speak(`I'm back - ${heldWhileSilent.length === 1 ? 'one thing' : heldWhileSilent.length + ' things'} moved while I was quiet. Want the rundown?`)
    }
  }
}, 20000).unref()
function tierFor(sessionId: string): NotifyTier {
  for (const r of Object.values(loadRoutes())) if (r.id === sessionId) return r.tier ?? 'digest'
  return 'digest'
}
function announce(text: string, tier: NotifyTier): void {
  diag('announce', { tier, text: text.slice(0, 300), inVc: !!connection })
  if (isSilenced()) {
    heldWhileSilent.push(text)
    if (heldWhileSilent.length > 12) heldWhileSilent.splice(0, heldWhileSilent.length - 12)
    return
  }
  if (tier === 'interrupt' && connection) { convoEvents.push(text); return }
  if (tier === 'onjoin' || !connection || isSilenced()) {
    pendingAnnouncements.push(text)
    if (pendingAnnouncements.length > 8) pendingAnnouncements.splice(0, pendingAnnouncements.length - 8)
    return
  }
  digestQueue.push(text)
}
let lastDigestAsk = 0
setInterval(() => {
  if (!digestQueue.length) return
  const items = digestQueue.splice(0, 6)
  if (connection && !busy && !isSilenced()) {
    heldWhileSilent.push(...items)
    if (heldWhileSilent.length > 12) heldWhileSilent.splice(0, heldWhileSilent.length - 12)
    if (!dnd && Date.now() > askSnoozedUntil && Date.now() - lastDeliveredAt > 10 * 60 * 1000 && Date.now() - lastDigestAsk > 30 * 60 * 1000) {
      lastDigestAsk = Date.now()
      const asks = [
        'Little stack of news piling up here - want it?',
        'Updates are queueing themselves - say the word.',
        'Few things landed while we talked. Highlights?',
        'News drawer is filling up - want a peek?',
      ]
      void speak(asks[Math.floor(Math.random() * asks.length)])
    }
  } else {
    pendingAnnouncements.push(...items)
    if (pendingAnnouncements.length > 8) pendingAnnouncements.splice(0, pendingAnnouncements.length - 8)
  }
}, 15 * 60 * 1000).unref()
function fingerprint(tail: string): string { return tail.slice(-3000) }
// One memory across ALL announcement sources (watches, change feed, schedules):
// if a session's content hasn't changed since we last told the owner, stay quiet.
const lastAnnounced = new Map<string, { fp: string; at: number }>()
const briefingCache = new Map<string, { s: string; at: number }>()
function shouldAnnounce(id: string, tail: string): boolean {
  const fp = fingerprint(tail)
  const prev = lastAnnounced.get(id)
  if (prev && prev.fp === fp) { diag('announce_deduped', { id }); return false }
  lastAnnounced.set(id, { fp, at: Date.now() })
  return true
}
function watchSession(id: string, label: string): void {
  label = labelFor(id, label)
  if (watchlist.some((w) => w.id === id)) return
  const w: Watch = { id, label, fp: '', baselined: false, expires: Date.now() + 45 * 60 * 1000 }
  watchlist.push(w)
  log(`wendy: watching ${label} (${id})`)
  // Baseline NOW - replies landing after this instant are deltas. Baselining on
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
      if (first && shouldAnnounce(w.id, tail)) {
        const brief = await summarizeForVoice(w.label, recentMessages(tail, 3))
        briefingCache.set(w.id, { s: brief, at: Date.now() })
        announce(brief, 'interrupt')
      }
      else if (!first) w.more = true
    } else if (w.seen && (w.idle = (w.idle ?? 0) + 1) >= 2) {
      watchlist.splice(i, 1)
      diag('watch_done', { id: w.id, label: w.label, hadMore: !!w.more })
      if (w.more && shouldAnnounce(w.id, tail)) {
        const brief = await summarizeForVoice(w.label + ' (finished)', recentMessages(tail, 3))
        briefingCache.set(w.id, { s: brief, at: Date.now() })
        announce(brief, 'interrupt')
      }
    }
  }
}
setInterval(() => void pollWatchlist(), 45000).unref()

let evictionBuffer: Msg[] = []
let episodizing = false
async function episodize(): Promise<void> {
  if (episodizing || evictionBuffer.length < 10) return
  episodizing = true
  const batch = evictionBuffer.splice(0, 16)
  try {
    const url = brainUrl()
    if (!url) return
    const convo = batch.map((m) => `${m.role}: ${String(m.content ?? '').slice(0, 400)}`).join('\n')
    const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'local-fast', cache_prompt: true, max_tokens: 250, messages: [
        { role: 'system', content: 'You are the memory-writer for a voice assistant. Compress this conversation fragment into ONE journal entry, 2-4 dense past-tense sentences: decisions made, tasks dispatched and their outcomes, personal facts/preferences/plans the owner revealed, anything they might reference weeks later. IGNORE routine update-delivery chatter and pleasantries. If truly nothing is worth remembering, reply exactly SKIP.' },
        { role: 'user', content: convo } ] }),
      signal: AbortSignal.timeout(60000),
    }).catch(() => null)
    const d = res?.ok ? (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null : null
    const text = d?.choices?.[0]?.message?.content?.trim() ?? ''
    if (text && !/^skip\.?$/i.test(text)) {
      fs.appendFileSync(journalPath(), JSON.stringify({ ts: Date.now(), s: text.slice(0, 600) }) + '\n')
      diag('memory_episode', { chars: text.length })
      // prune: keep newest 400
      const eps = loadJournal()
      if (eps.length > 500) fs.writeFileSync(journalPath(), eps.slice(-400).map((e) => JSON.stringify(e)).join('\n') + '\n')
    }
  } catch {} finally { episodizing = false }
}

const consolMarkPath = () => path.join(workspaceDir(), 'consolidation.json')
async function consolidateMemory(): Promise<void> {
  if (busy || episodizing) return
  const eps = loadJournal()
  let mark = { count: 0, at: 0 }
  try { mark = JSON.parse(fs.readFileSync(consolMarkPath(), 'utf-8')) as typeof mark } catch {}
  const fresh = eps.length - mark.count
  if (fresh < 8 && !(fresh >= 3 && Date.now() - mark.at > 12 * 3600000)) return
  const url = brainUrl()
  if (!url) return
  let current = ''
  try { current = fs.readFileSync(path.join(workspaceDir(), 'memory.md'), 'utf-8') } catch {}
  const recent = eps.slice(-30).map((e) => `[${new Date(e.ts).toISOString().slice(0, 10)}] ${e.s}`).join('\n')
  const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ model: 'local-fast', cache_prompt: true, max_tokens: 700, messages: [
      { role: 'system', content: 'You maintain memory.md - a voice assistant\'s standing memory of her owner. Merge the journal entries into the current file: keep durable facts (preferences, ongoing projects and their state, people, health, routines, promises made), update anything that changed, drop stale or one-off details. Output ONLY the new file content, markdown, max 250 words, organized under a few short headers.' },
      { role: 'user', content: `CURRENT memory.md:\n${current.slice(0, 3000)}\n\nRECENT JOURNAL:\n${recent}` } ] }),
    signal: AbortSignal.timeout(90000),
  }).catch(() => null)
  const d = res?.ok ? (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null : null
  const text = d?.choices?.[0]?.message?.content?.trim() ?? ''
  if (text && text.length > 40) {
    fs.writeFileSync(path.join(workspaceDir(), 'memory.md'), text)
    fs.writeFileSync(consolMarkPath(), JSON.stringify({ count: eps.length, at: Date.now() }))
    diag('memory_consolidated', { episodes: eps.length, bytes: text.length })
    log(`wendy: memory consolidated (${eps.length} episodes -> ${text.length}b memory.md)`)
  }
}
setInterval(() => void consolidateMemory(), 60 * 60 * 1000).unref()

async function summarizeForVoice(label: string, content: string): Promise<string> {
  const url = brainUrl()
  if (!url) return `Update from ${label}.`
  const res = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ model: 'local-fast', cache_prompt: true, max_tokens: 200, messages: [
      { role: 'system', content: 'You summarize agent-thread activity for spoken delivery. The messages are ordered oldest to newest - the LAST message is the current state and your focus. In 1-2 short sentences state concretely what is happening NOW or just finished - results, decisions, numbers, errors. Earlier messages are only context. PREFIX your reply with exactly one of [HIGH] [MED] [LOW]: breakages, blockers, failed deploys, or questions needing the owner = [HIGH]; completed milestones and notable results = [MED]; routine progress = [LOW]. Then "' + label + ':". Plain speech, no formatting.' },
      { role: 'user', content } ] }),
    signal: AbortSignal.timeout(60000),
  }).catch(() => null)
  if (!res?.ok) return `Update from ${label} - new activity in that thread.`
  const d = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null
  return d?.choices?.[0]?.message?.content?.trim() || `Update from ${label} - new activity.`
}
let connection: VoiceConnection | null = null
let player: AudioPlayer | null = null
let busy = false

export const spokenTranscript: string[] = []
let lastSpokenText = ''
let lastSpeechEnd = 0
let speechEpoch = 0
const speechQueueTexts: string[] = []
function interruptSpeech(): string[] {
  const snapshot = [...speechQueueTexts]
  speechEpoch++
  try { player?.stop(true) } catch {}
  return snapshot
}
let speakChain: Promise<void> = Promise.resolve()
async function speak(text: string): Promise<void> {
  diag('speak', { text })
  speechQueueTexts.push(text)
  spokenTranscript.push(text)
  if (spokenTranscript.length > 50) spokenTranscript.splice(0, 20)
  const run = async (): Promise<void> => {
    const dequeue = (): void => { const i = speechQueueTexts.indexOf(text); if (i !== -1) speechQueueTexts.splice(i, 1) }
    try { await runInner() } finally { dequeue() }
  }
  const runInner = async (): Promise<void> => {
    if (!connection || !player) return
    if (isSilenced() && Date.now() > silenceGrace) { log('wendy: speak suppressed (silenced)'); diag('speak_suppressed', { text: text.slice(0, 200), why: 'silenced' }); return }
    // Turn-taking: never START speaking while the owner is mid-utterance.
    const waitStart = Date.now()
    while (capturing && Date.now() - waitStart < 8000) await new Promise((r) => setTimeout(r, 150))
    const ep = speechEpoch
    const speakable = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_`#]+/g, '')
      .replace(/^\s*[-•]\s+/gm, '')
      .replace(/\s*\n+\s*/g, '. ')
      .replace(/\.{2,}/g, '.')
      .trim()
      .replace(/[,;:\-]\s*$/, '')
      .replace(/([^.!?])$/, '$1.')
    const wav = await tts(speakable)
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

// - self-calibrating audio gates: learn the owner's real speech levels -
const audioStatsPath = () => path.join(workspaceDir(), 'audio-stats.json')
let rmsSamples: number[] = []
try { rmsSamples = (JSON.parse(fs.readFileSync(audioStatsPath(), 'utf-8')) as { samples?: number[] }).samples ?? [] } catch {}
let calRmsGate = 220
let calBargeGate = 400
function recalibrateGates(): void {
  if (rmsSamples.length < 30) return
  const sorted = [...rmsSamples].sort((a, b) => a - b)
  const q = (p: number): number => sorted[Math.floor(p * (sorted.length - 1))]
  calRmsGate = Math.min(Math.max(Math.round(0.4 * q(0.1)), 120), 350)
  calBargeGate = Math.min(Math.max(Math.round(0.5 * q(0.5)), 300), 900)
  diag('gates_calibrated', { samples: rmsSamples.length, rmsGate: calRmsGate, bargeGate: calBargeGate, p10: q(0.1), p50: q(0.5) })
}
recalibrateGates()
function recordAcceptedRms(rms: number): void {
  rmsSamples.push(Math.round(rms))
  if (rmsSamples.length > 200) rmsSamples.splice(0, rmsSamples.length - 200)
  if (rmsSamples.length % 10 === 0) {
    try { fs.writeFileSync(audioStatsPath(), JSON.stringify({ samples: rmsSamples })) } catch {}
    recalibrateGates()
  }
}
let capturing = false
let pendingUtterance: string | null = null
let inputSeq = 0
let streamDrains = 0
let busyAckGiven = false
let turnStartedAt = 0
let lastBusyAck = 0
let lastRelayAck = 0
let lastConvoActivity = 0
const convoEvents: string[] = []
let lastBgDelivery = 0
// Deliver background results only when the conversation has space:
// nobody talking, nothing playing, no turn running, >10s since last exchange.
setInterval(() => {
  if (!convoEvents.length || !connection || busy || capturing || isSilenced() || playerActive() || resumeOnContact) return
  if (dnd || Date.now() < askSnoozedUntil) {
    if (convoEvents.length > 15) convoEvents.splice(0, convoEvents.length - 15)
    return
  }
  if (Date.now() - lastConvoActivity < 10000) return
  if (Date.now() - lastBgDelivery < 4 * 60 * 1000) return
  lastBgDelivery = Date.now()
  const events = convoEvents.splice(0, 4)
  lastDeliveredAt = Date.now()
  log(`wendy: conversation idle - delivering ${events.length} background event(s)`)
  diag('bg_delivery', { count: events.length })
  void runTurn(`[BACKGROUND UPDATE - this is NOT the owner speaking. Results from parallel work just arrived:]\n${events.join('\n')}\n[Tell the owner briefly and naturally, like a colleague mentioning news at a pause. Prioritize if several. Anything you ALREADY told the owner this conversation, or anything not worth interrupting for: reply with exactly SKIP (nothing else) - never say you are staying quiet, never restate old news in new words.]`)
}, 5000).unref()
function playerActive(): boolean {
  const st = player?.state.status
  return st === AudioPlayerStatus.Playing || st === AudioPlayerStatus.Buffering
}

async function runTurn(text: string): Promise<void> {
  const seq = ++inputSeq
  if (busy) {
    pendingUtterance = pendingUtterance ? `${pendingUtterance} - ${text}`.slice(-1500) : text
    log(`wendy: busy - queued "${text.slice(0, 50)}"`)
    diag('queued_while_busy', { text })
    if (!busyAckGiven && !isSilenced() && Date.now() - turnStartedAt > 10000 && Date.now() - lastBusyAck > 90000) {
      busyAckGiven = true
      lastBusyAck = Date.now()
      void speak("One sec - I heard you, just finishing something.")
    }
    return
  }
  busy = true
  busyAckGiven = false
  turnStartedAt = Date.now()
  lastConvoActivity = Date.now()
  const watchdog = setTimeout(() => {
    log('wendy WATCHDOG: utterance pipeline exceeded 4min - force-releasing')
    diag('turn_watchdog', {})
    history.push({ role: 'assistant', content: 'That took way too long and I lost my train of thought - mind asking again?' })
    persistHistory()
    void speak('That took way too long and I lost my train of thought - mind asking again?')
    busy = false
  }, 240000)
  try {
    if (isSilenced()) {
      const t = text.toLowerCase()
      if (/\bw[ei]+nd[iy]e?\b/.test(t)) {
        silencedUntil = 0
        saveModeState()
        log('wendy: unmuted by owner voice command')
        await speak(heldWhileSilent.length
          ? `I'm back - ${heldWhileSilent.length === 1 ? 'one thing' : heldWhileSilent.length + ' things'} moved while I was quiet. Want the rundown?`
          : `I'm back.`)
      } else log(`wendy: silenced - dropped "${text.slice(0, 60)}"`)
      return
    }
    resumeOnContact = false
    if ((heldWhileSilent.length || (dnd && (convoEvents.length || digestQueue.length))) && !text.startsWith('[')) {
      const held = [...heldWhileSilent.splice(0), ...(dnd ? [...convoEvents.splice(0), ...digestQueue.splice(0)] : [])]
      lastDeliveredAt = Date.now()
      text = `[Context - updates queued while you were quiet or the owner was away (each tagged HIGH/MED/LOW): ${held.join(' | ')}. You may have offered a catch-up. Deliver HIGH items first, then MED; skip LOW unless they want everything. If they dismiss ("not now", "later"), call snooze_updates and drop the subject instantly. If the owner wants everything, deliver it concisely. If they ask for the most urgent or most recent only, REASON over the list yourself, pick the single most important item (breakages and blockers beat progress notes; newest beats oldest), deliver just that one, and stop - no extra digging, no spillover into other updates unless asked.]\n${text}`
    }
    log(`wendy heard: "${text.slice(0, 80)}"`)
    diag('owner_said', { text })
    const turnT0 = Date.now()
    let streamedCount = 0
    const sentBuf: string[] = []
    let draining = false
    const drain = async (): Promise<void> => {
      if (draining) return
      draining = true
      streamDrains++
      try {
        while (sentBuf.length) {
          // superseded by newer input, or silenced -> stop talking entirely
          if (seq !== inputSeq || isSilenced()) { sentBuf.length = 0; break }
          const chunk = sentBuf.splice(0, 3).join(' ') // cap: bounded synth time per chunk
          await speak(chunk) // awaits playback - later sentences coalesce into one prosody unit
        }
      } finally { draining = false; streamDrains-- }
    }
    const streamer = text.startsWith('[') ? undefined : (sent: string): void => {
      if (seq !== inputSeq || isSilenced()) return
      streamedCount++
      sentBuf.push(sent)
      void drain()
    }
    const reply = await think(text, streamer)
    diag('turn_done', { ms: Date.now() - turnT0, reply: reply.slice(0, 800), superseded: seq !== inputSeq, streamed: streamedCount })
    if (!reply.trim()) return
    if (seq !== inputSeq) {
      log(`wendy: reply superseded by newer input - staying quiet: "${reply.slice(0, 60)}"`)
      return
    }
    log(`wendy says: "${reply.slice(0, 80)}"`)
    if (!streamedCount) void speak(reply)
  } catch (e) {
    log('wendy: turn crashed:', (e as Error).message)
    diag('turn_crash', { err: String((e as Error).message).slice(0, 200) })
    history.push({ role: 'assistant', content: 'Something glitched in my head mid-thought - say that again?' })
    persistHistory()
    void speak('Something glitched in my head mid-thought - say that again?')
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
    const captureGuard = setTimeout(() => {
      if (capturing) { capturing = false; log('wendy: capture guard - stuck capture released'); diag('capture_stuck_released', {}) }
    }, 60000)
    const opus = receiver.subscribe(speakingUserId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 900 },
    })
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 })
    const chunks: Buffer[] = []
    let bytes = 0
    let sumSqLive = 0
    let interrupted = false
    let cutSpeech: string[] = []
    opus.pipe(decoder)
    decoder.on('data', (c: Buffer) => {
      chunks.push(c)
      bytes += c.length
      for (let i = 0; i < c.length; i += 8) { const v = c.readInt16LE(i - (i % 2)); sumSqLive += v * v }
      // barge-in: ~0.7s of sustained AND genuinely loud speech while she's talking.
      // Duration alone false-triggered on fan hum / speaker bleed (seen live at RMS 48).
      if (!interrupted && bytes > 67200 && playerActive()) {
        const rmsLive = Math.sqrt(sumSqLive / (bytes / 8))
        if (rmsLive >= calBargeGate) {
          interrupted = true
          cutSpeech = interruptSpeech()
          log('wendy: barge-in - owner spoke over me, playback cut')
          diag('barge_in', { rms: Math.round(rmsLive) })
        }
      }
    })
    opus.on('close', () => { clearTimeout(captureGuard); capturing = false })
    opus.on('error', () => { clearTimeout(captureGuard); capturing = false })
    decoder.on('close', () => { clearTimeout(captureGuard); capturing = false })
    decoder.on('end', () => {
      clearTimeout(captureGuard)
      capturing = false
      void (async () => {
        const resumeIfPhantom = (): void => {
          // a streamed reply that's still draining will continue on its own -
          // replaying the cut chunk now would land AFTER the next chunk (scrambled)
          if (streamDrains > 0) { cutSpeech = []; return }
          if (interrupted && cutSpeech.length) {
            log('wendy: barge-in was a phantom - resuming what I was saying')
            diag('barge_in_resumed', { sentences: cutSpeech.length })
            for (const t of cutSpeech) void speak(t)
            cutSpeech = []
          }
        }
        const pcm = Buffer.concat(chunks)
        // She just asked a question -> a short "yes/sure/okay" is the EXPECTED shape
        // of the answer; the anti-phantom gates must not eat it.
        const expectingAnswer = /\?\s*$/.test(lastSpokenText.trim()) && Date.now() - lastSpeechEnd < 15000
        const minBytes = isSilenced() || expectingAnswer ? 24000 : 48000 // 0.25s when a wake-word or short answer is expected
        if (pcm.length < minBytes) { diag('dropped', { why: 'too_short', bytes: pcm.length }); resumeIfPhantom(); return }
        // energy gate: breath/hum/keyboard is near-silent; real speech is not
        let sumSq = 0
        const samples = pcm.length / 2
        for (let i = 0; i < pcm.length; i += 2) { const v = pcm.readInt16LE(i); sumSq += v * v }
        const rms = Math.sqrt(sumSq / samples)
        if (rms < calRmsGate) { diag('dropped', { why: 'low_energy', rms: Math.round(rms), gate: calRmsGate }); resumeIfPhantom(); return }
        const { text, noSpeech, logprob } = await stt(pcm48kMonoToWav(pcm))
        if (!text || text.length < 2) { resumeIfPhantom(); return }
        // Silence wake-word: DETERMINISTIC - checked before every other gate so
        // nothing (confidence, artifact, noise filters) can eat a wake attempt.
        if (isSilenced() && /\bw[ei]+nd[iy]e?\b/i.test(text)) {
          diag('wake_word', { text: text.slice(0, 60) })
          void runTurn(text)
          return
        }
        if (isSilenced()) diag('dropped', { text: text.slice(0, 60), why: 'silenced', noSpeech: +noSpeech.toFixed(2), logprob: +logprob.toFixed(2) })
        // Whisper's own confidence: silence-hallucinations carry high no_speech_prob
        // and low avg_logprob. Real speech is typically logprob > -0.5, noSpeech < 0.3.
        if (noSpeech > 0.55 || logprob < -0.9) {
          diag('dropped', { text: text.slice(0, 60), why: 'low_confidence', noSpeech: +noSpeech.toFixed(2), logprob: +logprob.toFixed(2) })
          resumeIfPhantom()
          return
        }
        // Stock ghost phrases need GOOD confidence to be believed at all
        if (!expectingAnswer && /^(thank you|thanks|okay|ok|you|bye|yeah)[.!\s]*$/i.test(text.trim()) && (logprob < -0.4 || noSpeech > 0.25)) {
          diag('dropped', { text: text.trim(), why: 'stock_low_conf', noSpeech: +noSpeech.toFixed(2), logprob: +logprob.toFixed(2) })
          resumeIfPhantom()
          return
        }
        // Whisper hallucination artifacts: subtitle credits, thanks-for-watching, url spam.
        // These are training-data ghosts - drop at ANY clip length.
        const ARTIFACT = /(thank you for watching|thanks for watching|takk for|teksting av|undertekster|subtitles? by|untertitel|sous-titr|like and subscribe|share this video|www\.|\.com\b)/i
        if (ARTIFACT.test(text)) {
          log(`wendy: dropped whisper artifact "${text.trim().slice(0, 50)}"`)
          diag('dropped', { text: text.trim().slice(0, 80), why: 'artifact' })
          resumeIfPhantom()
          return
        }
        // Stock phrases on noise/breath; drop for short clips.
        const NOISE = /^(thanks?( you| for watching)?|you|bye|\.|uh|um)[.!\s]*$/i
        if (!isSilenced() && pcm.length < 2 * 96000 && NOISE.test(text.trim())) {
          log(`wendy: dropped noise artifact "${text.trim()}"`)
          diag('dropped', { text: text.trim(), why: 'noise' })
          resumeIfPhantom()
          return
        }
        const BACKCHANNEL = /^(yeah|yep|yes|ok(ay)?|mhm+|uh-?huh|right|true|sure|lol|haha+|nice|cool|got it|go on|i see|wow)[.!,\s]*$/i
        if (!isSilenced() && pcm.length < 3 * 96000 && BACKCHANNEL.test(text.trim())) {
          const sheAsked = /\?\s*$/.test(lastSpokenText.trim())
          const overlapping = playerActive()
          const longIdle = Date.now() - lastSpeechEnd > 30000
          if (!sheAsked && (overlapping || longIdle)) {
            log(`wendy: backchannel - not a turn: "${text.trim()}"`)
            diag('dropped', { text: text.trim(), why: 'backchannel' })
            resumeIfPhantom()
            return
          }
        }
        recordAcceptedRms(rms)
        let turnText = text
        if (interrupted && cutSpeech.length) {
          // Real interruption: hand her the unfinished thought so she can reason
          // about it - answer the owner first, then finish/drop the thread herself.
          turnText = `${text}\n[note: you were mid-reply when the owner cut in - these sentences of yours were never heard: "${cutSpeech.join(' ').slice(0, 500)}". Answer the owner first. Then decide naturally whether that unfinished part still matters: if it does, weave it in or finish it in your own words (a casual bridge in whatever phrasing fits); if their interruption made it moot, just drop it.]`
          cutSpeech = []
          diag('interrupted_context', {})
        }
        void runTurn(turnText)
      })()
    })
    decoder.on('error', () => { clearTimeout(captureGuard); capturing = false })
  })
}

async function joinAndServe(channel: VoiceBasedChannel, userId: string): Promise<void> {
  leave()
  capturing = false
  pendingUtterance = null
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
        log('wendy: voice dropped - rejoining')
        void joinAndServe(channel, userId)
      }
    })()
  })
  listenTo(channel, userId)
  const queued = pendingAnnouncements.splice(0)
  if (queued.length) {
    heldWhileSilent.push(...queued)
    if (heldWhileSilent.length > 12) heldWhileSilent.splice(0, heldWhileSilent.length - 12)
  }
  const hi = queued.filter((x) => x.includes('[HIGH]')).length
  void runTurn(`[The owner just joined voice. Greet them briefly and naturally - ONE short line, warm but efficient, no jokes or bits. Vary it; never a stock phrase.${queued.length ? ` Also: ${queued.length} update${queued.length > 1 ? 's are' : ' is'} queued${hi ? ` (${hi} high-priority)` : ''} - fold a casual offer to share into the greeting, but do NOT deliver any contents yet.` : ''}]`)
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
  clientRef = client
  client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    if (newState.member?.user.id !== owner) return
    if (dormant) return
    if (newState.channel && newState.channelId !== oldState.channelId) {
      void joinAndServe(newState.channel, owner)
    } else if (!newState.channel && connection) {
      log('wendy: owner left, standing down')
      leave()
    }
  })
  log(`wendy: armed - will follow owner ${owner} into voice channels`)
}
