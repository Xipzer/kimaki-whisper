import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DispatchLedger } from '../dist/state/ledgers.js'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), 'd.json')

test('record/markDone/groundTruth + persistence across instances', () => {
  let t = 1_000_000
  const file = tmp()
  const a = new DispatchLedger(file, () => t)
  a.record('ses_aaaaaaaaaaaa', 'audit thread')
  t += 3 * 60000
  a.record('ses_bbbbbbbbbbbb', 'design thread')
  a.markDone('ses_aaaaaaaaaaaa')
  t += 2 * 60000
  const gt = a.groundTruth()
  assert.match(gt, /FINISHED: "audit thread" FINISHED 2m ago/)
  assert.match(gt, /RUNNING: "design thread" running 2m/)
  // reload from disk
  const b = new DispatchLedger(file, () => t)
  b.load()
  assert.equal(b.has('ses_aaaaaaaaaaaa'), true)
  assert.deepEqual(b.unfinished(60 * 60000).map(([id]) => id), ['ses_bbbbbbbbbbbb'])
  // re-arm keeps original start
  b.record('ses_bbbbbbbbbbbb', 'design thread', true)
  assert.match(b.groundTruth(), /running 2m/)
  assert.equal(new DispatchLedger(tmp(), () => t).groundTruth(), '')
})

test('verified ids expire; non-ids ignored', () => {
  let t = 0
  const l = new DispatchLedger(tmp(), () => t)
  l.markVerified('not-an-id'); l.markVerified('ses_cccccccccccc')
  assert.equal(l.isVerified('not-an-id'), false)
  assert.equal(l.isVerified('ses_cccccccccccc'), true)
  t += 11 * 60000
  assert.equal(l.isVerified('ses_cccccccccccc'), false)
})

test('duplicate detection and claim backing', () => {
  let t = 0
  const l = new DispatchLedger(tmp(), () => t)
  assert.equal(l.sentRecently(), false)
  l.recordSend('k1', 'ask_thread')
  t += 52_000
  assert.equal(l.duplicateAgeS('k1'), 52)
  assert.equal(l.duplicateAgeS('k2'), null)
  assert.equal(l.sentRecently(), true)
  t += 10 * 60000
  assert.equal(l.duplicateAgeS('k1'), null)
  assert.equal(l.sentRecently(), false)
})
