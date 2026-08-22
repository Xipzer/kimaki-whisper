// Live-fire chaos sim: drives the REAL think() pipeline (real brain, real tools)
// with overlapping/messy group-call-style utterances. Backs up & restores state.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ws = path.join(os.homedir(), '.kimaki-whisper', 'workspace')
const cfg = path.join(os.homedir(), '.kimaki-whisper')
const backups = {}
for (const f of [path.join(ws, 'history.json'), path.join(cfg, 'routes.json'), path.join(ws, 'nicknames.json')]) {
  backups[f] = fs.existsSync(f) ? fs.readFileSync(f) : null
}
const restore = () => {
  for (const [f, buf] of Object.entries(backups)) {
    if (buf) fs.writeFileSync(f, buf)
    else if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  console.log('── state restored')
}
process.on('exit', restore)

const { think, spokenTranscript } = await import('../dist/wendy.js')
const PROMISE = /\b(let me|i'?ll (check|go|look|dig|find|pull|grab|get)|one (sec|second|moment)|hold on|checking now|give me a (sec|second|moment|minute)|right back)\b/i

const scenarios = [
  {
    name: 'S1 messy self-correcting request + background chatter',
    utter: "hey wendy can you check the uh— no wait. hahaha stop it dude, I'm asking wendy something. ok yeah wendy, the launcher thread, what's the latest in there? someone's mowing outside sorry about the noise",
    expect: 'tool use + substantive answer about launcher',
  },
  {
    name: 'S2 pure chatter (should not spawn work)',
    utter: "no way hahaha that's insane. anyway what were you saying about the barbecue on saturday?",
    expect: 'brief social reply, no heavy tool chains',
  },
  {
    name: 'S3 rapid topic-switch double request',
    utter: "wendy what routes do you know — actually no, first: how many threads are in your index right now, THEN tell me the routes",
    expect: 'both answered in one turn',
  },
  {
    name: 'S4 promise-bait (vague, tempts a "let me check" stall)',
    utter: "wendy did anything happen in basestonk recently? like any activity at all",
    expect: 'must NOT end on a bare promise — detector or tools fire',
  },
]

let pass = 0, fail = 0
for (const s of scenarios) {
  console.log(`\n══ ${s.name}`)
  console.log(`   YOU: ${s.utter}`)
  const spokeBefore = spokenTranscript.length
  const t0 = Date.now()
  let reply
  try { reply = await think(s.utter) } catch (e) { reply = `THREW: ${e.message}` }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const midSpeech = spokenTranscript.slice(spokeBefore)
  for (const m of midSpeech) console.log(`   🗣 mid-turn: "${m}"`)
  console.log(`   WENDY (${secs}s): ${reply.slice(0, 300)}`)
  const bare = PROMISE.test(reply) && reply.length < 80
  const ok = !reply.startsWith('THREW') && reply.length > 5 && !bare
  console.log(`   ${ok ? '✅' : '❌'} ${s.expect}${bare ? ' — ENDED ON BARE PROMISE' : ''}`)
  ok ? pass++ : fail++
}
console.log(`\n══ RESULT: ${pass}/${scenarios.length} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
