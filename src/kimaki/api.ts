// Pure parsers for kimaki CLI output (no I/O): session list/search JSON,
// send outcomes, and the (future) `kimaki session status --json` payload.
import type { KimakiRun } from './run.js'

/** kimaki may still wrap --json output in log lines (which contain brackets); find the JSON value. */
export function extractJson(raw: string, open: '[' | '{' = '['): unknown {
  const t = raw.trim()
  try { return JSON.parse(t) } catch {}
  const close = open === '[' ? ']' : '}'
  const end = t.lastIndexOf(close)
  let from = 0
  for (let i = 0; i < 50 && end !== -1; i++) {
    const start = t.indexOf(open, from)
    if (start === -1 || start >= end) break
    try { return JSON.parse(t.slice(start, end + 1)) } catch {}
    from = start + 1
  }
  return undefined
}
export const extractJsonArray = (raw: string): unknown[] => { const v = extractJson(raw, '['); return Array.isArray(v) ? v : [] }

export type SessionStatus = 'idle' | 'busy' | 'showing-question'
export type IndexEntry = { id: string; title: string; dir: string; updated?: number; threadId?: string; status?: SessionStatus; model?: string; tokens?: number }
type ListRow = { id?: unknown; title?: unknown; directory?: unknown; updated?: unknown; time?: { updated?: unknown }; threadId?: unknown; status?: unknown; model?: unknown; tokens?: unknown }

function toEntry(r: ListRow, dirFallback?: string): IndexEntry | null {
  const dir = typeof r.directory === 'string' && r.directory ? r.directory : dirFallback
  if (typeof r.id !== 'string' || !r.id || typeof r.title !== 'string' || !r.title || !dir) return null
  const updRaw = r.time?.updated ?? r.updated
  const upd = typeof updRaw === 'string' ? Date.parse(updRaw) : Number(updRaw)
  const e: IndexEntry = { id: r.id, title: r.title, dir, updated: Number.isFinite(upd) ? upd : 0 }
  if (typeof r.threadId === 'string' && r.threadId && r.threadId !== 'None') e.threadId = r.threadId
  if (r.status === 'idle' || r.status === 'busy' || r.status === 'showing-question') e.status = r.status
  if (typeof r.model === 'string' && r.model) e.model = r.model
  if (typeof r.tokens === 'number') e.tokens = r.tokens
  return e
}

/** `session list --all --json` → index entries; null when the output is unusable (caller falls back to the per-project walk). */
export function parseAllSessionList(raw: string): IndexEntry[] | null {
  if (raw.startsWith('ERROR')) return null
  const rows = extractJson(raw, '[')
  if (!Array.isArray(rows)) return null
  if (!rows.length) return []
  // --all needs session.directory to attribute each row to a project: without it the data is not equivalent
  if (!rows.every((r) => r && typeof (r as ListRow).directory === 'string')) return null
  const seen = new Set<string>()
  return rows.map((r) => toEntry(r as ListRow)).filter((e): e is IndexEntry => !!e && !seen.has(e.id) && !!seen.add(e.id))
}
/** `session list --project <dir> --json` rows (older CLIs may omit `directory`). */
export const parseProjectSessionList = (raw: string, dir: string): IndexEntry[] =>
  extractJsonArray(raw).map((r) => toEntry(r as ListRow, dir)).filter((e): e is IndexEntry => !!e)

export const DEFAULT_SEARCH_DAYS = 14
export function searchArgs(query: string, days?: number, limit = 8): string[] {
  const d = Number.isFinite(days) && days! >= 0 ? Math.floor(days!) : DEFAULT_SEARCH_DAYS
  return ['session', 'search', query, '--all', '--days', String(d), '--limit', String(limit), '--json']
}
type SearchJson = { query?: string; days?: number; scannedSessions?: number; matches?: Array<{ id?: string; title?: string; directory?: string; updated?: string; threadId?: string | null; snippets?: string[] }> }
/** Format `session search --json`. Never returns '' - an empty result says so, with its scope. */
export function formatSearch(raw: string, query: string): string {
  if (raw.startsWith('ERROR')) return raw
  const j = extractJson(raw, '{') as SearchJson | undefined
  if (!j || !Array.isArray(j.matches)) return raw.trim() || `ERROR: search for "${query}" returned no output`
  const scope = `${j.scannedSessions ?? '?'} sessions scanned, ${j.days === 0 ? 'all time' : `last ${j.days ?? DEFAULT_SEARCH_DAYS} days`}, all projects`
  if (!j.matches.length) return `No matches for "${query}" (${scope}).${j.days === 0 ? '' : ' Older threads: call search_sessions again with days: 0 (all time, slow).'}`
  return [`${j.matches.length} match(es) for "${query}" (${scope}):`, ...j.matches.map((m) => {
    const proj = (m.directory ?? '').split('/').filter(Boolean).pop() ?? '?'
    const snip = (m.snippets ?? []).slice(0, 2).map((s) => `\n    - ${s.replace(/\s+/g, ' ').slice(0, 200)}`).join('')
    return `- ${m.title ?? 'Untitled'} - session ${m.id} (project: ${proj}, updated ${(m.updated ?? '').slice(0, 16)}${m.threadId ? `, thread ${m.threadId}` : ''})${snip}`
  })].join('\n')
}

export type SendStatus = 'delivered' | 'failed' | 'unconfirmed'
export type SendOutcome = { status: SendStatus; sessionId?: string; url?: string; detail: string }
const DISCORD_URL = /https:\/\/discord\.com\/channels\/\d+\/\d+(?:\/\d+)?/
/** What a `kimaki send` run actually achieved. Kimaki prints the Discord URL only after the message is posted. */
export function sendOutcome(r: KimakiRun): SendOutcome {
  const text = `${r.head}\n${r.out}`
  const url = text.match(DISCORD_URL)?.[0]
  const sessionId = text.match(/\bSession: (ses_\w{10,})/)?.[1] ?? text.match(/\bses_\w{10,}\b/)?.[0]
  if (url) return { status: 'delivered', url, sessionId, detail: r.timedOut ? 'posted; reply still pending' : 'posted' }
  if (r.out.startsWith('ERROR')) return { status: 'failed', detail: r.out.replace(/^ERROR:\s*/, '').slice(0, 240) }
  if (r.timedOut) return { status: 'unconfirmed', sessionId, detail: 'kimaki did not confirm before the timeout' }
  if (r.code !== 0) return { status: 'failed', detail: (r.out.replace(/[│┌└◇◆─╮╯╭╰]+/g, ' ').replace(/\s+/g, ' ').trim() || `kimaki exited with code ${r.code}`).slice(0, 240) }
  return { status: 'delivered', sessionId, detail: 'kimaki exited cleanly' }
}

// Future `kimaki session status <id> --json`: states idle|working|blocked|errored|question.
export type KimakiState = 'idle' | 'working' | 'blocked' | 'errored' | 'question'
export type StatusReport = { state: KimakiState; lastError: { name: string; message: string; at: number | null } | null; model: string | null; contextTokens: number | null; lastActivityAt: number | null; awaitingReply: boolean | null }
const STATES: KimakiState[] = ['idle', 'working', 'blocked', 'errored', 'question']
const ms = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null
export function parseStatusJson(raw: string): StatusReport | null {
  const j = extractJson(raw, '{') as Record<string, unknown> | undefined
  if (!j || typeof j !== 'object') return null
  const s = String(j.status ?? j.state ?? '')
  const state = (s === 'busy' ? 'working' : s === 'showing-question' ? 'question' : s) as KimakiState
  if (!STATES.includes(state)) return null
  const le = j.lastError
  const lastError = !le ? null
    : typeof le === 'string' ? { name: le.split(':')[0], message: le, at: null }
    : { name: String((le as Record<string, unknown>).name ?? 'Error'), message: String((le as Record<string, unknown>).message ?? ''), at: ms((le as Record<string, unknown>).at) }
  return {
    state, lastError,
    model: typeof j.model === 'string' ? j.model : null,
    contextTokens: typeof j.contextTokens === 'number' ? j.contextTokens : null,
    lastActivityAt: ms(j.lastActivityAt),
    awaitingReply: typeof j.awaitingReply === 'boolean' ? j.awaitingReply : null,
  }
}
/** Does `kimaki session --help` list a `session status` command? */
export const helpListsStatus = (help: string): boolean => /^\s*(?:kimaki )?session status\b/m.test(help)

/** Hrana lock port, as kimaki derives it for the default data dir (config.ts getLockPort). */
export function kimakiLockPort(env: Record<string, string | undefined> = process.env, configured?: number): number {
  const p = Number.parseInt(env.KIMAKI_LOCK_PORT ?? '', 10)
  if (Number.isInteger(p) && p >= 1 && p <= 65535) return p
  return configured && Number.isInteger(configured) ? configured : 29988
}
