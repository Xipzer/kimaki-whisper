// Kyutai STT / TTS websocket clients (see ~/kyutai-server/server.py).
// Audio on the wire is float32 PCM @ 24 kHz, 1920 samples (80 ms) per frame.
import WebSocket from 'ws'
import { loadConfig, log } from '../config.js'

export const RATE = 24000
export const FRAME = 1920

export function kyutaiUrl(): string {
  return ((loadConfig() as { kyutaiUrl?: string }).kyutaiUrl ?? 'ws://127.0.0.1:8010').replace(/\/$/, '')
}

export async function kyutaiHealth(): Promise<boolean> {
  const http = kyutaiUrl().replace(/^ws/, 'http')
  try { return (await fetch(`${http}/health`, { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
}

export type SttEvents = {
  word: (text: string, t: number) => void
  vad: (p: number, t: number) => void
  ready: () => void
  close: () => void
}

/** Always-on transcription stream. push() real frames; the ticker fills gaps with
 *  silence so the model runs in real time and the VAD keeps predicting. */
export class SttStream {
  private ws: WebSocket | null = null
  private buf: Float32Array[] = []
  private ticker: NodeJS.Timeout | null = null
  private ready = false
  closed = false
  constructor(private on: Partial<SttEvents>) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${kyutaiUrl()}/stt`)
      this.ws = ws
      const to = setTimeout(() => { reject(new Error('stt connect timeout')); ws.terminate() }, 8000)
      ws.on('message', (data, isBinary) => {
        if (isBinary) return
        const m = JSON.parse(data.toString()) as { type: string; text?: string; t?: number; p?: number; message?: string }
        if (m.type === 'ready') { clearTimeout(to); this.ready = true; this.startTicker(); this.on.ready?.(); resolve() }
        else if (m.type === 'word') this.on.word?.(m.text ?? '', m.t ?? 0)
        else if (m.type === 'vad') this.on.vad?.(m.p ?? 0, m.t ?? 0)
        else if (m.type === 'error') log('stt server error:', m.message)
      })
      ws.on('error', (e) => { clearTimeout(to); log('stt ws error:', e.message); reject(e) })
      ws.on('close', () => { this.closed = true; this.stopTicker(); this.on.close?.() })
    })
  }
  /** 24 kHz float32 mono, any length; sliced into frames by the ticker. */
  push(pcm: Float32Array): void { if (this.ready) this.buf.push(pcm) }
  private pending = new Float32Array(0)
  private nextFrame(): Float32Array {
    while (this.pending.length < FRAME && this.buf.length) {
      const n = this.buf.shift()!
      const merged = new Float32Array(this.pending.length + n.length)
      merged.set(this.pending); merged.set(n, this.pending.length)
      this.pending = merged
    }
    if (this.pending.length >= FRAME) {
      const f = this.pending.slice(0, FRAME)
      this.pending = this.pending.slice(FRAME)
      return f
    }
    return new Float32Array(FRAME)
  }
  private queued(): number { return this.pending.length + this.buf.reduce((a, b) => a + b.length, 0) }
  private startTicker(): void {
    this.ticker = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      // catch up if audio piled up (network burst): send up to 3 frames per tick
      // setInterval drifts late; send every whole frame that is queued (cap 6) so the
      // stream never falls behind real time (measured drift before: +0.45 s / 5 min)
      let n = 0
      do { this.ws.send(Buffer.from(this.nextFrame().buffer)); n++ } while (this.queued() >= FRAME && n < 6)
    }, 80)
  }
  private stopTicker(): void { if (this.ticker) clearInterval(this.ticker); this.ticker = null }
  close(): void { this.stopTicker(); try { this.ws?.close() } catch {} ; this.ws = null }
}

/** One reply = one TTS session. Text goes in as it is generated; PCM frames come
 *  out with lookahead-coherent prosody. cancel() drops the socket (barge-in). */
export class TtsStream {
  private ws: WebSocket | null = null
  private opened: Promise<void>
  done: Promise<{ firstAudioMs: number | null }>
  private resolveDone!: (v: { firstAudioMs: number | null }) => void
  cancelled = false
  frames = 0
  constructor(private onPcm: (pcm: Float32Array) => void) {
    this.done = new Promise((r) => { this.resolveDone = r })
    this.opened = new Promise((resolve, reject) => {
      const voice = (loadConfig() as { ttsVoice?: string }).ttsVoice
      const ws = new WebSocket(`${kyutaiUrl()}/tts${voice && voice.includes('/') ? `?voice=${encodeURIComponent(voice)}` : ''}`)
      this.ws = ws
      const to = setTimeout(() => { reject(new Error('tts connect timeout')); ws.terminate() }, 8000)
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          this.frames++
          const b = data as Buffer
          this.onPcm(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)))
          return
        }
        const m = JSON.parse(data.toString()) as { type: string; first_audio_ms?: number; message?: string }
        if (m.type === 'ready') { clearTimeout(to); resolve() }
        else if (m.type === 'done') this.resolveDone({ firstAudioMs: m.first_audio_ms ?? null })
        else if (m.type === 'error') { log('tts server error:', m.message); this.resolveDone({ firstAudioMs: null }) }
      })
      ws.on('error', (e) => { clearTimeout(to); log('tts ws error:', e.message); reject(e); this.resolveDone({ firstAudioMs: null }) })
      ws.on('close', () => this.resolveDone({ firstAudioMs: null }))
    })
  }
  async write(text: string): Promise<void> {
    await this.opened
    if (this.cancelled || !this.ws) return
    this.ws.send(JSON.stringify({ type: 'text', text }))
  }
  async end(): Promise<void> {
    await this.opened.catch(() => {})
    if (this.cancelled || !this.ws) return
    this.ws.send(JSON.stringify({ type: 'eos' }))
  }
  cancel(): void {
    this.cancelled = true
    try { this.ws?.terminate() } catch {}
    this.ws = null
    this.resolveDone({ firstAudioMs: null })
  }
}
