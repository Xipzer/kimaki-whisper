// Mouth engines behind one contract. The loop writes sentences as the brain
// produces them and reads 24 kHz float32 frames back.
import { TtsStream } from './kyutai.js'
import { loadConfig, log } from '../config.js'

export type TtsEngine = {
  write(text: string): Promise<void>
  end(): Promise<void>
  cancel(): void
  done: Promise<{ firstAudioMs: number | null }>
  cancelled: boolean
  frames: number
}

export function ttsEngineName(): 'kokoro' | 'kyutai' {
  return (loadConfig() as { ttsEngine?: 'kokoro' | 'kyutai' }).ttsEngine ?? 'kokoro'
}

export function makeTts(onPcm: (pcm: Float32Array) => void): TtsEngine {
  return ttsEngineName() === 'kyutai' ? new TtsStream(onPcm) : new KokoroEngine(onPcm)
}

/** Kokoro via speaches (/v1/audio/speech). Batch per SENTENCE - Kokoro has no
 *  cross-chunk prosody, but a whole sentence is exactly the unit it renders well.
 *  Sentences are synthesised in order, one ahead of playback. */
export class KokoroEngine implements TtsEngine {
  done: Promise<{ firstAudioMs: number | null }>
  private resolveDone!: (v: { firstAudioMs: number | null }) => void
  cancelled = false
  frames = 0
  private queue: string[] = []
  private running: Promise<void> = Promise.resolve()
  private ended = false
  private t0 = Date.now()
  private firstAt: number | null = null
  private ctrl = new AbortController()
  constructor(private onPcm: (pcm: Float32Array) => void) {
    this.done = new Promise((r) => { this.resolveDone = r })
  }
  async write(text: string): Promise<void> {
    if (this.cancelled) return
    this.queue.push(text)
    this.running = this.running.then(() => this.next())
  }
  private async next(): Promise<void> {
    const text = this.queue.shift()
    if (!text || this.cancelled) return
    const cfg = loadConfig() as { speachesUrl?: string; ttsVoice?: string }
    const base = (cfg.speachesUrl ?? 'http://localhost:8000').replace(/\/$/, '')
    const voice = cfg.ttsVoice && !cfg.ttsVoice.includes('/') ? cfg.ttsVoice : 'af_heart'
    const t = Date.now()
    const res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', input: text, voice, response_format: 'wav' }),
      signal: AbortSignal.any([this.ctrl.signal, AbortSignal.timeout(30000)]),
    }).catch((e) => new Error(String(e)))
    if (this.cancelled) return
    if (res instanceof Error || !res.ok) { log('kokoro tts failed:', res instanceof Error ? res.message : res.status); return }
    const pcm = wavToFloat24k(Buffer.from(await res.arrayBuffer()))
    if (this.cancelled) return
    if (this.firstAt === null) this.firstAt = Date.now()
    log(`kokoro: ${text.length} chars -> ${(pcm.length / 24000).toFixed(1)}s in ${Date.now() - t}ms`)
    for (let i = 0; i < pcm.length; i += 1920) { this.onPcm(pcm.subarray(i, i + 1920)); this.frames++ }
  }
  async end(): Promise<void> {
    if (this.ended) return
    this.ended = true
    await this.running
    this.resolveDone({ firstAudioMs: this.firstAt === null ? null : this.firstAt - this.t0 })
  }
  cancel(): void {
    this.cancelled = true
    this.queue.length = 0
    this.ctrl.abort()
    this.resolveDone({ firstAudioMs: null })
  }
}

/** PCM WAV (16-bit or float32, mono or stereo, any rate) -> mono float32 @ 24 kHz. */
export function wavToFloat24k(buf: Buffer): Float32Array {
  let off = 12, fmt = 1, ch = 1, rate = 24000, bits = 16, data: Buffer = buf.subarray(44)
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') { fmt = buf.readUInt16LE(off + 8); ch = buf.readUInt16LE(off + 10); rate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22) }
    if (id === 'data') { data = buf.subarray(off + 8, off + 8 + size); break }
    off += 8 + size + (size & 1)
  }
  const bytes = bits / 8, n = Math.floor(data.length / bytes / ch)
  const mono = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let c = 0; c < ch; c++) {
      const o = (i * ch + c) * bytes
      acc += fmt === 3 ? data.readFloatLE(o) : bits === 16 ? data.readInt16LE(o) / 32768 : bits === 32 ? data.readInt32LE(o) / 2147483648 : (data[o] - 128) / 128
    }
    mono[i] = acc / ch
  }
  if (rate === 24000) return mono
  const m = Math.floor(n * 24000 / rate), out = new Float32Array(m)
  for (let i = 0; i < m; i++) { const x = i * rate / 24000, j = Math.floor(x), f = x - j; out[i] = mono[j] * (1 - f) + (mono[Math.min(j + 1, n - 1)] ?? 0) * f }
  return out
}
