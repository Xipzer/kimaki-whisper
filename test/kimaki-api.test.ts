import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseAllSessionList, parseProjectSessionList, extractJson, searchArgs, formatSearch, sendOutcome, parseStatusJson, helpListsStatus, kimakiLockPort } from '../dist/kimaki/api.js'
import { stripLoggerLines, loggerFailure } from '../dist/kimaki/run.js'

const fx = (f: string): string => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', f), 'utf-8')
const run = (o: Partial<{ out: string; head: string; code: number | null; timedOut: boolean }>) => ({ out: '', head: '', code: 0, timedOut: false, ...o })

test('session list --all --json (real 0.31 rows) -> index entries with status/model/tokens/threadId', () => {
  const e = parseAllSessionList(fx('session-list-all-0.31.json'))!
  assert.equal(e.length, 3)
  assert.deepEqual(e[0], { id: 'ses_0a1b2c3d4ffeAAAAexampleAA1', title: 'Base V7 cutover follow-ups', dir: '/home/owner/WebstormProjects/BaseStonk', updated: Date.parse('2026-10-04T15:21:44.473Z'), threadId: '1500000000000000001', status: 'busy', model: 'claude-opus-5-5', tokens: 15771471 })
  assert.equal(e[1].status, 'showing-question')
  assert.equal(e[2].threadId, undefined, 'threadId null -> absent')
})

test('session list --all: unusable output returns null so the caller walks projects', () => {
  assert.equal(parseAllSessionList('ERROR: Failed to connect'), null)
  assert.equal(parseAllSessionList('not json'), null)
  assert.equal(parseAllSessionList('[{"id":"ses_aaaaaaaaaaaa","title":"t"}]'), null, 'rows without directory are not equivalent data')
  assert.deepEqual(parseAllSessionList('[]'), [])
  const dup = '[{"id":"ses_aaaaaaaaaaaa","title":"t","directory":"/a","updated":"2026-10-01T00:00:00Z"},{"id":"ses_aaaaaaaaaaaa","title":"t","directory":"/b","updated":"2026-10-01T00:00:00Z"}]'
  assert.equal(parseAllSessionList(dup)!.length, 1, 'deduped by id')
  assert.equal(parseAllSessionList('│  19:21 CLI Connecting [x]\n[{"id":"ses_aaaaaaaaaaaa","title":"t","directory":"/a","updated":1}]')!.length, 1, 'log-wrapped JSON')
})

test('per-project list fallback keeps the project dir when rows lack one', () => {
  const e = parseProjectSessionList('[{"id":"ses_bbbbbbbbbbbb","title":"t","time":{"updated":5},"threadId":"None"}]', '/proj')
  assert.deepEqual(e, [{ id: 'ses_bbbbbbbbbbbb', title: 't', dir: '/proj', updated: 5 }])
})

test('search uses --all, explicit --days and --json', () => {
  assert.deepEqual(searchArgs('Sky Broadband'), ['session', 'search', 'Sky Broadband', '--all', '--days', '14', '--limit', '8', '--json'])
  assert.deepEqual(searchArgs('x', 0).slice(4, 6), ['--days', '0'])
  assert.deepEqual(searchArgs('x', NaN).slice(4, 6), ['--days', '14'])
})

test('formatSearch: matches, empty results with scope, and never an empty string', () => {
  const j = JSON.stringify({ query: 'Sky', days: 14, scannedSessions: 146, matches: [{ id: 'ses_cccccccccccc', title: 'Sky Broadband quote', directory: '/home/x/Insurance-Optimizer', updated: '2026-10-01T10:00:00.000Z', threadId: '123', snippets: ['user: compare Sky Broadband plans'] }] })
  const r = formatSearch(j, 'Sky')
  assert.match(r, /^1 match\(es\) for "Sky" \(146 sessions scanned, last 14 days, all projects\):/)
  assert.match(r, /Sky Broadband quote - session ses_cccccccccccc \(project: Insurance-Optimizer, updated 2026-10-01T10:00, thread 123\)/)
  assert.match(formatSearch(JSON.stringify({ days: 14, scannedSessions: 9, matches: [] }), 'q'), /^No matches for "q" \(9 sessions scanned, last 14 days, all projects\)\. Older threads: .*days: 0/)
  assert.match(formatSearch(JSON.stringify({ days: 0, scannedSessions: 9, matches: [] }), 'q'), /all time, all projects\)\.$/)
  assert.equal(formatSearch('', 'q'), 'ERROR: search for "q" returned no output')
  assert.match(formatSearch('ERROR: boom', 'q'), /^ERROR: boom/)
})

test('logger stripping keeps result lines like "No matches found"', () => {
  const raw = '│  19:26 CLI      Connecting to OpenCode server for /a...\n│  19:27 CLI      No matches found for Sky in 1 project(s) (3 sessions scanned, the last 14 days)\n'
  assert.equal(stripLoggerLines(raw).trim(), 'No matches found for Sky in 1 project(s) (3 sessions scanned, the last 14 days)')
  assert.equal(loggerFailure('■  19:26 CLI      Failed to connect to OpenCode: x\n'), 'ERROR: Failed to connect to OpenCode: x')
  assert.equal(loggerFailure('■  19:26 CLI      Failed\nreal output\n'), null)
})

test('sendOutcome: delivered only when kimaki posted (URL), explicit failed/unconfirmed otherwise', () => {
  const url = 'https://discord.com/channels/148929/155631'
  assert.deepEqual(sendOutcome(run({ out: `│ Prompt sent to thread: x │\nSession: ses_0a1b2c3d4ffeAAAAexampleAA1\n${url}\n` })), { status: 'delivered', url, sessionId: 'ses_0a1b2c3d4ffeAAAAexampleAA1', detail: 'posted' })
  assert.equal(sendOutcome(run({ out: 'transcript tail…', head: `${url}\n`, timedOut: true, code: null })).status, 'delivered', 'ask --wait killed after posting = delivered, reply pending')
  assert.equal(sendOutcome(run({ out: '', timedOut: true, code: null })).status, 'unconfirmed')
  assert.deepEqual(sendOutcome(run({ out: 'ERROR: Thread not found', code: 64 })), { status: 'failed', detail: 'Thread not found' })
  assert.equal(sendOutcome(run({ out: '', code: 64 })).status, 'failed')
  assert.equal(sendOutcome(run({ out: '', code: 64 })).detail, 'kimaki exited with code 64')
})

test('future session status --json is parsed leniently', () => {
  const r = parseStatusJson('{"status":"blocked","lastError":{"name":"ContentFilterError","message":"blocked","at":"2026-10-04T10:00:00Z"},"model":"anthropic/claude-opus-5-5","contextTokens":120000,"lastActivityAt":1790000000000,"awaitingReply":false}')!
  assert.equal(r.state, 'blocked')
  assert.deepEqual(r.lastError, { name: 'ContentFilterError', message: 'blocked', at: Date.parse('2026-10-04T10:00:00Z') })
  assert.equal(r.contextTokens, 120000)
  assert.equal(parseStatusJson('{"state":"busy"}')!.state, 'working')
  assert.equal(parseStatusJson('{"status":"showing-question"}')!.state, 'question')
  assert.equal(parseStatusJson('{"status":"weird"}'), null)
  assert.equal(parseStatusJson('Unknown command: session status'), null)
})

test('session status detection from `kimaki session --help`', () => {
  assert.equal(helpListsStatus(fx('kimaki-session-help-0.31.txt')), false, '0.31 has no session status')
  assert.equal(helpListsStatus('  session read <sessionId>   Read\n  session status <sessionId>  State as JSON\n'), true)
  assert.equal(helpListsStatus('  session list   List sessions with their session status column\n'), false)
})

test('lock port and JSON extraction helpers', () => {
  assert.equal(kimakiLockPort({}), 29988)
  assert.equal(kimakiLockPort({ KIMAKI_LOCK_PORT: '31000' }), 31000)
  assert.equal(kimakiLockPort({ KIMAKI_LOCK_PORT: 'nope' }, 30500), 30500)
  assert.deepEqual(extractJson('log {x} line\n{"a":1}', '{'), { a: 1 })
})
