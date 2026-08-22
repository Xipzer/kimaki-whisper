// Sidecar config at ~/.kimaki-whisper/config.json — deliberately its own dir so
// we never write into Kimaki's data (loose coupling by design).
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

export interface SidecarConfig {
  /** Discord bot token (same bot as Kimaki). Stored after first resolution. */
  botToken?: string
  /** Built-in local model tier id (fast/balanced/accurate/best). Unset = not configured. */
  model?: string
  /** Advanced: proxy transcription to an external OpenAI-compatible backend instead of the built-in model. */
  backendUrl?: string
  /** Port for the local OpenAI-compatible endpoint Kimaki points at. */
  port?: number
  /** Command-name prefix override (default "whisper"). Lets tests avoid clashing with a bot that already handles /whisper-*. */
  commandPrefix?: string
  /** Wendy voice mode: OpenAI-compatible LLM endpoint for the concierge brain (e.g. llama.cpp on a LAN GPU box). */
  brainUrl?: string
  /** Wendy voice mode: Discord user id to follow into voice channels. */
  ownerId?: string
  /** speaches base URL (STT + Kokoro TTS). Default http://localhost:8000 */
  speachesUrl?: string
  /** Optional shell command to wake/start the brain endpoint when unreachable (e.g. an ssh command). */
  brainWakeCommand?: string
  /** Kokoro voice id (default af_heart). */
  ttsVoice?: string
}

export const DEFAULT_PORT = 7071

export function configDir(): string {
  return path.join(os.homedir(), '.kimaki-whisper')
}

function configPath(): string {
  return path.join(configDir(), 'config.json')
}

export function loadConfig(): SidecarConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as SidecarConfig
  } catch {
    return {}
  }
}

export function saveConfig(patch: Partial<SidecarConfig>): SidecarConfig {
  const next = { ...loadConfig(), ...patch }
  fs.mkdirSync(configDir(), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n')
  return next
}

export function log(...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}]`, ...args)
}
