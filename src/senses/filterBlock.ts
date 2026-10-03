// Content-filter detection, deterministic. When the provider blocks a reply,
// OpenCode stores the assistant message with error.name = "ContentFilterError"
// (text: "The response was blocked by the provider's content filter"). That
// error is NOT in `kimaki session read` transcripts - the thread just looks cut
// off mid-word and goes quiet, so reading tails could never see it. This reads
// the local OpenCode database directly (read-only).
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

export type FilterState = {
  blocked: boolean          // the thread's latest assistant turn was blocked and nothing has answered since
  nudgedSince: boolean      // a user message was sent after the block, no reply yet
  consecutive: number       // blocked assistant turns in a row (most recent first)
  lastBlockAt: number | null
  totalBlocks: number       // blocks among the last 40 messages
}

type Db = { prepare(sql: string): { all(...a: unknown[]): Array<Record<string, unknown>> }; close(): void }
const dbPath = (): string => path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')

async function open(): Promise<Db | null> {
  if (!fs.existsSync(dbPath())) return null
  try {
    const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => Db }
    return new sqlite.DatabaseSync(dbPath(), { readOnly: true })
  } catch { return null }
}

type Row = { role: string; error?: string; at: number }
function parse(rows: Array<Record<string, unknown>>): Row[] {
  return rows.map((r) => {
    let d: { role?: string; error?: { name?: string } } = {}
    try { d = JSON.parse(String(r.data)) } catch {}
    return { role: d.role ?? '?', error: d.error?.name, at: Number(r.time_created) }
  })
}

/** rows newest-first */
export function stateFrom(rows: Row[]): FilterState {
  let consecutive = 0, nudgedSince = false, blocked = false
  const lastBlock = rows.find((r) => r.error === 'ContentFilterError')
  for (const r of rows) {
    if (r.role === 'user') { if (consecutive === 0) { nudgedSince = true; continue } break }
    if (r.role !== 'assistant') continue
    if (r.error === 'ContentFilterError') { consecutive++; continue }
    if (r.error === 'MessageAbortedError' && consecutive === 0 && !nudgedSince) continue // an abort after a block is still the block
    break
  }
  blocked = consecutive > 0
  if (!blocked) nudgedSince = false
  return { blocked, nudgedSince, consecutive, lastBlockAt: lastBlock?.at ?? null, totalBlocks: rows.filter((r) => r.error === 'ContentFilterError').length }
}

export async function filterState(sessionId: string): Promise<FilterState | null> {
  const db = await open()
  if (!db) return null
  try {
    return stateFrom(parse(db.prepare('SELECT time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 40').all(sessionId)))
  } catch { return null } finally { db.close() }
}

/** Every session whose current state is "blocked", among sessions active in the window. */
export async function blockedSessions(windowMs = 6 * 3600000): Promise<Array<{ sessionId: string; state: FilterState }>> {
  const db = await open()
  if (!db) return []
  try {
    const rows = db.prepare('SELECT session_id, time_created, data FROM message WHERE time_created > ? ORDER BY time_created DESC').all(Date.now() - windowMs)
    const by = new Map<string, Array<Record<string, unknown>>>()
    for (const r of rows) { const k = String(r.session_id); if (!by.has(k)) by.set(k, []); by.get(k)!.push(r) }
    const out: Array<{ sessionId: string; state: FilterState }> = []
    for (const [sessionId, rs] of by) {
      if (!rs.some((r) => String(r.data).includes('ContentFilterError'))) continue
      const state = stateFrom(parse(rs.slice(0, 40)))
      if (state.blocked) out.push({ sessionId, state })
    }
    return out
  } catch { return [] } finally { db.close() }
}

export function describe(s: FilterState): string {
  const ago = s.lastBlockAt ? `${Math.max(1, Math.round((Date.now() - s.lastBlockAt) / 60000))} min ago` : 'recently'
  return `STUCK ON CONTENT FILTER: its last ${s.consecutive > 1 ? `${s.consecutive} replies were` : 'reply was'} blocked by the provider's content filter (${ago})${s.nudgedSince ? ', a nudge was sent after it and has not been answered yet' : ''}. The thread is NOT working - it is silent because of the block. Re-sending the same wording will be blocked again: ask it to continue in neutral design language, in smaller parts. Use guard_thread to have this done automatically. Do not switch its model.`
}

export type ThreadHealth = {
  status: 'blocked' | 'errored' | 'working' | 'idle' | 'aborted' | 'unknown'
  lastActivityAt: number | null
  model: string | null
  contextTokens: number | null
  lastError: string | null
  filter: FilterState
  awaitingReply: boolean
  lastOkAt: number | null      // last assistant turn that completed without error
}
/** Everything the OpenCode DB can tell about a thread right now. */
export async function threadHealth(sessionId: string): Promise<ThreadHealth | null> {
  const db = await open()
  if (!db) return null
  try {
    const rows = db.prepare('SELECT time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 40').all(sessionId)
    if (!rows.length) return { status: 'unknown', lastActivityAt: null, model: null, contextTokens: null, lastError: null, filter: stateFrom([]), awaitingReply: false, lastOkAt: null }
    type M = { role?: string; error?: { name?: string; data?: { message?: string } }; time?: { completed?: number }; modelID?: string; tokens?: { input?: number; cache?: { read?: number } } }
    const ms = rows.map((r) => { try { return JSON.parse(String(r.data)) as M } catch { return {} as M } })
    const filter = stateFrom(parse(rows))
    const lastA = ms.find((m) => m.role === 'assistant')
    const lastDone = ms.find((m) => m.role === 'assistant' && m.time?.completed && !m.error)
    const latest = ms[0]
    const err = lastA?.error
    let status: ThreadHealth['status'] = 'idle'
    if (filter.blocked) status = 'blocked'
    else if (latest.role === 'assistant' && err && err.name !== 'MessageAbortedError') status = 'errored'
    else if (latest.role === 'assistant' && err?.name === 'MessageAbortedError') status = 'aborted'
    else if (latest.role === 'assistant' && !latest.time?.completed && Date.now() - Number(rows[0].time_created) < 20 * 60000) status = 'working'
    const ctx = lastDone?.tokens ? (lastDone.tokens.input ?? 0) + (lastDone.tokens.cache?.read ?? 0) : null
    return { status, lastActivityAt: Number(rows[0].time_created), model: lastA?.modelID ?? null, contextTokens: ctx || null, lastError: err ? `${err.name}: ${err.data?.message ?? ''}`.slice(0, 200) : null, filter, awaitingReply: latest.role === 'user', lastOkAt: (() => { const i = ms.findIndex((m) => m.role === 'assistant' && m.time?.completed && !m.error); return i >= 0 ? Number(rows[i].time_created) : null })() }
  } catch { return null } finally { db.close() }
}
export function describeHealth(h: ThreadHealth): string {
  const ago = h.lastActivityAt ? `${Math.max(0, Math.round((Date.now() - h.lastActivityAt) / 60000))} min ago` : 'never'
  const head = h.status === 'blocked' ? describe(h.filter)
    : h.status === 'errored' ? `ERRORED: its last turn failed (${h.lastError}). It is not working until someone re-prompts it.`
    : h.status === 'aborted' ? 'ABORTED: its last turn was cancelled; it is idle.'
    : h.status === 'working' ? 'WORKING: a reply is being generated right now.'
    : h.awaitingReply ? 'WAITING: a prompt was sent and has no reply yet.'
    : 'IDLE: finished its last turn.'
  return `${head} Last activity ${ago}. Model ${h.model ?? '?'}${h.contextTokens ? `, context ~${Math.round(h.contextTokens / 1000)}k tokens` : ''}.`
}

// ── recovery analysis via the OpenCode server API ──
import { execFileSync } from 'node:child_process'
export type ApiMsg = { info: { id: string; role: string; error?: { name?: string }; modelID?: string; providerID?: string }; parts: Array<{ type: string; text?: string; tool?: string; state?: { status?: string; input?: { filePath?: string } } }> }
let apiBase: string | null = null
export async function opencodeBase(): Promise<string | null> {
  if (apiBase && (await fetch(`${apiBase}/doc`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false))) return apiBase
  apiBase = null
  let out = ''
  try { out = execFileSync('ss', ['-ltnpH'], { encoding: 'utf-8' }) } catch { return null }
  for (const m of out.matchAll(/127\.0\.0\.1:(\d+)\s.*"opencode"/g)) {
    const b = `http://127.0.0.1:${m[1]}`
    if (await fetch(`${b}/doc`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false)) return (apiBase = b)
  }
  return null
}
export async function sessionDir(sessionId: string): Promise<string | null> {
  const db = await open()
  if (!db) return null
  try { return String(db.prepare('SELECT directory FROM session WHERE id = ?').all(sessionId)[0]?.directory ?? '') || null } catch { return null } finally { db.close() }
}
export async function listMessages(sessionId: string, limit = 60): Promise<ApiMsg[] | null> {
  const base = await opencodeBase(); const dir = await sessionDir(sessionId)
  if (!base || !dir) return null
  const r = await fetch(`${base}/session/${sessionId}/message?directory=${encodeURIComponent(dir)}&limit=${limit}`, { signal: AbortSignal.timeout(15000) }).catch(() => null)
  return r?.ok ? ((await r.json()) as ApiMsg[]) : null
}

export type StuckRun = {
  failed: number                // failed assistant turns at the end
  errors: string[]              // their error names
  revertPoint: string | null    // first USER message of the failed run
  removed: number               // messages a revert would remove
  hasPatches: boolean           // removed messages carry file patches
  partialFiles: string[]        // write/edit calls that never completed
  lastGoodText: string          // tail of the last successful assistant text
  cutoffText: string            // tail of the latest failed turn's partial output
  briefTask: string             // the user request being retried
}
const isFail = (m: ApiMsg): boolean => m.info.role === 'assistant' && !!m.info.error && m.info.error.name !== 'MessageAbortedError'
/** msgs oldest-first. */
export function stuckRun(msgs: ApiMsg[]): StuckRun | null {
  let i = msgs.length - 1
  while (i >= 0 && (isFail(msgs[i]) || msgs[i].info.role === 'user' || (msgs[i].info.error?.name === 'MessageAbortedError'))) i--
  const run = msgs.slice(i + 1)
  const failed = run.filter(isFail)
  if (!failed.length) return null
  const firstUser = run.find((m) => m.info.role === 'user')
  const from = firstUser ? msgs.indexOf(firstUser) : -1
  const removedMsgs = from >= 0 ? msgs.slice(from) : []
  const good = msgs.slice(0, i + 1).reverse().find((m) => m.info.role === 'assistant' && !m.info.error && m.parts.some((p) => p.type === 'text' && p.text?.trim()))
  const goodText = good?.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n').trim() ?? ''
  const task = firstUser?.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n').trim() ?? ''
  return {
    failed: failed.length,
    errors: [...new Set(failed.map((m) => m.info.error?.name ?? '?'))],
    revertPoint: firstUser?.info.id ?? null,
    removed: removedMsgs.length,
    hasPatches: removedMsgs.some((m) => m.parts.some((p) => p.type === 'patch')),
    partialFiles: [...new Set(run.flatMap((m) => m.parts.filter((p) => p.type === 'tool' && /write|edit/i.test(p.tool ?? '') && p.state?.status !== 'completed').map((p) => p.state?.input?.filePath ?? '').filter(Boolean)))],
    lastGoodText: goodText.slice(-700),
    cutoffText: (failed.at(-1)?.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n').trim() ?? '').slice(-600),
    briefTask: task.slice(0, 1500),
  }
}
