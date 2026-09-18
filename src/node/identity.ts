// Node identity: WHICH machine Wendy is running on, and therefore which
// Kimaki, Discord(s) and projects are her eyes right now. Her memory travels
// between nodes; her view of threads does not - it comes from the local
// Kimaki. Telling her the place changed is what stops her acting on a map
// from another machine.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { configDir, log } from '../config.js'

export type NodeIdentity = {
  name: string            // printer | projector | mac
  role: 'primary' | 'standby'
  label: string           // human description
  brainUrl?: string
  speachesUrl?: string
  port?: number
  brainWakeCommand?: string
  brainStartCommand?: string
  brainStopCommand?: string
  peers?: string[]        // ssh aliases of the other nodes (for sync)
}

let cached: NodeIdentity | null = null
export function nodeIdentity(): NodeIdentity {
  if (cached) return cached
  try {
    const j = JSON.parse(fs.readFileSync(path.join(configDir(), 'node.json'), 'utf-8')) as Partial<NodeIdentity>
    cached = { name: j.name ?? os.hostname().toLowerCase(), role: j.role ?? 'standby', label: j.label ?? os.hostname(), ...j }
  } catch {
    cached = { name: os.hostname().toLowerCase(), role: 'primary', label: os.hostname() }
  }
  return cached
}

/** Sentence injected into every system prompt so she knows where she is. */
export function nodeBlock(projectCount: number, guildNames: string[]): string {
  const n = nodeIdentity()
  const where = n.role === 'primary'
    ? `You are running on ${n.label} - the owner's PRIMARY workspace.`
    : `You are running on ${n.label} - a ${n.role.toUpperCase()} node. The primary (his main workspace) is down or under maintenance; you are covering. You remember everything from the primary, but you can only SEE and ACT ON the threads and projects that exist on THIS machine's Kimaki.`
  const eyes = `Your eyes here: this machine's Kimaki with ${projectCount} project(s), reachable Discord server(s): ${guildNames.join(', ') || 'none'}. Threads you remember from another machine are NOT reachable from here - say so plainly if asked about one, never pretend to check it.`
  return `\n\nWHERE YOU ARE: ${where} ${eyes}`
}

export function logNode(): void {
  const n = nodeIdentity()
  log(`wendy: node identity - ${n.name} (${n.role}) brain=${n.brainUrl ?? 'config'} speaches=${n.speachesUrl ?? 'config'}`)
}
