import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimsSend, soundsLikePromise, dispatchKey, collapsePriorityTags, repairHistory, queueDedupeMarkers, isUrgentUpdate, dispatchSucceeded, isDispatchTool, stripReminderPrefix } from '../dist/brain/guards.js'

test('claimsSend catches first-person completed sends, not third-party', () => {
  for (const t of ['Sent it — investigating first.', "It's in there now — the pinned thread.", 'I passed that along to the builder.', 'I sent him the summary.']) assert.equal(claimsSend(t), true, t)
  for (const t of ['He sent me a photo earlier.', 'They sent the report over.', 'The tests pass and the build is green.', 'Want me to dig in?']) assert.equal(claimsSend(t), false, t)
})

test('soundsLikePromise', () => {
  assert.equal(soundsLikePromise("I'll check the thread and get back."), true)
  assert.equal(soundsLikePromise('The launcher is on Base.'), false)
})

test('dispatchKey normalises whitespace/case, keeps target', () => {
  const a = dispatchKey('ask_thread', { session_id: 'ses_x', prompt: 'Hello   World' })
  const b = dispatchKey('ask_thread', { session_id: 'ses_x', prompt: 'hello world' })
  assert.equal(a, b)
  assert.notEqual(a, dispatchKey('ask_thread', { session_id: 'ses_y', prompt: 'hello world' }))
})

test('collapsePriorityTags', () => {
  assert.equal(collapsePriorityTags('[MED] [LOW] Telegram from Jian: hi'), '[MED] Telegram from Jian: hi')
  assert.equal(collapsePriorityTags('[HIGH] one'), '[HIGH] one')
  assert.equal(collapsePriorityTags('no tag'), 'no tag')
})

test('repairHistory merges adjacent assistant text, keeps tool calls, adds nudge', () => {
  const m = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a1' },
    { role: 'assistant', content: 'a2' },
    { role: 'assistant', content: null, tool_calls: [{}] },
    { role: 'tool', content: 'r' },
    { role: 'assistant', content: 'a3' },
  ]
  const out = repairHistory(m, 'resume')
  assert.deepEqual(out.map((x) => x.role), ['user', 'assistant', 'assistant', 'tool', 'assistant', 'user'])
  assert.equal(out[1].content, 'a1\na2')
  assert.equal(out[out.length - 1].content, 'resume')
  // no nudge when history ends on user/tool
  assert.equal(repairHistory([{ role: 'user', content: 'x' }], 'resume').length, 1)
})

test('queueDedupeMarkers', () => {
  assert.deepEqual(queueDedupeMarkers('[LOW] "X" has 3 new messages. <tg:X>'), ['<tg:X>'])
  assert.deepEqual(queueDedupeMarkers('[LOW] New commit in BaseStonk: msg', 'ses_a'), ['src:ses_a', 'New commit in BaseStonk'])
  assert.deepEqual(queueDedupeMarkers('[MED] Telegram from Babycow (@bc): hi'), ['Telegram from Babycow'])
})

test('urgency + result classification', () => {
  assert.equal(isUrgentUpdate('[MED] "x" just FINISHED its output'), true)
  assert.equal(isUrgentUpdate('[LOW] New commit'), false)
  assert.equal(dispatchSucceeded('sent to GROUP'), true)
  for (const r of ['ERROR: x', 'BLOCKED by', 'DUPLICATE BLOCKED', 'HELD - owner', 'STOP: filter']) assert.equal(dispatchSucceeded(r), false, r)
  assert.equal(isDispatchTool('telegram_send'), true)
  assert.equal(isDispatchTool('read_session'), false)
})

test('stripReminderPrefix', () => {
  assert.equal(stripReminderPrefix('Reminder: do x'), 'do x')
  assert.equal(stripReminderPrefix('do x'), 'do x')
})

test('sendClaimAck fires on ack-shaped replies only', async () => {
  const { sendClaimAck } = await import('../dist/brain/guards.js')
  assert.ok(sendClaimAck('Sent it — investigating first, back when it lands.'))
  assert.ok(sendClaimAck('Done. I passed that along to the builder and it is working through it now, should be a few minutes at most given the size of the change.'))
  const long = 'Assessed it end to end. Net verdict: a genuine upgrade. '.repeat(12) + 'If a message gets lost, say so and I will have it forwarded. ' + 'More assessment follows here about caches and lanes. '.repeat(6)
  assert.equal(sendClaimAck(long), null)
  assert.equal(sendClaimAck('The tests are green.'), null)
})

test('fragment + affirmative detection', async () => {
  const { isTrailingFragment, isAffirmative } = await import('../dist/brain/guards.js')
  for (const t of ['Yeah, I mean,', 'So basically', 'Okay so', 'and then', 'Yeah']) assert.equal(isTrailingFragment(t), true, t)
  for (const t of ['Can you hear me, Wendy?', 'Yes, give me the updates.', 'Go to the builder thread and read it.', 'No.']) assert.equal(isTrailingFragment(t), false, t)
  for (const t of ['Yeah, I mean, go on', 'Yes', 'sure, hit me', 'Go ahead.']) assert.equal(isAffirmative(t), true, t)
  assert.equal(isAffirmative('Not now.'), false)
})

test('self-directive detection', async () => {
  const { isSelfDirective } = await import('../dist/brain/guards.js')
  assert.equal(isSelfDirective('I want you to go on your own and figure out what changed'), true)
  assert.equal(isSelfDirective('figure out independently what the thread did'), true)
  assert.equal(isSelfDirective("Don't ask the thread, read it yourself."), true)
  assert.equal(isSelfDirective('Ask the builder thread to summarise it'), false)
})

test('summaryIsCompliance catches a summariser that obeyed the quoted prompt', async () => {
  const { summaryIsCompliance, mechanicalSummary } = await import('../dist/brain/guards.js')
  assert.equal(summaryIsCompliance("[HIGH] Xipz, you've pointed me at tasks/b20-heartbeat.md to read and follow — I need to see what's in that file before I can act on it."), true)
  assert.equal(summaryIsCompliance('[LOW] COINc verify: all green, cursor 8 blocks behind, COINc still unissued.'), false)
  const md = '### 👤 User\nRead tasks/b20-heartbeat.md and follow it.\n\n### 🤖 Assistant (x)\n```\nservice inactive\n```\nAll green: watching, in step, and COINc/CRCLc are still unissued and unbuyable.\n'
  assert.equal(mechanicalSummary('COINc verify', md), '[LOW] COINc verify: All green: watching, in step, and COINc/CRCLc are still unissued and unbuyable.')
})

test('repairHistory never mutates the persistent history objects', () => {
  const a = { role: 'assistant', content: 'one' }, b = { role: 'assistant', content: 'two' }
  const history = [{ role: 'user', content: 'q' }, a, b]
  const msgs = repairHistory([...history])
  assert.equal(msgs.length, 2)
  assert.equal(msgs[1].content, 'one\ntwo')
  assert.equal(a.content, 'one', 'history object must be untouched')
  repairHistory([...history])
  assert.equal(a.content, 'one', 'second call must not append again')
})
