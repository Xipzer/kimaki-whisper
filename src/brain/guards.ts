// Deterministic policy: the rules that must hold regardless of what the model
// says. Everything here is a pure function of its inputs - no I/O, no clocks
// unless passed in - so it is unit-testable and cannot drift between the
// conversation loop and the background worker.

/** Tools whose execution has side effects on other people/threads. */
export const DISPATCH_TOOLS = ['send_to_session', 'ask_thread', 'dispatch_task', 'telegram_send', 'telegram_reply'] as const
export const THREAD_DISPATCH_TOOLS = ['send_to_session', 'ask_thread'] as const
export const isDispatchTool = (name: string): boolean => (DISPATCH_TOOLS as readonly string[]).includes(name)
export const isThreadDispatchTool = (name: string): boolean => (THREAD_DISPATCH_TOOLS as readonly string[]).includes(name)

/** A tool result that means "something actually happened". */
export const dispatchSucceeded = (result: string): boolean =>
  !/^(ERROR|BLOCKED|DUPLICATE|HELD|STOP)/.test(result)

/** Past-tense claims that a send/relay was completed. Third-party sends
 *  ("he sent me a photo") are excluded by lookbehind. */
export const SEND_CLAIM = /(?<!\b(?:he|she|they|you|xipz|who|owner)\s)\b(sent( it| that| this| him| her| them)?|dispatched|fired (it|that|this) (off|into|to)|relayed|forwarded|passed (it|that|this) (along|on)|told (him|her|them|the (thread|builder|agent))|asked the (thread|builder|agent)|it'?s in there|in the (pinned )?thread now)\b/i
export const claimsSend = (text: string): boolean => SEND_CLAIM.test(text)
/** An ACK-shaped send claim: the claim carries the reply. A long answer with a
 *  send-word buried mid-paragraph is not one (live false positive: a 1.5k-char
 *  assessment was replaced by an apology because of one clause in paragraph 4). */
export function sendClaimAck(text: string): { phrase: string } | null {
  const m = text.match(SEND_CLAIM)
  if (!m || m.index === undefined) return null
  const short = text.length <= 350
  const early = m.index <= 160
  return short || early ? { phrase: text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 20) } : null
}

/** Future-tense commitments to act that the turn must not end on. */
export const BROAD_PROMISE = /\b(i'?ll|i will|let me|gonna|going to|one (sec|second|moment)|hold on|right back|having (a bit of )?trouble|can'?t seem to|struggling to|keep looking)\b/i
export const soundsLikePromise = (text: string): boolean => BROAD_PROMISE.test(text)

/** Identity of a dispatch for duplicate detection: tool + target + normalised body. */
export function dispatchKey(name: string, args: Record<string, unknown>): string {
  const target = String(args.session_id ?? args.target ?? args.title ?? '')
  const body = String(args.prompt ?? args.text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  return `${name}|${target}|${body}`
}

/** "[MED] [LOW] x" -> "[MED] x": a summarizer that emits its own tag gets
 *  prefixed again by the caller. Keep the intended leading tag. */
export function collapsePriorityTags(text: string): string {
  const stacked = text.match(/^((?:\[(?:HIGH|MED|LOW)\]\s*){2,})/i)
  if (!stacked) return text
  const first = stacked[1].match(/\[(?:HIGH|MED|LOW)\]/i)![0]
  return `${first} ${text.slice(stacked[1].length)}`
}

/** Items the owner is waiting on: bypass anti-spam cooldowns. */
export const isUrgentUpdate = (text: string): boolean =>
  text.includes('just FINISHED') || text.includes('[HIGH]') || text.includes('Background task finished')

/** Markers that identify an item's source for one-per-source queue replacement. */
export function queueDedupeMarkers(text: string, srcId?: string): string[] {
  const out: string[] = []
  const tg = text.match(/<tg:[^>]+>/); if (tg) out.push(tg[0])
  if (srcId) out.push(`src:${srcId}`)
  const repo = text.match(/New commit in ([\w.-]+)/); if (repo) out.push(`New commit in ${repo[1]}`)
  const dm = text.match(/Telegram from ([^(:\n]+)/); if (dm) out.push(`Telegram from ${dm[1].trim()}`)
  return out
}

export type ChatMsg = { role: string; content?: unknown; tool_calls?: unknown }
/** Newer llama.cpp rejects adjacent assistant messages. Merge plain-text
 *  neighbours in place; tool-call messages never merge. Optionally append a
 *  resume nudge when the history would otherwise end on an assistant turn. */
export function repairHistory<T extends ChatMsg>(msgs: T[], resumeNudge?: string): T[] {
  for (let i = msgs.length - 1; i > 0; i--) {
    const a = msgs[i - 1], b = msgs[i]
    if (a.role === 'assistant' && b.role === 'assistant' && !a.tool_calls && !b.tool_calls) {
      a.content = `${String(a.content ?? '')}\n${String(b.content ?? '')}`.trim()
      msgs.splice(i, 1)
    }
  }
  if (resumeNudge && msgs[msgs.length - 1]?.role === 'assistant') msgs.push({ role: 'user', content: resumeNudge } as T)
  return msgs
}

/** Session ids proven real by a tool result. */
export const SESSION_ID = /\bses_\w{10,}\b/g
export const isSessionId = (s: string): boolean => /^ses_\w{10,}$/.test(s)

export const stripReminderPrefix = (note: string): string => note.replace(/^\s*reminder:?\s*/i, '')

/** An utterance cut mid-thought: trailing connective/comma, or a bare filler.
 *  Human speech pauses here; the mic gate should not treat it as the end. */
export const TRAILING_FRAGMENT = /(,|;|\b(i mean|so|and|but|like|um|uh|er|because|basically|then|well|actually|you know))\s*[.]?\s*$/i
export const isTrailingFragment = (text: string): boolean => {
  const t = text.trim()
  if (!t) return false
  const words = t.split(/\s+/).length
  return TRAILING_FRAGMENT.test(t) || (words <= 2 && !/[?!]$/.test(t) && /^(yeah|yes|yep|okay|ok|so|well|right|sure|hmm|um)\b/i.test(t))
}

/** "Yes" to an offer she just made ("want the updates?"). */
export const AFFIRMATIVE = /^\W*(yeah|yes|yep|yup|sure|go on|go ahead|please|do it|hit me|okay|ok|absolutely|of course)\b/i
export const isAffirmative = (text: string): boolean => AFFIRMATIVE.test(text.trim())
