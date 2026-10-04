// Content-filter detection, deterministic. When the provider blocks a reply,
// OpenCode stores the assistant message with error.name = "ContentFilterError"
// (text: "The response was blocked by the provider's content filter"). That
// error is NOT in `kimaki session read` transcripts - the thread just looks cut
// off mid-word and goes quiet, so reading tails could never see it. This reads
// the local OpenCode database directly (read-only).
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { kimakiLockPort } from '../kimaki/api.js'

export type FilterState = {
  blocked: boolean          // the thread's latest assistant turn was blocked and nothing has answered since
  nudgedSince: boolean      // a user message was sent after the block, no reply yet
  consecutive: number       // blocked assistant turns in a row (most recent first)
  lastBlockAt: number | null
  totalBlocks: number       // blocks among the last 40 messages
}

export type Db = { prepare(sql: string): { all(...a: unknown[]): Array<Record<string, unknown>> }; close(): void }
const dbPath = (): string => process.env.WENDY_OPENCODE_DB ?? path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')

async function open(file = dbPath()): Promise<Db | null> {
  if (!fs.existsSync(file)) return null
  try {
    const sqlite = (await import('node:sqlite')) as unknown as { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => Db }
    return new sqlite.DatabaseSync(file, { readOnly: true })
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

// The message table has no time index (only session_id,time_created,id): a
// time-window query is a full SCAN of a ~93 GB table. Everything below is
// per-session (SEARCH ... USING INDEX message_session_time_created_id_idx).
const LAST_MESSAGES = 'SELECT time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 40'
export const MAX_BLOCK_CANDIDATES = 60

/** Sessions touched in the window, newest first (session table: ~20k small rows, no message scan). */
export function recentSessionIdsFrom(db: Db, windowMs: number, limit = 40): string[] {
  return db.prepare('SELECT id FROM session WHERE time_updated > ? ORDER BY time_updated DESC LIMIT ?').all(Date.now() - windowMs, limit).map((r) => String(r.id))
}
/** Blocked sessions among `candidates` plus sessions updated in the window; null when the DB is unavailable. */
export async function blockedSessions(candidates: string[], windowMs = 3 * 3600000, dbFile?: string): Promise<Array<{ sessionId: string; state: FilterState }> | null> {
  const db = await open(dbFile)
  if (!db) return null
  try {
    let recent: string[] = []
    try { recent = recentSessionIdsFrom(db, windowMs) } catch {}
    const ids = [...new Set([...recent, ...candidates])].slice(0, MAX_BLOCK_CANDIDATES)
    const stmt = db.prepare(LAST_MESSAGES)
    const out: Array<{ sessionId: string; state: FilterState }> = []
    for (const sessionId of ids) {
      const rows = stmt.all(sessionId)
      if (!rows.some((r) => String(r.data).includes('ContentFilterError'))) continue
      const state = stateFrom(parse(rows))
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
  status: 'blocked' | 'errored' | 'working' | 'idle' | 'aborted' | 'question' | 'unknown'
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
    : h.status === 'question' ? 'WAITING ON A QUESTION: it asked something in Discord and is paused until it is answered.'
    : h.awaitingReply ? 'WAITING: a prompt was sent and has no reply yet.'
    : 'IDLE: finished its last turn.'
  return `${head} Last activity ${ago}. Model ${h.model ?? '?'}${h.contextTokens ? `, context ~${Math.round(h.contextTokens / 1000)}k tokens` : ''}.`
}

// ── recovery analysis via the OpenCode server API ──
import { execFileSync } from 'node:child_process'
export type ApiMsg = { info: { id: string; role: string; error?: { name?: string }; modelID?: string; providerID?: string; time?: { created?: number; completed?: number } }; parts: Array<{ type: string; text?: string; tool?: string; state?: { status?: string; input?: { filePath?: string } } }> }
const baseBySession = new Map<string, string>()
/** Kimaki's own discovery endpoint on the hrana lock port (hrana-server.ts `/kimaki/opencode-port`). */
export async function kimakiOpencodeServer(fetchImpl: typeof fetch = fetch, port = kimakiLockPort()): Promise<string | null> {
  const r = await fetchImpl(`http://127.0.0.1:${port}/kimaki/opencode-port`, { signal: AbortSignal.timeout(2000) }).catch(() => null)
  if (!r?.ok) return null
  const j = (await r.json().catch(() => null)) as { port?: unknown } | null
  return typeof j?.port === 'number' ? `http://127.0.0.1:${j.port}` : null
}
/** Fallback when the bot is down or predates the endpoint: every listening opencode process. */
function scannedServers(): string[] {
  let out = ''
  try { out = execFileSync('ss', ['-ltnpH'], { encoding: 'utf-8' }) } catch { return [] }
  return [...out.matchAll(/127\.0\.0\.1:(\d+)\s.*"opencode"/g)].map((m) => `http://127.0.0.1:${m[1]}`)
}
const ok = async (url: string): Promise<boolean> => fetch(url, { signal: AbortSignal.timeout(2500) }).then((r) => r.ok).catch(() => false)
/** The opencode server that serves this session: cached, then Kimaki's, then a port scan; cached per session. */
export async function opencodeBase(sessionId?: string): Promise<string | null> {
  const dir = sessionId ? await sessionDir(sessionId) : null
  const probe = (b: string): string => sessionId ? `${b}/session/${sessionId}${dir ? `?directory=${encodeURIComponent(dir)}` : ''}` : `${b}/doc`
  const tried = new Set<string>()
  const hit = async (b: string | null | undefined): Promise<boolean> => {
    if (!b || tried.has(b)) return false
    tried.add(b)
    if (!(await ok(probe(b)))) return false
    if (sessionId) baseBySession.set(sessionId, b)
    return true
  }
  const cached = sessionId ? baseBySession.get(sessionId) : undefined
  if (await hit(cached)) return cached!
  const kimaki = await kimakiOpencodeServer()
  if (await hit(kimaki)) return kimaki
  for (const b of scannedServers()) if (await hit(b)) return b
  return null
}
export async function sessionDir(sessionId: string): Promise<string | null> {
  const db = await open()
  if (!db) return null
  try { return String(db.prepare('SELECT directory FROM session WHERE id = ?').all(sessionId)[0]?.directory ?? '') || null } catch { return null } finally { db.close() }
}
export async function listMessages(sessionId: string, limit = 60): Promise<ApiMsg[] | null> {
  const base = await opencodeBase(sessionId); const dir = await sessionDir(sessionId)
  if (!base || !dir) return null
  const r = await fetch(`${base}/session/${sessionId}/message?directory=${encodeURIComponent(dir)}&limit=${limit}`, { signal: AbortSignal.timeout(15000) }).catch(() => null)
  return r?.ok ? ((await r.json()) as ApiMsg[]) : null
}

export type StuckRun = {
  failed: number                // failed assistant turns since the owner's last request
  errors: string[]
  revertPoint: string | null    // user message that opened the turn holding the first failure
  removed: number
  hasPatches: boolean           // removed range carries patches or completed work - do not revert
  partialFiles: string[]        // write/edit targets inside failed turns (content may be truncated)
  lastGoodText: string          // facts from the last clean turn before the revert point
  briefTask: string             // the owner's request (never a guard brief)
}
export const GUARD_MARK = '[guard] '
const GUARD_TEXT = /^(\[guard\]|Your previous replies were cut off|Your previous reply was cut off|Your last \d+ turn|Your previous turn failed)/
const userText = (m: ApiMsg): string => m.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n').trim()
export const isGuardBrief = (m: ApiMsg, sent?: Set<string>): boolean => m.info.role === 'user' && (!!sent?.has(m.info.id) || GUARD_TEXT.test(userText(m)))
const isFail = (m: ApiMsg): boolean => m.info.role === 'assistant' && !!m.info.error && m.info.error.name !== 'MessageAbortedError'
/** Complete fact lines only (numbers, file or test names), at most 5 - never an unfinished sentence. */
export function factsOnly(text: string): string {
  const t = text.trim()
  const segs = t.split(/\n+|(?<=[.!?])\s+/).map((l) => l.trim()).filter(Boolean)
  if (segs.length && !/[.!?)`:]$/.test(t)) segs.pop() // the reply was cut mid-sentence
  return segs.filter((l) => /[.!?)`:]$/.test(l) || /^[-*\d]|=|:/.test(l)).filter((l) => /\d|\w+\.(sol|ts|tsx|js|mjs|py|rs|go|md|json|toml|yml|yaml)\b|\btest\w*/i.test(l)).slice(-5).join('\n').slice(0, 500)
}
/** Assistant turn that did real work: a completed tool call or a clean text reply. */
export const didWork = (m: ApiMsg): boolean => m.info.role === 'assistant' && !m.info.error && (m.parts.some((p) => p.type === 'tool' && p.state?.status === 'completed') || m.parts.some((p) => p.type === 'text' && (p.text?.trim().length ?? 0) > 0))
/** msgs oldest-first. Scoped to the episode: everything after the owner's last request. */
export function stuckRun(msgs: ApiMsg[], sent?: Set<string>): StuckRun | null {
  const lastNonUser = [...msgs].reverse().find((m) => m.info.role !== 'user' && m.info.error?.name !== 'MessageAbortedError')
  if (!lastNonUser || !isFail(lastNonUser)) return null
  let owner = -1
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].info.role === 'user' && !isGuardBrief(msgs[i], sent)) { owner = i; break }
  const firstFail = msgs.findIndex((m, i) => i > owner && isFail(m))
  if (firstFail < 0) return null
  // never revert past successful work: start after the LAST good step before the latest failure
  let lastWork = -1
  for (let i = msgs.length - 1; i > owner; i--) if (didWork(msgs[i])) { lastWork = i; break }
  const from = Math.max(owner, lastWork)
  let rp = -1
  for (let i = from + 1; i < msgs.length; i++) if (msgs[i].info.role === 'user') { rp = i; break }
  if (lastWork < 0) { rp = firstFail; while (rp >= 0 && msgs[rp].info.role !== 'user') rp-- }
  const removed = rp >= 0 ? msgs.slice(rp) : []
  const fails = msgs.slice(Math.max(owner, lastWork) + 1).filter(isFail)
  const good = msgs.slice(0, rp >= 0 ? rp : msgs.length).reverse().find((m) => m.info.role === 'assistant' && !m.info.error && m.parts.some((p) => p.type === 'text' && p.text?.trim()))
  return {
    failed: fails.length,
    errors: [...new Set(fails.map((m) => m.info.error?.name ?? '?'))],
    revertPoint: rp >= 0 ? msgs[rp].info.id : null,
    removed: removed.length,
    hasPatches: removed.some((m) => m.parts.some((p) => p.type === 'patch') || didWork(m)),
    partialFiles: [...new Set(fails.flatMap((m) => m.parts.filter((p) => p.type === 'tool' && /write|edit/i.test(p.tool ?? '')).map((p) => p.state?.input?.filePath ?? '').filter(Boolean)))],
    lastGoodText: good ? factsOnly(good.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n')) : '',
    briefTask: owner >= 0 ? userText(msgs[owner]).slice(0, 1500) : '',
  }
}
