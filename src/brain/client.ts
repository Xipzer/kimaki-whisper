// The one path to an inference server. Every request declares a LANE so
// background work (summaries, profiles, worker slices) can be routed to a
// second endpoint (auxBrainUrl) without touching the conversation cache.
// No other module may fetch /v1/chat/completions directly.
import { loadConfig, log } from '../config.js'

export type Lane = 'conversation' | 'background'
export type BrainOut = {
  content: string
  reasoning?: string
  toolCalls: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>
  timings?: { predicted_per_second?: number; prompt_per_second?: number }
  usage?: { prompt_tokens?: number }
  error?: string
}
export type BrainMessage = { role: string; content?: string | null; tool_calls?: unknown; tool_call_id?: string; name?: string }

type BrainConfig = { brainUrl?: string; auxBrainUrl?: string; auxBrainModel?: string }
const strip = (u: string): string => u.replace(/\/$/, '')

export function brainUrl(): string | undefined { return loadConfig().brainUrl }
export function laneUrl(lane: Lane): string | undefined {
  const c = loadConfig() as BrainConfig
  const u = lane === 'background' ? (c.auxBrainUrl || c.brainUrl) : c.brainUrl
  return u ? strip(u) : undefined
}
export function laneModel(lane: Lane): string {
  const c = loadConfig() as BrainConfig
  return lane === 'background' && c.auxBrainUrl ? (c.auxBrainModel ?? 'local-fast') : 'local-fast'
}

// ── health probe: ground truth for the panel, refreshed every 20s ──
let probeUp = false
let probeChecked = false
let ctxMax = 147456
export function brainHealth(): { up: boolean; checked: boolean; ctxMax: number } { return { up: probeUp, checked: probeChecked, ctxMax } }
export async function probeBrain(): Promise<void> {
  const url = laneUrl('conversation')
  if (!url) { probeUp = false; probeChecked = true; return }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(`${url}/v1/models`, { signal: ctrl.signal })
    clearTimeout(t)
    probeUp = res.ok
    if (res.ok) {
      const d = (await res.json().catch(() => null)) as { data?: Array<{ meta?: { n_ctx?: number } }> } | null
      const n = d?.data?.[0]?.meta?.n_ctx
      if (n && n > 1000) ctxMax = n
    }
  } catch { probeUp = false }
  probeChecked = true
}
setInterval(() => void probeBrain(), 20000).unref()
void probeBrain()

/** Low-level: identical semantics to fetch(...).catch(() => null), lane-routed.
 *  Callers keep their own response parsing. */
export async function brainFetch(lane: Lane, body: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response | null> {
  const url = laneUrl(lane)
  if (!url) return null
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60000)
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ model: laneModel(lane), cache_prompt: true, ...body }),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  }).catch(() => null)
}

/** Convenience for the common "give me the text" case. */
export async function brainText(lane: Lane, body: Record<string, unknown>, timeoutMs = 60000): Promise<string | null> {
  const res = await brainFetch(lane, body, { timeoutMs })
  if (!res?.ok) return null
  const d = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null
  return d?.choices?.[0]?.message?.content?.trim() ?? null
}

/** Full-featured: streaming sentence callback, tool-call assembly, timings. */
export async function brainRequest(lane: Lane, body: Record<string, unknown>, onSentence?: (s: string) => void): Promise<BrainOut> {
  const url = laneUrl(lane)
  if (!url) return { content: '', toolCalls: [], error: 'unconfigured' }
  const stream = !!onSentence
  let res: Response
  try {
    res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ ...body, ...(stream ? { stream: true } : {}) }),
      signal: AbortSignal.timeout(120000),
    })
  } catch (e) {
    return { content: '', toolCalls: [], error: String((e as Error)?.cause ?? e) }
  }
  if (!res.ok) return { content: '', toolCalls: [], error: `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}` }
  if (!stream) {
    const d = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string; tool_calls?: BrainOut['toolCalls'] } }>; timings?: BrainOut['timings']; usage?: BrainOut['usage'] } | null
    const m = d?.choices?.[0]?.message
    return { content: (m?.content ?? '').trim(), reasoning: (m?.reasoning_content ?? '').trim() || undefined, toolCalls: m?.tool_calls ?? [], timings: d?.timings, usage: d?.usage }
  }
  const toolCalls: BrainOut['toolCalls'] = []
  let content = ''
  let reasoning = ''
  let sentenceBuf = ''
  let timings: BrainOut['timings']
  let usage: BrainOut['usage']
  const flush = (final: boolean): void => {
    for (;;) {
      // Mid-stream: require whitespace AFTER punctuation - buffer ends at chunk
      // boundaries ("...and 18.") and decimals must never fake a sentence end.
      const idx = sentenceBuf.search(final ? /[.!?](\s|$)/ : /[.!?]\s/)
      if (idx === -1) break
      const sent = sentenceBuf.slice(0, idx + 1).trim()
      const rest = sentenceBuf.slice(idx + 1).replace(/^\s+/, '')
      if (!final && sent.length < 25 && !rest) break
      sentenceBuf = rest
      if (sent.length >= 4) onSentence!(sent)
      if (!sentenceBuf) break
    }
    if (final) {
      const t = sentenceBuf.trim()
      if (t.length >= 2) onSentence!(t)
      sentenceBuf = ''
    }
  }
  try {
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let carry = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      carry += dec.decode(value, { stream: true })
      const lines = carry.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) {
        const l = line.trim()
        if (!l.startsWith('data:')) continue
        const payload = l.slice(5).trim()
        if (payload === '[DONE]') continue
        let j: { timings?: BrainOut['timings']; usage?: BrainOut['usage']; choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> }
        try { j = JSON.parse(payload) } catch { continue }
        if (j.timings) timings = j.timings
        if (j.usage) usage = j.usage
        const delta = j.choices?.[0]?.delta
        if (!delta) continue
        if (delta.reasoning_content) reasoning += delta.reasoning_content
        if (delta.content) {
          content += delta.content
          sentenceBuf += delta.content
          if (!toolCalls.length) flush(false)
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0
          toolCalls[i] ??= { id: tc.id ?? `tc${i}`, type: 'function', function: { name: '', arguments: '' } }
          if (tc.id) toolCalls[i].id = tc.id
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
        }
      }
    }
  } catch (e) {
    log('wendy: stream interrupted:', (e as Error).message)
  }
  if (!toolCalls.length) flush(true)
  return { content: content.trim(), reasoning: reasoning.trim() || undefined, toolCalls: toolCalls.filter((t) => t.function.name), timings, usage }
}
