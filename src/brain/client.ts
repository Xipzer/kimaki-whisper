// The one path to an inference server. Every request declares a LANE so
// background work (summaries, profiles, worker slices) can be routed to a
// second endpoint (auxBrainUrl) without touching the conversation cache.
// No other module may fetch /v1/chat/completions directly.
import { loadConfig, log } from '../config.js'

// aux = small checks INSIDE a live turn: slot 1, never gated (gating them deadlocked the turn 30 s)
export type Lane = 'conversation' | 'background' | 'aux'
export type BrainOut = {
  content: string
  reasoning?: string
  toolCalls: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>
  timings?: { predicted_per_second?: number; prompt_per_second?: number }
  usage?: { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  error?: string
}
export type BrainMessage = { role: string; content?: string | null; tool_calls?: unknown; tool_call_id?: string; name?: string }

type BrainConfig = { brainUrl?: string; auxBrainUrl?: string; auxBrainModel?: string }
const strip = (u: string): string => u.replace(/\/$/, '')
// Reasoning depth for every brain call (Qwen3.8 template: low | medium | xhigh). Config: brainReasoning.
const effort = (): Record<string, unknown> => ({ chat_template_kwargs: { reasoning_effort: (loadConfig() as { brainReasoning?: string }).brainReasoning ?? 'xhigh' } })

export function brainUrl(): string | undefined { return loadConfig().brainUrl }
export function laneUrl(lane: Lane): string | undefined {
  const c = loadConfig() as BrainConfig
  const u = process.env.WENDY_BRAIN_URL || (lane !== 'conversation' ? (c.auxBrainUrl || c.brainUrl) : c.brainUrl)
  return u ? strip(u) : undefined
}
export function laneModel(lane: Lane): string {
  const c = loadConfig() as BrainConfig
  return lane === 'background' && c.auxBrainUrl ? (c.auxBrainModel ?? 'local-fast') : 'local-fast'
}

// ── health probe: ground truth for the panel, refreshed every 20s ──
let probeUp = false
let probeChecked = false
let onUp: (() => void) | null = null
export function onBrainUp(fn: () => void): void { onUp = fn }
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
    const wasUp = probeUp
    probeUp = res.ok
    if (res.ok && !wasUp && probeChecked) onUp?.()
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
// ── conversation priority ──────────────────────────────────────
// llama.cpp batches both slots together: a background prefill on slot 1 cuts
// her live decode on slot 0 from ~90 to ~20 tok/s (measured). While she is in a
// conversation, background requests WAIT, and any already in flight are
// cancelled and retried once she is idle.
let conversationActive: () => boolean = () => false
export function setConversationActive(fn: () => boolean): void { conversationActive = fn }
const inflightBg = new Set<AbortController>()
export function preemptBackground(): void {
  for (const c of inflightBg) c.abort(new Error('preempted'))
  inflightBg.clear()
}
async function waitForIdle(maxMs = 180000): Promise<void> {
  const t0 = Date.now()
  while (conversationActive() && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 1000))
}

export async function brainFetch(lane: Lane, body: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Response | null> {
  if (lane === 'background') {
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitForIdle()
      const ctl = new AbortController()
      inflightBg.add(ctl)
      const res = await rawFetch(lane, body, { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, ctl.signal]) : ctl.signal })
      inflightBg.delete(ctl)
      if (!ctl.signal.aborted || opts.signal?.aborted) return res
    }
    return null
  }
  return rawFetch(lane, body, opts)
}

async function rawFetch(lane: Lane, body: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<Response | null> {
  const url = laneUrl(lane)
  if (!url) return null
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60000)
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    // One KV slot per lane (server runs -np 2): background summaries can never
    // evict the conversation's cached prefix.
    // toWellFormed: slicing text mid-emoji leaves a lone surrogate, which llama.cpp rejects with a 500.
    body: JSON.stringify({ model: laneModel(lane), cache_prompt: true, id_slot: lane === 'conversation' ? 0 : 1, ...effort(), ...body }).toWellFormed(),
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
export async function brainRequest(lane: Lane, body: Record<string, unknown>, onSentence?: (s: string) => void, signal?: AbortSignal): Promise<BrainOut> {
  const url = laneUrl(lane)
  if (!url) return { content: '', toolCalls: [], error: 'unconfigured' }
  if (lane === 'background') await waitForIdle(30000)
  const stream = !!onSentence
  let res: Response
  try {
    res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: laneModel(lane), cache_prompt: true, id_slot: lane === 'conversation' ? 0 : 1, ...effort(), ...body, ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) }).toWellFormed(),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
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
