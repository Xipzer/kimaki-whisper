import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { VoiceLoop, speakable } from '../dist/voice/loop.js'

const fakePlayer = () => Object.assign(new EventEmitter(), { state: { status: 'idle' }, play() {}, stop() {} })

test('continuedSince: owner still talking after the commit point', async () => {
  const loop = new VoiceLoop(null, fakePlayer() as never, 'o', { gate: () => ({ silenced: false, nameOnly: false, expectingAnswer: false }), onUtterance: () => {} }, () => () => {})
  const l = loop as unknown as { onWord: (w: string, t: number) => void }
  const t0 = Date.now()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(loop.continuedSince(t0), false)
  l.onWord('yeah', 0)
  assert.equal(loop.continuedSince(t0), false, 'a lone backchannel is not a continuation')
  l.onWord('5.5,', 0)
  assert.equal(loop.continuedSince(t0), true)
  loop.stop()
})

test('speakable strips spoken punctuation that Kyutai/Kokoro voice as hesitation', () => {
  assert.equal(speakable("You're back — what's on your mind?"), "You're back, what's on your mind?")
  assert.equal(speakable('Three areas: first; second'), 'Three areas, first, second')
})

test('loudness barge-in cuts her after ~0.45 s of his voice, not on a blip', () => {
  const fired: string[] = []
  const player = Object.assign(new EventEmitter(), { state: { status: 'playing' }, play() {}, stop() { (this as { state: { status: string } }).state.status = 'idle' } })
  const loop = new VoiceLoop(null, player as never, 'o', { gate: () => ({ silenced: false, nameOnly: false, expectingAnswer: false }), onUtterance: () => {}, onBargeIn: () => fired.push('barge') }, () => () => {})
  const l = loop as unknown as { onLevel: (r: number) => void }
  for (let i = 0; i < 10; i++) l.onLevel(2000)          // 200 ms loud
  for (let i = 0; i < 10; i++) l.onLevel(50)            // gap resets
  assert.deepEqual(fired, [], 'a short blip must not cut her')
  for (let i = 0; i < 23; i++) l.onLevel(2000)          // 460 ms sustained
  assert.deepEqual(fired, ['barge'])
  loop.stop()
})

test('a second reply while the first is still playing is appended, not swapped in', async () => {
  const plays: unknown[] = []
  const player = Object.assign(new EventEmitter(), { state: { status: 'idle' }, play(r: unknown) { plays.push(r); (this as { state: { status: string } }).state.status = 'playing' }, stop() {} })
  const loop = new VoiceLoop(null, player as never, 'o', { gate: () => ({ silenced: false, nameOnly: false, expectingAnswer: false }), onUtterance: () => {} }, () => () => {})
  const L = loop as unknown as { stream: { reopen(): boolean; pushPcm(p: Float32Array): void } | null; beginReply(): void; tts: unknown }
  const { AudioOut } = await import('../dist/voice/audio.js')
  const first = new AudioOut(); first.pushPcm(new Float32Array(1920)); first.finish()
  L.stream = first as never
  ;(L as { tts: unknown }).tts = null
  L.beginReply()
  assert.equal(L.stream, first, 'still-playing stream is reused')
  assert.equal(plays.length, 0, 'no new resource swapped onto the player')
  loop.stop()
})
