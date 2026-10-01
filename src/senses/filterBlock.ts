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
  return `STUCK ON CONTENT FILTER: its last ${s.consecutive > 1 ? `${s.consecutive} replies were` : 'reply was'} blocked by the provider's content filter (${ago})${s.nudgedSince ? ', a nudge was sent after it and has not been answered yet' : ''}. The thread is NOT working - it is silent because of the block. Re-sending the same wording will be blocked again: reword away from the trigger words, or switch the thread to the local model (switch_thread_model local), which has no filter.`
}
