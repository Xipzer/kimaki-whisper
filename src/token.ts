// Two tokens, two roles:
//   nodeToken  - THIS device's Kimaki bot. Always the local Kimaki DB
//                (~/.kimaki/discord-sessions.db) unless node.json overrides.
//                Never cached in config.json: config travels between nodes.
//   wendyToken - the home bot that IS Wendy. Explicit only (env WENDY_BOT_TOKEN
//                / KIMAKI_BOT_TOKEN, or config wendyToken / legacy botToken).
//                Opened only on the node whose role is primary.
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { loadConfig, log } from './config.js'
import { nodeIdentity } from './node/identity.js'

async function readTokenFromKimakiDb(): Promise<string | null> {
  const dbPath = path.join(os.homedir(), '.kimaki', 'discord-sessions.db')
  if (!fs.existsSync(dbPath)) return null
  try {
    // Dynamic import: node:sqlite is experimental - tolerate absence.
    const sqlite = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
        prepare(sql: string): { get(): Record<string, unknown> | undefined }
        close(): void
      }
    }
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare('SELECT token FROM bot_tokens LIMIT 1').get()
      const token = typeof row?.token === 'string' ? row.token : null
      return token
    } finally {
      db.close()
    }
  } catch (e) {
    log('note: could not read Kimaki DB for bot token:', (e as Error).message)
    return null
  }
}

export async function resolveNodeToken(): Promise<string | null> {
  const n = nodeIdentity() as { nodeToken?: string }
  if (n.nodeToken) return n.nodeToken
  const cfg = loadConfig() as { nodeToken?: string; serveBotToken?: string }
  return cfg.nodeToken ?? cfg.serveBotToken ?? (await readTokenFromKimakiDb())
}

export function resolveWendyToken(): string | null {
  const cfg = loadConfig() as { wendyToken?: string; botToken?: string }
  return process.env.WENDY_BOT_TOKEN ?? process.env.KIMAKI_BOT_TOKEN ?? cfg.wendyToken ?? cfg.botToken ?? null
}
