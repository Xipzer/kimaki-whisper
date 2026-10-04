import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createStatusAdapter, healthFromReport } from '../dist/senses/sessionStatus.js'
import { blockedSessions, kimakiOpencodeServer, MAX_BLOCK_CANDIDATES } from '../dist/senses/filterBlock.js'

type Run = { out: string; head: string; code: number | null; timedOut: boolean }
const HELP_031 = '  session list   List\n  session read <id>  Read\n'
const HELP_NEXT = HELP_031 + '  session status <id>  State as JSON\n'
const dbHealth = (status = 'idle') => async () => ({ status, lastActivityAt: 1, model: 'db-model', contextTokens: 10, lastError: null, filter: { blocked: false, nudgedSince: false, consecutive: 0, lastBlockAt: null, totalBlocks: 0 }, awaitingReply: false, lastOkAt: 1 })

function fakeRunner(help: string, statusOut: string | (() => Run)) {
  const calls: string[][] = []
  const run = async (args: string[]): Promise<Run> => {
    calls.push(args)
    if (args[1] === '--help') return { out: help, head: help, code: 0, timedOut: false }
    if (typeof statusOut === 'function') return statusOut()
    return { out: statusOut, head: statusOut, code: 0, timedOut: false }
  }
  return { run, calls }
}

test('status adapter: CLI without `session status` -> DB lookup, probed once and cached', async () => {
  const f = fakeRunner(HELP_031, '')
  const a = createStatusAdapter({ run: f.run, dbHealth: dbHealth('working') as never })
  const s1 = await a.status('ses_aaaaaaaaaaaa'); const s2 = await a.status('ses_aaaaaaaaaaaa')
  assert.equal(s1!.source, 'db'); assert.equal(s1!.health.status, 'working'); assert.equal(s2!.source, 'db')
  assert.equal(f.calls.length, 1, 'only the help probe ran')
  assert.deepEqual(f.calls[0], ['session', '--help'])
})

test('status adapter: uses `kimaki session status <id> --json` when listed; DB fills missing detail', async () => {
  const f = fakeRunner(HELP_NEXT, '{"status":"question","model":"anthropic/claude-opus-5-5"}')
  const a = createStatusAdapter({ run: f.run, dbHealth: dbHealth() as never })
  const s = await a.status('ses_aaaaaaaaaaaa')
  assert.equal(s!.source, 'kimaki')
  assert.equal(s!.health.status, 'question')
  assert.equal(s!.health.model, 'anthropic/claude-opus-5-5')
  assert.equal(s!.health.contextTokens, 10, 'from the DB')
  assert.deepEqual(f.calls[1], ['session', 'status', 'ses_aaaaaaaaaaaa', '--json'])
})

test('status adapter: repeated CLI failures fall back to the DB and disable the CLI path until re-probe', async () => {
  let t = 0
  const f = fakeRunner(HELP_NEXT, () => ({ out: 'ERROR: boom', head: '', code: 64, timedOut: false }))
  const a = createStatusAdapter({ run: f.run, dbHealth: dbHealth() as never, now: () => t, reprobeMs: 1000, maxFailures: 2 })
  for (let i = 0; i < 4; i++) assert.equal((await a.status('ses_aaaaaaaaaaaa'))!.source, 'db')
  assert.equal(f.calls.filter((c) => c[1] === 'status').length, 2, 'stopped calling after 2 failures')
  t = 5000
  await a.status('ses_aaaaaaaaaaaa')
  assert.equal(f.calls.filter((c) => c[1] === '--help').length, 2, 're-probed after reprobeMs')
})

test('healthFromReport maps a blocked report to a blocked filter state', () => {
  const h = healthFromReport({ state: 'blocked', lastError: { name: 'ContentFilterError', message: 'x', at: 42 }, model: null, contextTokens: null, lastActivityAt: 40, awaitingReply: true }, null)
  assert.equal(h.status, 'blocked')
  assert.deepEqual(h.filter, { blocked: true, nudgedSince: true, consecutive: 1, lastBlockAt: 42, totalBlocks: 1 })
  assert.equal(h.lastError, 'ContentFilterError: x')
})

function tempDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wendy-oc-')), 'opencode.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, title text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);`)
  return { file, db }
}

test('blockedSessions: indexed per-session lookups over recent + known-active sessions only', async () => {
  const { file, db } = tempDb()
  const now = Date.now()
  const sess = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)')
  const msg = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
  const add = (sid: string, n: number, t: number, data: object) => msg.run(`${sid}_${n}`, sid, t, t, JSON.stringify(data))
  sess.run('ses_recentblock', '/a', 'recent blocked', now - 1e6, now - 60000)
  add('ses_recentblock', 1, now - 120000, { role: 'user' }); add('ses_recentblock', 2, now - 60000, { role: 'assistant', error: { name: 'ContentFilterError' } })
  sess.run('ses_oldblocked', '/a', 'old, not active', now - 9e7, now - 8e7)
  add('ses_oldblocked', 1, now - 8e7, { role: 'assistant', error: { name: 'ContentFilterError' } })
  sess.run('ses_candidate', '/a', 'session row stale, but index says active', now - 9e7, now - 8e7)
  add('ses_candidate', 1, now - 8e7, { role: 'assistant', error: { name: 'ContentFilterError' } }); add('ses_candidate', 2, now - 7e7, { role: 'user' })
  sess.run('ses_recovered', '/a', 'blocked then fine', now - 1e6, now - 1000)
  add('ses_recovered', 1, now - 5000, { role: 'assistant', error: { name: 'ContentFilterError' } }); add('ses_recovered', 2, now - 1000, { role: 'assistant' })
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 40').all('x').map((r) => String(r.detail)).join(' ')
  assert.match(plan, /USING INDEX message_session_time_created_id_idx/)
  assert.ok(!/SCAN message/.test(plan))
  db.close()
  const got = await blockedSessions(['ses_candidate'], 3 * 3600000, file)
  assert.deepEqual(got!.map((b) => b.sessionId).sort(), ['ses_candidate', 'ses_recentblock'])
  assert.equal(got!.find((b) => b.sessionId === 'ses_candidate')!.state.nudgedSince, true)
  assert.equal(await blockedSessions([], 1000, path.join(os.tmpdir(), 'does-not-exist.db')), null, 'no DB -> null (caller may use kimaki status)')
  assert.ok(MAX_BLOCK_CANDIDATES <= 60)
})

test('kimakiOpencodeServer reads /kimaki/opencode-port on the lock port', async () => {
  const seen: string[] = []
  const fake = (async (u: string) => { seen.push(u); return new Response(JSON.stringify({ port: 35585 }), { status: 200 }) }) as unknown as typeof fetch
  assert.equal(await kimakiOpencodeServer(fake, 29988), 'http://127.0.0.1:35585')
  assert.deepEqual(seen, ['http://127.0.0.1:29988/kimaki/opencode-port'])
  const none = (async () => new Response('{"error":"no_opencode_server"}', { status: 404 })) as unknown as typeof fetch
  assert.equal(await kimakiOpencodeServer(none, 29988), null)
  const down = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
  assert.equal(await kimakiOpencodeServer(down, 29988), null)
})
