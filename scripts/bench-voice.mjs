// End-to-end voice bench without Discord: wav (owner) -> kyutai stt -> turn fsm -> brain -> kyutai tts -> fake player.
// usage: WENDY_BRAIN_URL=http://127.0.0.1:18081 node scripts/bench-voice.mjs <owner.wav>
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { VoiceLoop } from '../dist/voice/loop.js'
import { brainRequest } from '../dist/brain/client.js'

const wav = process.argv[2]
const buf = fs.readFileSync(wav)
const sr = buf.readUInt32LE(24), ch = buf.readUInt16LE(22), bits = buf.readUInt16LE(34)
const data = buf.subarray(44)
const n = Math.floor(data.length / (bits / 8) / ch)
const pcmIn = new Float32Array(n)
for (let i = 0; i < n; i++) pcmIn[i] = bits === 16 ? data.readInt16LE(i * 2 * ch) / 32768 : data.readFloatLE(i * 4 * ch)
const pcm24 = sr === 24000 ? pcmIn : Float32Array.from({ length: Math.floor(n * 24000 / sr) }, (_, i) => pcmIn[Math.floor(i * sr / 24000)])
console.log(`owner clip: ${(pcm24.length / 24000).toFixed(1)}s @${sr}Hz`)

class FakePlayer extends EventEmitter {
  state = { status: 'idle' }
  bytes = 0; firstAt = 0
  play(res) {
    this.set('playing')
    res.playStream.on('data', (c) => { if (!this.firstAt) this.firstAt = Date.now(); this.bytes += c.length })
    res.playStream.on('end', () => this.set('idle'))
  }
  stop() { this.set('idle') }
  set(s) { const old = { ...this.state }; this.state = { status: s }; this.emit('stateChange', old, this.state); this.emit(s, old, this.state) }
}
const player = new FakePlayer()
const t = { start: Date.now(), clipEnd: 0, utterance: 0, firstText: 0, firstAudio: 0, done: 0 }
const SYSTEM = 'You are Wendy, a concise voice assistant. Answer in two short sentences.'

const loop = new VoiceLoop(null, player, 'owner', {
  gate: () => ({ silenced: false, nameOnly: false, expectingAnswer: false }),
  onUtterance: async (text, meta) => {
    if (t.utterance) { console.log(`(late utterance ignored: "${text}")`); return }
    t.utterance = Date.now()
    console.log(`utterance (+${t.utterance - t.clipEnd}ms after clip end, ${meta.words} words): "${text}"`)
    let first = true
    const out = await brainRequest('background', { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }], max_tokens: 200 }, (sent) => {
      if (first) { first = false; t.firstText = Date.now(); console.log(`first sentence from brain +${t.firstText - t.utterance}ms`) }
      loop.say(sent)
    })
    if (!out.content && out.error) console.log('brain error', out.error)
    await loop.endReply()
    t.done = Date.now()
    t.firstAudio = player.firstAt
    const secs = player.bytes / (48000 * 4)
    console.log(`reply: "${out.content.slice(0, 120)}"`)
    console.log(`TIMELINE  end-of-turn detect ${t.utterance - t.clipEnd}ms | brain first text +${t.firstText - t.utterance}ms | first AUDIO +${t.firstAudio - t.utterance}ms after utterance = ${t.firstAudio - t.clipEnd}ms after owner stopped | ${secs.toFixed(1)}s speech played in ${t.done - t.utterance}ms`)
    loop.stop(); process.exit(0)
  },
}, (sink) => {
  let i = 0
  const iv = setInterval(() => {
    if (i >= pcm24.length) { if (!t.clipEnd) t.clipEnd = Date.now(); return }
    sink(pcm24.subarray(i, i + 1920)); i += 1920
  }, 80)
  return () => clearInterval(iv)
})
await loop.start()
setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 120000)
