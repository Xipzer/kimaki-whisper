// One place to ask "what state is this session in". Prefers Kimaki's own
// `kimaki session status <id> --json` (planned upstream: idle|working|blocked|
// errored|question + lastError) once the installed CLI lists it, and falls back
// to the indexed OpenCode DB lookup (threadHealth) otherwise.
import { helpListsStatus, parseStatusJson, type StatusReport } from '../kimaki/api.js'
import type { KimakiRunner } from '../kimaki/run.js'
import { stateFrom, type FilterState, type ThreadHealth } from './filterBlock.js'

export type SessionState = { source: 'kimaki' | 'db'; health: ThreadHealth; report: StatusReport | null }
type Deps = { run: KimakiRunner; dbHealth: (id: string) => Promise<ThreadHealth | null>; now?: () => number; reprobeMs?: number; maxFailures?: number }

const STATUS_FROM_REPORT: Record<StatusReport['state'], ThreadHealth['status']> = { idle: 'idle', working: 'working', blocked: 'blocked', errored: 'errored', question: 'question' }

export function filterFromReport(r: StatusReport, base?: FilterState): FilterState {
  if (r.state !== 'blocked') return base ?? stateFrom([])
  return { blocked: true, nudgedSince: r.awaitingReply ?? base?.nudgedSince ?? false, consecutive: Math.max(1, base?.consecutive ?? 1), lastBlockAt: r.lastError?.at ?? base?.lastBlockAt ?? r.lastActivityAt, totalBlocks: Math.max(1, base?.totalBlocks ?? 1) }
}
/** Kimaki's report is authoritative for state; the DB (when present) fills in detail it does not carry. */
export function healthFromReport(r: StatusReport, db: ThreadHealth | null): ThreadHealth {
  return {
    status: STATUS_FROM_REPORT[r.state],
    lastActivityAt: r.lastActivityAt ?? db?.lastActivityAt ?? null,
    model: r.model ?? db?.model ?? null,
    contextTokens: r.contextTokens ?? db?.contextTokens ?? null,
    lastError: r.lastError ? `${r.lastError.name}: ${r.lastError.message}`.slice(0, 200) : (r.state === 'errored' ? db?.lastError ?? null : null),
    filter: filterFromReport(r, db?.filter),
    awaitingReply: r.awaitingReply ?? db?.awaitingReply ?? false,
    lastOkAt: db?.lastOkAt ?? null,
  }
}

export function createStatusAdapter(d: Deps) {
  const now = d.now ?? Date.now
  const reprobeMs = d.reprobeMs ?? 6 * 3600000
  const maxFailures = d.maxFailures ?? 3
  let supported: boolean | null = null
  let probedAt = 0
  let probing: Promise<boolean> | null = null
  let failures = 0
  // `session --help` lists subcommands without running anything (an unknown
  // subcommand would also just print help, but this never executes one).
  const probe = (): Promise<boolean> => probing ??= d.run(['session', '--help'], 20000, 20000).then((r) => {
    supported = helpListsStatus(r.out); probedAt = now(); failures = 0
    return supported
  }).finally(() => { probing = null })

  async function isSupported(): Promise<boolean> {
    if (supported === null || now() - probedAt > reprobeMs) return probe()
    return supported
  }

  async function viaKimaki(id: string): Promise<StatusReport | null> {
    if (!(await isSupported())) return null
    const r = await d.run(['session', 'status', id, '--json'], 15000, 20000)
    const rep = r.code === 0 || r.code === null ? parseStatusJson(r.out) : null
    if (rep) { failures = 0; return rep }
    // repeated failures: treat as unsupported until the next re-probe
    if (++failures >= maxFailures) { supported = false; probedAt = now() }
    return null
  }

  return {
    isSupported,
    async status(id: string): Promise<SessionState | null> {
      const [rep, db] = await Promise.all([viaKimaki(id), d.dbHealth(id)])
      if (rep) return { source: 'kimaki', health: healthFromReport(rep, db), report: rep }
      return db ? { source: 'db', health: db, report: null } : null
    },
  }
}
export type StatusAdapter = ReturnType<typeof createStatusAdapter>
