#!/usr/bin/env node
// kimaki-whisper - Wendy node. One process, role-driven (node.json `role`):
//   every node    :7070 endpoint + own-domain gateway on THIS device's Kimaki bot
//   primary only  + Wendy herself on the home bot token (voice, panel, Telegram)
//   kimaki-whisper                     run (role from node.json; no node.json = primary)
//   kimaki-whisper serve               force standby: endpoint + own-domain gateway only
//   kimaki-whisper setup [--model auto|fast|balanced|accurate|best]
//                        [--backend-url <url>] [--token <bot token>]
//   kimaki-whisper status
import { loadConfig, saveConfig, DEFAULT_PORT, log } from './config.js'
import { resolveNodeToken, resolveWendyToken } from './token.js'
import { nodeIdentity } from './node/identity.js'
import { recommendTier, tierById, installRuntime, getPipeline } from './transcribe/local-onnx.js'
import { startServer } from './server.js'
import { startDiscord, startNodeGateway } from './discord.js'

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
      log(`recommended for this machine: ${rec.tier.label} (${rec.tier.approxSize}) - ${rec.reason}`)
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
      role: nodeIdentity().role,
      wendyToken: Boolean(resolveWendyToken()),
      nodeToken: Boolean(await resolveNodeToken()),
    }, null, 2))
    return
  }

  // run / serve
  log('wendy-build: hardened-v2')
  const cfg = loadConfig()
  const port = cfg.port ?? DEFAULT_PORT
  const primary = cmd !== 'serve' && nodeIdentity().role === 'primary'
  if (cfg.model || cfg.backendUrl) startServer()
  else log('transcription not configured yet - run /whisper-setup in Discord once connected')
  log(`endpoint on http://127.0.0.1:${port}/v1  (export OPENAI_API_KEY=local OPENAI_BASE_URL=http://127.0.0.1:${port}/v1)`)

  const nodeTok = await resolveNodeToken()
  const wendyTok = primary ? resolveWendyToken() : null
  if (primary && !wendyTok) {
    log('role is primary but no Wendy token (WENDY_BOT_TOKEN / config wendyToken). Set it, or set role: standby in node.json')
    process.exit(1)
  }
  // ONE Wendy per token. The own-domain gateway is skipped when it would be
  // the same bot as Wendy (the printer: home bot == its Kimaki bot).
  if (wendyTok) await startDiscord(wendyTok)
  if (nodeTok && nodeTok !== wendyTok) await startNodeGateway(nodeTok)
  else if (!nodeTok) log('no node token (no local Kimaki DB, no nodeToken) - own-domain gateway disabled')
  log(`role: ${primary ? 'PRIMARY (Wendy live here)' : 'standby (own domain only)'}`)
}

process.on('unhandledRejection', (e) => log('UNHANDLED REJECTION:', String(e)))
process.on('uncaughtException', (e) => {
  log('UNCAUGHT EXCEPTION:', String((e as Error)?.stack ?? e))
  process.exit(3) // supervised: restart script respawns on 3
})

void main()
