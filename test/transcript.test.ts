import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseTranscript, recentMessages, lastAssistantReply } from '../dist/kimaki/transcript.js'
import { mechanicalSummary } from '../dist/brain/guards.js'

const fx = (f: string): string => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', f), 'utf-8')
const tail = fx('session-read-v031-tail.md')       // real `kimaki session read | tail -c`, 0.31 format, starts mid-attachment
const short = fx('session-read-v031-short.md')     // real full transcript, 0.31 format
const legacy = fx('session-read-legacy.md')        // pre-3a51d493 emoji headers

test('0.31 headers split into messages with roles and models', () => {
  const msgs = parseTranscript(short)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'assistant'])
  assert.equal(msgs[1].model, 'mac-m4/local-fast')
  assert.equal(msgs[1].body, '', 'a tool-only step has no content')
  assert.match(msgs[2].body, /Hostname: \*\*Printer\*\*/)
  assert.ok(!msgs[0].body.includes('[current git branch'), 'kimaki branch suffix stripped')
  assert.ok(!msgs[2].body.includes('duration:'), 'duration footer stripped')
})

test('legacy emoji headers still parse; tool noise stripped, tool errors kept', () => {
  const msgs = parseTranscript(legacy)
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'])
  assert.equal(msgs[1].model, 'claude-opus-5-5')
  assert.ok(!/Started using|🛠️|Completed in/.test(msgs.map((m) => m.body).join('\n')))
  assert.match(msgs[0].body, /\[attached v7-launcher\.md\]/)
  assert.ok(!msgs[0].body.includes('URL:'))
  assert.match(msgs[3].body, /^tool-error: bash forge: command not found/m)
})

test('recentMessages takes the LATEST messages, never the opening of the transcript', () => {
  const r = recentMessages(tail, 3)
  assert.match(r, /Transfer my Aimlabs config/, 'latest user prompt present')
  assert.match(r, /Printer's graphics now match Projector/, 'latest assistant reply present')
  assert.ok(!r.includes('Why your crosshair looks different'), 'older messages beyond n are dropped')
  assert.ok(!r.includes('fnlUWNF'), 'partial attachment before the first header is dropped')
  assert.ok(!/^tool: /m.test(r), 'tool-only steps dropped')
})

test('regression: a long 0.31 transcript no longer yields its first 2000 chars', () => {
  const opening = 'OPENING-PROMPT ' + 'context '.repeat(400)
  const md = `# Title\n\n## Conversation\n\n### user\n\n${opening}\n\n### assistant (anthropic/claude-opus-5-5)\n\n${'early work. '.repeat(300)}\n\n### user\n\nstatus?\n\n### assistant (anthropic/claude-opus-5-5)\n\nLATEST: all 14 tests pass.\n`
  const r = recentMessages(md, 1)
  assert.match(r, /LATEST: all 14 tests pass/)
  assert.ok(!r.includes('OPENING-PROMPT'))
  assert.match(r, /^### 🤖 Assistant \(anthropic\/claude-opus-5-5\)/)
})

test('user prompts are quoted, long assistant bodies keep their end', () => {
  const md = `### user\n\nRead tasks/x.md and follow it\n\n### assistant (m)\n\n${'x'.repeat(10)} ${'filler words '.repeat(400)} THE CONCLUSION.\n`
  const r = recentMessages(md, 2)
  assert.match(r, /^### 👤 User\nPrompt Xipz gave the agent \(quoted, not addressed to you\): "Read tasks\/x\.md and follow it"/)
  assert.match(r, /THE CONCLUSION\.$/)
  assert.match(r, /\n…/)
})

test('no headers at all: falls back to the TAIL of the text', () => {
  const md = 'start-of-window ' + 'y '.repeat(3000) + 'END-OF-TRANSCRIPT'
  const r = recentMessages(md)
  assert.match(r, /END-OF-TRANSCRIPT$/)
  assert.ok(!r.includes('start-of-window'))
})

test('lastAssistantReply (fetch_reply) finds the last real reply in both formats', () => {
  assert.match(lastAssistantReply(short)!.text, /Cores: \*\*32\*\*/)
  assert.equal(lastAssistantReply(short)!.model, 'mac-m4/local-fast')
  assert.match(lastAssistantReply(tail)!.text, /check that Video → Advanced shows Shadows and Particles on Low/)
  assert.match(lastAssistantReply(legacy)!.text, /All 14 fork tests pass now/)
  assert.equal(lastAssistantReply('# t\n\n## Conversation\n\n### user\n\nhi\n'), null)
})

test('mechanicalSummary works on raw transcripts and on recentMessages output', () => {
  assert.match(mechanicalSummary('V7', legacy), /^\[LOW\] V7: All 14 fork tests pass now\./)
  assert.match(mechanicalSummary('CS2', recentMessages(tail, 3)), /^\[LOW\] CS2: .*graphics/i)
  assert.ok(!mechanicalSummary('CS2', recentMessages(tail, 3)).includes('Aimlabs'), 'quoted user prompt never read as the agent reply')
})

test('tool-only steps after the last reply surface as current activity (not for triggers)', () => {
  const md = fx('session-read-v031-tools.md') // real: prompt, then only tool steps
  const r = recentMessages(md, 2)
  assert.match(r, /^### 👤 User\nPrompt Xipz gave the agent/)
  assert.match(r, /\(latest tool steps, no reply text yet: bash Dump stuck session to markdown \(2 lines\); bash Read start and end of session dump \(185 lines\)\)$/)
  assert.ok(!recentMessages(md, 2, false).includes('latest tool steps'))
  assert.ok(!recentMessages(tail, 3).includes('latest tool steps'), 'no trailing tool-only steps -> no activity line')
})
