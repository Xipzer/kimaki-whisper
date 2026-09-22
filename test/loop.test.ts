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
