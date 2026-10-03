import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { stuckRun, factsOnly, isGuardBrief, GUARD_MARK } from '../dist/senses/filterBlock.js'
import { ladderBrief, unblockPrompt, sameBrief, invalidPaths, restorePartials, substantiveOkAt, failedSince, RUNG_COUNT } from '../dist/senses/guard.js'

type P = { type: string; text?: string; tool?: string; state?: { status?: string; input?: { filePath?: string } } }
const T0 = 1_790_000_000_000
const M = (id: string, role: string, o: { err?: string; parts?: P[]; t?: number; done?: boolean } = {}) => ({ info: { id, role, error: o.err ? { name: o.err } : undefined, time: { created: o.t ?? T0, completed: o.done === false ? undefined : (o.t ?? T0) + 1000 } }, parts: o.parts ?? [] })
const txt = (t: string): P => ({ type: 'text', text: t })
const write = (f: string): P => ({ type: 'tool', tool: 'write', state: { status: 'completed', input: { filePath: f } } })
const bash: P = { type: 'tool', tool: 'bash', state: { status: 'completed' } }
const CF = 'ContentFilterError'
// shape of the Oct 3 session: owner request 636, failures 639/641/645/649 spread out, clean 643/644/647, guard briefs between
const fixture = () => [
  M('m636', 'user', { parts: [txt('Build the fork tests for the rewards contract and report the loss per token.')], t: T0 }),
  M('m637', 'assistant', { parts: [bash, txt('3 of 5 tokens tallied; test_loss_token1 = 120 wei, see packages/contracts/test/Loss.t.sol')], t: T0 + 1e3 }),
  M('m639', 'assistant', { err: CF, parts: [write('packages/contracts/test/A.t.sol')], t: T0 + 2e3 }),
  M('m640', 'user', { parts: [txt('Your previous replies were cut off by the provider... continue')], t: T0 + 3e3 }),
  M('m641', 'assistant', { err: CF, parts: [write('packages/contracts/test/B.t.sol')], t: T0 + 4e3 }),
  M('m642', 'user', { parts: [txt(GUARD_MARK + 'reframed brief')], t: T0 + 5e3 }),
  M('m643', 'assistant', { parts: [bash], t: T0 + 6e3 }),
  M('m644', 'assistant', { parts: [txt('ok')], t: T0 + 7e3 }),
  M('m645', 'assistant', { err: CF, parts: [write('packages/contracts/test/C.t.sol')], t: T0 + 8e3 }),
  M('m646', 'user', { parts: [txt(GUARD_MARK + 'another brief')], t: T0 + 9e3 }),
  M('m647', 'assistant', { parts: [txt('done')], t: T0 + 10e3 }),
  M('m648', 'user', { parts: [txt(GUARD_MARK + 'third brief')], t: T0 + 11e3 }),
  M('m649', 'assistant', { err: CF, parts: [], t: T0 + 12e3 }),
]

test('1: revert scope covers the whole episode, not only the last failure', () => {
  const r = stuckRun(fixture())!
  assert.equal(r.revertPoint, 'm636', 'turn holding the first failure after the owner request')
  assert.equal(r.failed, 4)
  assert.equal(r.removed, 13)
})
test('2: writes inside failed turns count as partial even when reported completed', () => {
  assert.deepEqual(stuckRun(fixture())!.partialFiles.sort(), ['packages/contracts/test/A.t.sol', 'packages/contracts/test/B.t.sol', 'packages/contracts/test/C.t.sol'])
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'))
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'kept.sol'), 'v1'); g('add', '.'); g('commit', '-qm', 'i')
  fs.writeFileSync(path.join(repo, 'kept.sol'), 'trunc'); fs.writeFileSync(path.join(repo, 'new.sol'), 'trunc'); g('add', '-N', 'new.sol')
  const bak = path.join(repo, '..', path.basename(repo) + '-bak')
  const done = restorePartials(['kept.sol', 'new.sol'], repo, bak)
  assert.equal(fs.readFileSync(path.join(repo, 'kept.sol'), 'utf-8'), 'v1')
  assert.equal(fs.existsSync(path.join(repo, 'new.sol')), false)
  assert.equal(fs.readFileSync(path.join(bak, 'new.sol'), 'utf-8'), 'trunc')
  assert.deepEqual(done, ['kept.sol (restored)', 'new.sol (removed)'])
})
test('3: the task is the owner request, never a guard brief', () => {
  const r = stuckRun(fixture())!
  assert.match(r.briefTask, /^Build the fork tests/)
  assert.equal(isGuardBrief(fixture()[3]), true)
  assert.equal(isGuardBrief(M('x', 'user', { parts: [txt('hello')] }), new Set(['x'])), true, 'sent ids count')
})
test('4: no cut-off text in briefs; confirmed state is facts only', () => {
  const r = stuckRun(fixture())! as Record<string, unknown>
  assert.equal('cutoffText' in r, false)
  assert.equal(factsOnly('This is a long story about it. test_loss_token1 = 120 wei. Fine.'), 'test_loss_token1 = 120 wei.')
})
test('5: rungs reframe, small edits, numbers only - no continue-where-stopped, no prose into files, no word swaps', () => {
  for (let i = 1; i <= RUNG_COUNT + 1; i++) for (const b of [unblockPrompt(i), ladderBrief(i, 'task', 'facts')]) {
    assert.doesNotMatch(b, /exactly where it stopped|markdown file|into a file|substitut|instead of the word/i)
  }
  assert.match(ladderBrief(1, 't', ''), /correctness and accounting/)
  assert.match(ladderBrief(2, 't', ''), /small edits of about 40 lines/)
  assert.match(ladderBrief(3, 't', ''), /numbers only/)
})
test('6: briefs naming paths that do not exist are rejected', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'))
  fs.mkdirSync(path.join(repo, 'packages/contracts/test'), { recursive: true }); fs.writeFileSync(path.join(repo, 'packages/contracts/test/Loss.t.sol'), '')
  assert.deepEqual(invalidPaths('edit packages/contracts/test/Loss.t.sol and add packages/contracts/test/New.t.sol', repo), [])
  assert.deepEqual(invalidPaths('write notes/bstonk-analysis.md and fork-test/stale-shares.spec.ts', repo).sort(), ['fork-test/stale-shares.spec.ts', 'notes/bstonk-analysis.md'])
})
test('7: a one-line clean reply does not end the episode; real work with no new failure does', () => {
  const f = fixture()
  assert.equal(substantiveOkAt(f.slice(0, 12).filter((m) => m.info.id !== 'm643' && m.info.id !== 'm637')), null, 'm644/m647 are one-liners')
  assert.equal(substantiveOkAt(f), T0 + 7e3, 'm643 had a completed tool call')
  assert.equal(failedSince(f, T0 + 7e3), true, 'm645/m649 failed after it - episode continues')
})
test('8/9: sameBrief sees briefs across the session and the rungs never repeat', () => {
  const rungs = Array.from({ length: RUNG_COUNT }, (_, i) => ladderBrief(i + 1, 'task', 'facts'))
  for (let i = 0; i < rungs.length; i++) for (let j = i + 1; j < rungs.length; j++) assert.equal(sameBrief(rungs[i], rungs[j]), false)
  assert.equal(sameBrief(rungs[0], ladderBrief(1, 'other task', 'other facts')), true, 'same approach regardless of context')
})
