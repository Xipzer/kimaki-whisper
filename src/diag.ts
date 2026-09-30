// Diagnostics: the single structured event stream everything reports into.
// JSONL, one file per day, pruned after 14 days. Every subsystem funnels
// through diag() so an incident can be reconstructed from one source.
import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './config.js'

function diagDir(): string {
  const d = path.join(configDir(), 'diagnostics')
  fs.mkdirSync(d, { recursive: true })
  return d
}

type DiagListener = (ev: string, data: Record<string, unknown>, ts: number) => void
const listeners: DiagListener[] = []
/** Subscribe to the live event stream (activity mirror, etc). Listener errors never propagate. */
export function onDiag(fn: DiagListener): void { listeners.push(fn) }

export function diag(ev: string, data: Record<string, unknown> = {}): void {
  const ts = Date.now()
  for (const l of listeners) { try { l(ev, data, ts) } catch {} }
  try {
    const day = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(path.join(diagDir(), `${day}.jsonl`), JSON.stringify({ ts: Date.now(), ev, ...data }) + '\n')
  } catch {}
}

export function pruneDiagnostics(days = 14): void {
  try {
    const cutoff = Date.now() - days * 86400000
    for (const f of fs.readdirSync(diagDir())) {
      const st = fs.statSync(path.join(diagDir(), f))
      if (st.mtimeMs < cutoff) fs.unlinkSync(path.join(diagDir(), f))
    }
  } catch {}
}
