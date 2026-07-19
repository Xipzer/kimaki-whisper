// Discord voice notes are OGG/Opus. Decode to 16 kHz mono Float32 for whisper.
// Pipeline: OGG buffer → OggDemuxer → Opus decode (native @discordjs/opus if
// present, pure-JS opusscript otherwise) → 48k PCM16 mono → 16k Float32.
import { Readable } from 'node:stream'
import prism from 'prism-media'

export function oggOpusToFloat32At16k(input: Buffer): Promise<Error | Float32Array> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const demuxer = new prism.opus.OggDemuxer()
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 })

    decoder.on('data', (c: Buffer) => chunks.push(c))
    decoder.on('end', () => {
      const pcm = Buffer.concat(chunks)
      const n = Math.floor(pcm.length / 2)
      const out = new Float32Array(Math.floor(n / 3))
      for (let i = 0; i < out.length; i++) {
        const b = i * 6
        out[i] = (pcm.readInt16LE(b) + pcm.readInt16LE(b + 2) + pcm.readInt16LE(b + 4)) / (3 * 32768)
      }
      resolve(out)
    })
    const fail = (e: Error) => resolve(new Error(`opus decode failed: ${e.message}`, { cause: e }))
    decoder.on('error', fail)
    demuxer.on('error', fail)
    Readable.from(input).pipe(demuxer).pipe(decoder)
  })
}
