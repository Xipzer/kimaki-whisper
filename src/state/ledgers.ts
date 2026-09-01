// Dispatch memory: what she sent where, whether it finished, which ids she
// has actually verified, and what she sent recently. Deterministic ground
// truth that outlives restarts - the greeting and the tool gate read this,
// never the model's recollection.
import fs from 'node:fs'
import path from 'node:path'
import { isSessionId } from '../brain/guards.js'

export type DispatchEntry = { label: string; at: number; done?: number }

export class DispatchLedger {
  private status = new Map<string, DispatchEntry>()
  private verified = new Map<string, number>()
  private recent: { key: string; ts: number; tool: string }[] = []
  private ever = new Set<string>()
  private file: string
  private now: () => number
  constructor(file: string, now: () => number = Date.now) { this.file = file; this.now = now }

  // ── persistence ─────────────────────────────────────────────
  load(): void {
    try {
      for (const [k, v] of JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Array<[string, DispatchEntry]>) this.status.set(k, v)
    } catch {}
  }
  save(): void {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify([...this.status.entries()])) } catch {}
  }

  // ── dispatched work ─────────────────────────────────────────
  /** Record a dispatch. Re-arming after a restart keeps the original start time. */
  record(id: string, label: string, reArmed = false): void {
    if (!id) return
    this.ever.add(id)
    if (!reArmed || !this.status.has(id)) this.status.set(id, { label, at: this.status.get(id)?.at ?? this.now() })
    this.save()
  }
  markDone(id: string): void {
    const e = this.status.get(id)
    if (e) { e.done = this.now(); this.save() }
  }
  has(id: string): boolean { return this.status.has(id) }
  everDispatched(id: string): boolean { return this.ever.has(id) }
  /** Unfinished dispatches younger than maxAgeMs - what to re-arm on boot. */
  unfinished(maxAgeMs: number): Array<[string, DispatchEntry]> {
    return [...this.status.entries()].filter(([, v]) => !v.done && this.now() - v.at < maxAgeMs)
  }
  /** The sentence injected into greeting/status turns. Empty when nothing recent. */
  groundTruth(windowMs = 4 * 3600000): string {
    const now = this.now()
    const recent = [...this.status.values()].filter((v) => now - v.at < windowMs)
    if (!recent.length) return ''
    const done = recent.filter((v) => v.done).map((v) => `"${v.label}" FINISHED ${Math.max(1, Math.round((now - (v.done ?? now)) / 60000))}m ago`)
    const running = recent.filter((v) => !v.done).map((v) => `"${v.label}" running ${Math.round((now - v.at) / 60000)}m`)
    return ` GROUND TRUTH on dispatched work (TRUST THIS over your memory - never claim something is still running unless it is in the running list, and never promise to announce work listed as FINISHED - he has likely already read it): ${done.length ? `FINISHED: ${done.join('; ')}. ` : ''}${running.length ? `RUNNING: ${running.join('; ')}.` : ''}`
  }

  // ── verified ids: proven real by a tool result ───────────────
  markVerified(id: string): void { if (isSessionId(id)) this.verified.set(id, this.now()) }
  isVerified(id: string, withinMs = 10 * 60000): boolean {
    const t = this.verified.get(id)
    return t !== undefined && this.now() - t <= withinMs
  }

  // ── recent sends: duplicate detection + claim backing ────────
  recordSend(key: string, tool: string): void {
    this.recent.push({ key, ts: this.now(), tool })
    if (this.recent.length > 40) this.recent.splice(0, this.recent.length - 40)
  }
  /** Seconds since an identical send, or null if none within the window. */
  duplicateAgeS(key: string, withinMs = 10 * 60000): number | null {
    const d = this.recent.find((x) => x.key === key && this.now() - x.ts < withinMs)
    return d ? Math.round((this.now() - d.ts) / 1000) : null
  }
  sentRecently(withinMs = 10 * 60000): boolean { return this.recent.some((d) => this.now() - d.ts < withinMs) }
}
