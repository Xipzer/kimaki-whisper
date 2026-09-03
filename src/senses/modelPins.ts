// Model pins: keep a kimaki thread on the model the owner chose.
// Overrides live in kimaki's session_models table and are reset by any
// `kimaki send` that omits --model (which is how threads talk to each other).
// A pin re-asserts the row within seconds of it flipping, and reports it.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { diag } from '../diag.js'
import { log } from '../config.js'

export type Pin = { sessionId: string; model: string; label: string; at: number; flips: number; lastFlip?: number; lastSeen?: string }

const DB = path.join(os.homedir(), '.kimaki', 'discord-sessions.db')
const q = (sql: string): string => {
  try { return execFileSync('sqlite3', [DB, sql], { timeout: 5000 }).toString().trim() } catch (e) { return `ERROR: ${String((e as Error).message).slice(0, 120)}` }
}
const esc = (s: string): string => s.replace(/'/g, "''")

export function currentModel(sessionId: string): string | null {
  const out = q(`SELECT model_id FROM session_models WHERE session_id='${esc(sessionId)}'`)
  return out.startsWith('ERROR') ? null : (out || null)
}
export function applyModel(sessionId: string, model: string): boolean {
  const out = q(`INSERT INTO session_models(session_id, model_id) VALUES('${esc(sessionId)}','${esc(model)}') ON CONFLICT(session_id) DO UPDATE SET model_id=excluded.model_id, created_at=CURRENT_TIMESTAMP`)
  return !out.startsWith('ERROR')
}

export class ModelPins {
  private pins = new Map<string, Pin>()
  private file: string
  constructor(dir: string, private announce: (line: string) => void) {
    this.file = path.join(dir, 'model-pins.json')
    try { for (const p of JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Pin[]) this.pins.set(p.sessionId, p) } catch {}
  }
  private save(): void { try { fs.writeFileSync(this.file, JSON.stringify([...this.pins.values()])) } catch {} }

  pin(sessionId: string, model: string, label: string): string {
    const before = currentModel(sessionId)
    const ok = applyModel(sessionId, model)
    if (!ok) return 'ERROR: could not write the model override (kimaki DB unavailable)'
    this.pins.set(sessionId, { sessionId, model, label, at: Date.now(), flips: 0, lastSeen: model })
    this.save()
    diag('model_pinned', { sessionId, model, before })
    return `pinned "${label}" to ${model}${before && before !== model ? ` (was ${before})` : ''}. I re-assert it within seconds whenever anything resets it, and I will tell you when that happens.`
  }
  unpin(sessionId: string): string {
    const p = this.pins.get(sessionId)
    if (!p) return 'no pin on that thread'
    this.pins.delete(sessionId); this.save()
    diag('model_unpinned', { sessionId })
    return `unpinned "${p.label}" - kimaki will manage its model again`
  }
  pinned(sessionId: string): Pin | undefined { return this.pins.get(sessionId) }
  status(): string {
    if (!this.pins.size) return 'no model pins active'
    return [...this.pins.values()].map((p) => `"${p.label}" -> ${p.model} (pinned ${Math.round((Date.now() - p.at) / 60000)}m ago, re-asserted ${p.flips}x${p.lastFlip ? `, last ${Math.round((Date.now() - p.lastFlip) / 60000)}m ago` : ''})`).join('\n')
  }

  /** One sweep: re-assert every pin whose row drifted. */
  sweep(): void {
    for (const p of this.pins.values()) {
      const now = currentModel(p.sessionId)
      if (now === p.model) { p.lastSeen = now; continue }
      const ok = applyModel(p.sessionId, p.model)
      p.flips++; p.lastFlip = Date.now(); p.lastSeen = now ?? '(none)'
      this.save()
      diag('model_pin_reasserted', { sessionId: p.sessionId, from: now, to: p.model, ok, flips: p.flips })
      log(`wendy: model pin - "${p.label}" flipped to ${now ?? 'none'}, re-asserted ${p.model}`)
      // Report the first few and then only every 5th - a thread that flips
      // every message would otherwise flood him.
      if (p.flips <= 3 || p.flips % 5 === 0) this.announce(`[MED] "${p.label}" got reset to ${now ?? 'the global default'} - I re-pinned it to ${p.model} (${p.flips}${p.flips === 1 ? 'st' : p.flips === 2 ? 'nd' : p.flips === 3 ? 'rd' : 'th'} time).`)
    }
  }
}
