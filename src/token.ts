// Bot-token resolution ladder (the sidecar uses the SAME bot as Kimaki):
//   1. KIMAKI_BOT_TOKEN env
//   2. our own config.json (persisted from a previous resolution)
//   3. Kimaki's sqlite DB (~/.kimaki/discord-sessions.db, bot_tokens table)
//      via node:sqlite when available (Node >=22.5)
//   4. fail with instructions (`kimaki-whisper setup --token <token>`)
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { loadConfig, saveConfig, log } from './config.js'

async function readTokenFromKimakiDb(): Promise<string | null> {
  const dbPath = path.join(os.homedir(), '.kimaki', 'discord-sessions.db')
  if (!fs.existsSync(dbPath)) return null
  try {
    // Dynamic import: node:sqlite is experimental — tolerate absence.
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

export async function resolveBotToken(): Promise<string | null> {
  const fromEnv = process.env.KIMAKI_BOT_TOKEN
  if (fromEnv) return fromEnv

  const cfg = loadConfig()
  if (cfg.botToken) return cfg.botToken

  const fromDb = await readTokenFromKimakiDb()
  if (fromDb) {
    saveConfig({ botToken: fromDb })
    log('bot token read from Kimaki DB and cached in sidecar config')
    return fromDb
  }
  return null
}
