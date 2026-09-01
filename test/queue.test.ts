import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AttentionQueue } from '../src/attention/queue.ts'

test('caps: held keeps newest 12, pending newest 8, live/digest unbounded', () => {
  const q = new AttentionQueue()
  for (let i = 0; i < 20; i++) q.push('held', `h${i}`)
  assert.equal(q.count('held'), 12); assert.equal(q.peek('held')[0], 'h8')
  for (let i = 0; i < 20; i++) q.push('pending', `p${i}`)
  assert.equal(q.count('pending'), 8); assert.equal(q.peek('pending')[0], 'p12')
  for (let i = 0; i < 40; i++) q.push('live', `l${i}`)
  assert.equal(q.count('live'), 40)
})

test('take is FIFO and removes; promote honours target cap', () => {
  const q = new AttentionQueue()
  q.push('digest', 'a', 'b', 'c')
  assert.deepEqual(q.take('digest', 2), ['a', 'b'])
  assert.deepEqual(q.take('digest'), ['c'])
  for (let i = 0; i < 8; i++) q.push('pending', `p${i}`)
  q.push('held', 'old1', 'old2', 'old3', 'old4', 'old5')
  assert.equal(q.promote('pending', 'held'), 8)
  assert.equal(q.count('pending'), 0)
  assert.equal(q.count('held'), 12)
  assert.equal(q.peek('held')[0], 'old2')  // oldest dropped to fit cap
})

test('dropMatching hits delivery lanes only by default', () => {
  const q = new AttentionQueue()
  q.push('digest', 'x <tg:A>'); q.push('pending', 'y <tg:A>'); q.push('held', 'z <tg:A>'); q.push('live', 'w <tg:A>')
  assert.equal(q.dropMatching('<tg:A>'), 3)
  assert.equal(q.count('live'), 1)
})

test('trim keeps newest; counts and high', () => {
  const q = new AttentionQueue()
  q.push('live', '1', '2', '[HIGH] 3', '4')
  q.trim('live', 2)
  assert.deepEqual([...q.peek('live')], ['[HIGH] 3', '4'])
  q.push('held', '[HIGH] h')
  assert.equal(q.total(), 3)
  assert.equal(q.highCount(), 2)
  assert.equal(q.highCount('held'), 1)
  assert.equal(q.some('live', (s) => s.includes('HIGH')), true)
})
