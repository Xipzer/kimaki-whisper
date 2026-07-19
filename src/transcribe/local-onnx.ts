// Built-in local transcription: ONNX whisper in-process via @huggingface/transformers.
// The heavy runtime is NOT a dependency of this package — it npm-installs on demand
// into ~/.kimaki-whisper/runtime (keeps `npx kimaki-whisper` light). Models cache
// there too. Ported from the proven Kimaki PR implementation.
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { configDir, log } from '../config.js'
import { oggOpusToFloat32At16k } from './audio.js'

export interface ModelTier {
  id: string
  hfModel: string
  label: string
  approxSize: string
}

export const MODEL_TIERS: ModelTier[] = [
  { id: 'fast', hfModel: 'onnx-community/whisper-tiny', label: 'Fast', approxSize: '~110 MB' },
  { id: 'balanced', hfModel: 'onnx-community/whisper-base', label: 'Balanced', approxSize: '~200 MB' },
  { id: 'accurate', hfModel: 'onnx-community/whisper-small', label: 'Accurate', approxSize: '~600 MB' },
  { id: 'best', hfModel: 'onnx-community/whisper-large-v3-turbo', label: 'Best (large-v3-turbo)', approxSize: '~1 GB' },
]

export function tierById(id: string): ModelTier | undefined {
  return MODEL_TIERS.find((t) => t.id === id)
}

export function recommendTier(): { tier: ModelTier; reason: string } {
  const memGb = Math.round(os.totalmem() / 1e9)
  const cores = os.cpus().length
  if (memGb >= 16 && cores >= 8)
    return { tier: tierById('best')!, reason: `${cores} cores + ${memGb} GB RAM run large-v3-turbo comfortably` }
  if (memGb >= 8) return { tier: tierById('accurate')!, reason: `${memGb} GB RAM fits the Accurate model` }
  if (memGb >= 4) return { tier: tierById('balanced')!, reason: `${memGb} GB RAM suits Balanced` }
  return { tier: tierById('fast')!, reason: `limited RAM (${memGb} GB) — Fast avoids swapping` }
}

function runtimeDir(): string {
  return path.join(configDir(), 'runtime')
}

export function isRuntimeInstalled(): boolean {
  return fs.existsSync(
    path.join(runtimeDir(), 'node_modules', '@huggingface', 'transformers', 'package.json'),
  )
}

export async function installRuntime(): Promise<Error | null> {
  if (isRuntimeInstalled()) return null
  const dir = runtimeDir()
  fs.mkdirSync(dir, { recursive: true })
  const pkg = path.join(dir, 'package.json')
  if (!fs.existsSync(pkg))
    fs.writeFileSync(pkg, JSON.stringify({ name: 'kimaki-whisper-runtime', private: true }, null, 2))
  log('installing inference runtime (one-time, ~a minute)...')
  const err = await new Promise<Error | null>((resolve) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund', '@huggingface/transformers@^3'], {
      cwd: dir,
      shell: true,
      stdio: 'ignore',
    })
    child.on('error', (e) => resolve(e))
    child.on('exit', (code) => resolve(code === 0 ? null : new Error(`npm install exited ${code}`)))
  })
  if (err) return new Error(`runtime install failed: ${err.message}`, { cause: err })
  return isRuntimeInstalled() ? null : new Error('runtime install completed but package missing')
}

type AsrPipeline = (audio: Float32Array, options?: object) => Promise<unknown>
let cached: { hfModel: string; asr: AsrPipeline } | null = null

export async function getPipeline({
  hfModel,
  onProgress,
}: {
  hfModel: string
  onProgress?: (message: string) => void
}): Promise<Error | AsrPipeline> {
  if (cached?.hfModel === hfModel) return cached.asr

  const entry = path.join(
    runtimeDir(),
    'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs',
  )
  if (!fs.existsSync(entry)) return new Error('runtime not installed — run setup first')

  const mod = (await import(pathToFileURL(entry).href).catch((e) => e as Error)) as
    | Error
    | { pipeline: (task: string, model: string, opts?: object) => Promise<AsrPipeline>; env: { cacheDir: string } }
  if (mod instanceof Error) return new Error(`runtime load failed: ${mod.message}`, { cause: mod })

  mod.env.cacheDir = path.join(runtimeDir(), 'models')
  log(`loading model ${hfModel} (downloads on first use)...`)
  const seen = new Set<string>()
  const asr = await mod
    .pipeline('automatic-speech-recognition', hfModel, {
      dtype: 'q8',
      progress_callback: (p: { status?: string; file?: string }) => {
        if (p.status === 'download' && p.file && !seen.has(p.file)) {
          seen.add(p.file)
          onProgress?.(`downloading ${p.file}`)
        }
      },
    })
    .catch((e) => new Error(`model load failed: ${String(e)}`, { cause: e }))
  if (asr instanceof Error) return asr

  cached = { hfModel, asr }
  return asr
}

export async function transcribeOgg({
  ogg,
  modelId,
}: {
  ogg: Buffer
  modelId: string
}): Promise<Error | string> {
  const tier = tierById(modelId)
  if (!tier) return new Error(`unknown model tier: ${modelId}`)

  const f32 = await oggOpusToFloat32At16k(ogg)
  if (f32 instanceof Error) return f32
  if (f32.length === 0) return new Error('decoded audio is empty')

  const asr = await getPipeline({ hfModel: tier.hfModel })
  if (asr instanceof Error) return asr

  const started = Date.now()
  const out = await asr(f32, { chunk_length_s: 30, stride_length_s: 5 }).catch(
    (e) => new Error(`inference failed: ${String(e)}`, { cause: e }),
  )
  if (out instanceof Error) return out
  const text = ((out as { text?: string })?.text ?? '').trim()
  log(`transcribed ${(f32.length / 16000).toFixed(1)}s in ${Date.now() - started}ms (${tier.id})`)
  return text
}
