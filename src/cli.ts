#!/usr/bin/env node
// kimaki-whisper — local voice-note transcription sidecar for Kimaki.
//   kimaki-whisper                     run the sidecar (gateway + endpoint)
//   kimaki-whisper setup [--model auto|fast|balanced|accurate|best]
//                        [--backend-url <url>] [--token <bot token>]
//   kimaki-whisper status
import { loadConfig, saveConfig, DEFAULT_PORT, log } from './config.js'
import { resolveBotToken } from './token.js'
import { recommendTier, tierById, installRuntime, getPipeline } from './transcribe/local-onnx.js'
import { startServer } from './server.js'
import { startDiscord } from './discord.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const cmd = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'run'

async function main(): Promise<void> {
  if (cmd === 'setup') {
    const token = arg('token')
    if (token) {
      saveConfig({ botToken: token })
      log('bot token saved')
    }
    const backendUrl = arg('backend-url')
    if (backendUrl) {
      saveConfig({ backendUrl, model: undefined })
      log(`backend set: ${backendUrl}`)
      return
    }
    const modelArg = arg('model')
    if (modelArg) {
      const tier = modelArg === 'auto' ? recommendTier().tier : tierById(modelArg)
      if (!tier) {
        log(`unknown model: ${modelArg}`)
        process.exit(1)
      }
      log(`setting up ${tier.label} (${tier.approxSize})...`)
      const inst = await installRuntime()
      if (inst instanceof Error) { log(inst.message); process.exit(1) }
      const pipe = await getPipeline({ hfModel: tier.hfModel, onProgress: (m) => log(' ', m) })
      if (pipe instanceof Error) { log(pipe.message); process.exit(1) }
      saveConfig({ model: tier.id, backendUrl: undefined })
      log(`done. model: ${tier.id}`)
    }
    if (!token && !backendUrl && !modelArg) {
      const rec = recommendTier()
      log(`recommended for this machine: ${rec.tier.label} (${rec.tier.approxSize}) — ${rec.reason}`)
      log(`run: kimaki-whisper setup --model auto`)
    }
    return
  }

  if (cmd === 'status') {
    const cfg = loadConfig()
    log(JSON.stringify({
      model: cfg.model ?? null,
      backendUrl: cfg.backendUrl ?? null,
      port: cfg.port ?? DEFAULT_PORT,
      tokenConfigured: Boolean(cfg.botToken || process.env.KIMAKI_BOT_TOKEN),
    }, null, 2))
    return
  }

  // default: run the sidecar
  log('jarvis-build: hardened-v2')
  const token = await resolveBotToken()
  if (!token) {
    log('no bot token found. Provide it once:')
    log('  kimaki-whisper setup --token <your kimaki bot token>')
    log('(or set KIMAKI_BOT_TOKEN)')
    process.exit(1)
  }
  const cfg = loadConfig()
  if (cfg.model || cfg.backendUrl) startServer()
  else log('transcription not configured yet — run /whisper-setup in Discord once connected')
  await startDiscord(token)
  const port = cfg.port ?? DEFAULT_PORT
  log('sidecar running. One-time Kimaki wiring (shell profile):')
  log(`  export OPENAI_API_KEY=local OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`)
}

process.on('unhandledRejection', (e) => log('UNHANDLED REJECTION:', String(e)))
process.on('uncaughtException', (e) => {
  log('UNCAUGHT EXCEPTION:', String((e as Error)?.stack ?? e))
  process.exit(3) // supervised: restart script respawns on 3
})

void main()
