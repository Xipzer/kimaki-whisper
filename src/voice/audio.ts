// Discord <-> 24 kHz float32 PCM bridges.
//   in : owner's opus (48k mono via prism) -> 24k float32 -> SttStream.push
//   out: 24k float32 frames -> 48k s16le stereo Readable -> AudioPlayer (StreamType.Raw)
import { Readable } from 'node:stream'
import prism from 'prism-media'
import { EndBehaviorType, type VoiceReceiver } from '@discordjs/voice'
import { log } from '../config.js'

export type AudioInStats = { speakingStarts: number; packets: number; lastPacketAt: number; resubscribes: number }

/** Owner audio in. Re-subscribes on EVERY speaking-start whose stream is gone or
 *  silent (V1 behaviour): after a reconnect or a join while he was already in
 *  the channel, a single long-lived subscription can stay attached to a dead
 *  SSRC and deliver nothing - measured: 18 min session, 0 words heard. */
export function ownerAudioIn(receiver: VoiceReceiver, userId: string, sink: (pcm24: Float32Array) => void, onLevel?: (rms: number) => void, stats?: AudioInStats): () => void {
  const st: AudioInStats = stats ?? { speakingStarts: 0, packets: 0, lastPacketAt: 0, resubscribes: 0 }
  let opus: ReturnType<VoiceReceiver['subscribe']> | null = null
  let decoder: prism.opus.Decoder | null = null
  let closed = false
  const attach = (): void => {
    if (closed) return
    try { opus?.unpipe(); opus?.destroy(); decoder?.destroy() } catch {}
    opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } })
    decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 })
    decoder.on('data', (chunk: Buffer) => {
      st.packets++; st.lastPacketAt = Date.now()
      // 48k s16 mono -> 24k float32 (average adjacent pairs)
      const n = chunk.length >> 2
      const out = new Float32Array(n)
      let acc = 0
      for (let i = 0; i < n; i++) {
        const a = chunk.readInt16LE(i * 4), b = chunk.readInt16LE(i * 4 + 2)
        const v = (a + b) / 65536
        out[i] = v; acc += v * v
      }
      onLevel?.(Math.sqrt(acc / Math.max(n, 1)) * 32768)
      sink(out)
    })
    decoder.on('error', (e) => log('audio-in decode error:', e.message))
    opus.on('error', (e) => log('audio-in opus error:', e.message))
    opus.on('close', () => { if (!closed) setTimeout(() => { if (!closed && (!opus || opus.destroyed)) attach() }, 200) })
    opus.pipe(decoder)
  }
  const onStart = (id: string): void => {
    if (id !== userId) return
    st.speakingStarts++
    const live = opus && !opus.destroyed && receiver.subscriptions.get(userId) === opus
    if (!live) { st.resubscribes++; attach(); return }
    // live object but no audio for 1.5 s after he started speaking: stale - rebuild
    const startedAt = Date.now()
    setTimeout(() => { if (!closed && st.lastPacketAt < startedAt) { st.resubscribes++; log('audio-in: speaking but no packets - resubscribing'); attach() } }, 1500)
  }
  receiver.speaking.on('start', onStart)
  attach()
  return () => {
    closed = true
    receiver.speaking.off('start', onStart)
    try { opus?.unpipe(); opus?.destroy(); decoder?.destroy() } catch {}
  }
}

/** A Readable the player consumes; push 24k float frames as they arrive. */
export class AudioOut extends Readable {
  private queue: Buffer[] = []
  private waiting = false
  ended = false
  constructor() { super({ highWaterMark: 1 << 16 }) }
  _read(): void {
    if (this.queue.length) { this.push(this.queue.shift()); return }
    if (this.ended) { this.push(null); return }
    this.waiting = true
  }
  pushPcm(pcm24: Float32Array): void {
    // 24k float -> 48k s16le stereo, linear interpolation
    const out = Buffer.alloc(pcm24.length * 2 * 4)
    for (let i = 0; i < pcm24.length; i++) {
      const a = pcm24[i], b = i + 1 < pcm24.length ? pcm24[i + 1] : a
      const s0 = Math.max(-32768, Math.min(32767, Math.round(a * 32767)))
      const s1 = Math.max(-32768, Math.min(32767, Math.round(((a + b) / 2) * 32767)))
      const o = i * 8
      out.writeInt16LE(s0, o); out.writeInt16LE(s0, o + 2); out.writeInt16LE(s1, o + 4); out.writeInt16LE(s1, o + 6)
    }
    if (this.waiting) { this.waiting = false; this.push(out) } else this.queue.push(out)
  }
  finish(): void { this.ended = true; if (this.waiting) { this.waiting = false; this.push(null) } }
}
