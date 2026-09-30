// Read-only activity mirror: one Discord message per turn in a thread in the
// #wendy channel, edited live - what she heard, her reasoning, each tool call
// and result, her reply. Pure observer of the diag stream: it never changes
// behaviour, and nothing she reads comes from it.
import fs from 'node:fs'
import path from 'node:path'
import type { Client, Message, ThreadChannel } from 'discord.js'
import { onDiag } from './diag.js'
import { configDir, log } from './config.js'

const statePath = () => path.join(configDir(), 'workspace', 'activity.json')
const MAX = 1900
const clip = (s: unknown, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const hhmm = (ts: number): string => new Date(ts).toTimeString().slice(0, 8)

let thread: ThreadChannel | null = null
type Turn = { lines: string[]; msg: Message | null; closedAt: number }
let turn: Turn | null = null   // the turn being written
let last: Turn | null = null   // most recently closed turn (late events append to it)
let flushTimer: NodeJS.Timeout | null = null
let chain: Promise<unknown> = Promise.resolve()

function kindOf(text: string): string {
  if (text.startsWith('[OWNER JOINED')) return '👋 join'
  if (text.startsWith('[BACKGROUND UPDATE')) return '📨 background update'
  if (text.startsWith('[QUEUED UPDATES') || text.startsWith('[He said YES')) return '📬 queued updates'
  if (text.startsWith('[COMMITMENT DUE')) return '⏰ commitment'
  if (text.startsWith('[FIRST INPUT')) return '🎙️ owner'
  if (text.startsWith('[')) return '⚙️ event'
  return '🎙️ owner'
}
function stripTags(text: string): string { return text.replace(/^\[[^\]]*\]\s*/, '').replace(/\n\n\[context for this turn[\s\S]*$/, '') }

function newTurn(header: string): void {
  closeTurn()
  turn = { lines: [header], msg: null, closedAt: 0 }
  schedule()
}
function closeTurn(): void {
  if (!turn) return
  const t = turn
  t.closedAt = Date.now()
  last = t
  turn = null
  write(t)
}
function add(line: string): void {
  // a late event (e.g. "promise kept") right after a turn closed belongs to that turn
  const t = turn ?? (last && Date.now() - last.closedAt < 30000 ? last : null)
  if (!t) { turn = { lines: [`**${hhmm(Date.now())}**`, line], msg: null, closedAt: 0 }; schedule(); return }
  t.lines.push(line)
  if (t === turn) schedule(); else write(t)
}
function schedule(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => { flushTimer = null; if (turn) write(turn) }, 1200)
}
/** Serialised: one Discord message per turn, created once, then edited. */
function write(t: Turn): void {
  chain = chain.then(async () => {
    if (!thread || !t.lines.length) return
    let body = t.lines.join('\n')
    if (body.length > MAX) body = body.slice(0, 400) + '\n…\n' + body.slice(-(MAX - 420))
    try {
      if (t.msg) await t.msg.edit(body)
      else t.msg = await thread.send({ content: body, allowedMentions: { parse: [] } })
    } catch (e) { log('activity mirror: post failed:', String(e).slice(0, 120)) }
  })
}

function onEvent(ev: string, d: Record<string, unknown>, ts: number): void {
  switch (ev) {
    case 'owner_said': {
      const t = String(d.text ?? '')
      newTurn(`**${hhmm(ts)} · ${kindOf(t)}**\n> ${clip(stripTags(t), 300)}`)
      break
    }
    case 'brain': {
      const tools = (d.tools as string[] | undefined) ?? []
      const r = clip(d.reasoning, 220)
      if (r) add(`💭 _${r}_`)
      break
    }
    case 'tool': {
      const args = d.args as Record<string, unknown> | undefined
      const a = args ? clip(Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' '), 110) : ''
      add(`🔧 \`${d.name}\` ${a} → ${clip(d.result, 110)} _(${d.ms} ms)_`)
      break
    }
    case 'turn_done': if (d.reply) add(`🗣️ ${clip(d.reply, 700)}`); add(`✅ done in ${Math.round(Number(d.ms ?? 0) / 100) / 10}s${d.superseded ? ' (superseded)' : ''}`); closeTurn(); break
    case 'turn_skipped': add('🤫 skipped (not worth interrupting)'); closeTurn(); break
    case 'turn_aborted': add(`⛔ aborted (${d.why})`); break
    case 'barge_in': add('✋ you cut in'); break
    case 'commitment_recorded': add(`📌 promise tracked: ${clip(d.what, 160)}`); break
    case 'commitment_done': add(`☑️ promise kept: ${clip(d.what, 160)}`); break
    case 'commitment_waiting': add(`⏳ not ready yet - still tracking: ${clip(d.what, 160)}`); break
    case 'selftask_created': newTurn(`**${hhmm(ts)} · 🧵 background task started**\n> ${clip(d.goal, 200)}`); closeTurn(); break
    case 'selftask_done': case 'selftask_failed': newTurn(`**${hhmm(ts)} · 🧵 background task ${ev === 'selftask_done' ? 'finished' : 'failed'}**`); closeTurn(); break
    case 'away_report': newTurn(`**${hhmm(ts)} · 🌙 away report delivered** (${d.items} item(s))`); closeTurn(); break
  }
}

export async function initActivity(client: Client, channelId: string | undefined): Promise<void> {
  if (!channelId) return
  try {
    const ch = await client.channels.fetch(channelId)
    if (!ch || !('threads' in ch)) return
    let saved: { threadId?: string } = {}
    try { saved = JSON.parse(fs.readFileSync(statePath(), 'utf-8')) } catch {}
    if (saved.threadId) thread = (await client.channels.fetch(saved.threadId).catch(() => null)) as ThreadChannel | null
    if (thread?.archived) await thread.setArchived(false).catch(() => {})
    if (!thread) {
      const threads = (ch as unknown as { threads: { create: (o: object) => Promise<ThreadChannel> } }).threads
      thread = await threads.create({ name: 'Wendy activity (read-only)', autoArchiveDuration: 10080, reason: 'live mirror of what Wendy is doing' })
      await thread.send('Live mirror of what Wendy is doing: what she heard, her reasoning, every tool call and result, her reply. **Read-only** - she never reads this thread; talk to her in voice or the main channel.').catch(() => {})
      await thread.setLocked(true).catch(() => {})
      fs.writeFileSync(statePath(), JSON.stringify({ threadId: thread.id }))
    }
    onDiag(onEvent)
    log(`activity mirror: thread ${thread.id}`)
  } catch (e) { log('activity mirror: init failed:', String(e).slice(0, 160)) }
}
