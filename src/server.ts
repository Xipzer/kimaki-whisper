// Local OpenAI-compatible endpoint Kimaki points at (OPENAI_BASE_URL).
// Impersonates POST /v1/chat/completions for Kimaki's chat-with-audio
// transcription request and returns the transcriptionResult tool call it
// expects. Logic ported from the battle-tested kimaki-whisper-shim.
//
// Transcription source (by config):
//   - built-in ONNX model (config.model)          — zero-setup path
//   - external backend  (config.backendUrl)      — advanced/GPU path, proxied
import http from 'node:http'
import { loadConfig, DEFAULT_PORT, log } from './config.js'
import { transcribeOgg } from './transcribe/local-onnx.js'

interface ContentPart {
  type: string
  text?: string
  input_audio?: { data: string; format?: string }
  file?: { data?: string; file_data?: string; media_type?: string; mediaType?: string }
  audio_url?: { url: string }
}
interface ChatBody {
  messages?: Array<{ role: string; content: string | ContentPart[] }>
}

function extractAudio(body: ChatBody): { bytes: Buffer; format: string } | null {
  for (const msg of body.messages ?? []) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.input_audio?.data)
        return { bytes: Buffer.from(part.input_audio.data, 'base64'), format: part.input_audio.format ?? 'ogg' }
      const fileData = part.file?.data ?? part.file?.file_data
      if (fileData) return { bytes: Buffer.from(fileData, 'base64'), format: 'ogg' }
      if (part.audio_url?.url?.startsWith('data:')) {
        const b64 = part.audio_url.url.split(',')[1] ?? ''
        return { bytes: Buffer.from(b64, 'base64'), format: 'ogg' }
      }
    }
  }
  return null
}

const QUEUE_PHRASES = ['queue this message', 'queue this', 'add this to the queue', 'add to the queue', 'queue it']

function postProcess(text: string): { transcription: string; queueMessage: boolean } {
  const lower = text.toLowerCase()
  for (const phrase of QUEUE_PHRASES) {
    const idx = lower.indexOf(phrase)
    if (idx === -1) continue
    const stripped = (text.slice(0, idx) + text.slice(idx + phrase.length))
      .replace(/^[\s.,;:!?-]+/, '').replace(/\s{2,}/g, ' ').trim()
    return { transcription: stripped || text, queueMessage: true }
  }
  return { transcription: text, queueMessage: false }
}

function toolCallResponse(args: { transcription: string; queueMessage?: boolean }) {
  return {
    id: `chatcmpl-kw-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'kimaki-whisper',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_${Date.now()}`,
          type: 'function',
          function: { name: 'transcriptionResult', arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

async function proxyToBackend(bytes: Buffer, backendUrl: string): Promise<Error | string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/ogg' }), 'voice.ogg')
  form.append('model', 'whisper-1')
  form.append('response_format', 'json')
  const url = `${backendUrl.replace(/\/$/, '')}/audio/transcriptions`
  const res = await fetch(url, { method: 'POST', body: form }).catch((e) => new Error(String(e)))
  if (res instanceof Error) return new Error(`backend unreachable: ${res.message}`)
  if (!res.ok) return new Error(`backend ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json().catch(() => ({}))) as { text?: string }
  return (data.text ?? '').trim()
}

export async function transcribeAudioBytes(bytes: Buffer): Promise<Error | string> {
  const cfg = loadConfig()
  if (cfg.backendUrl) return proxyToBackend(bytes, cfg.backendUrl)
  if (cfg.model) return transcribeOgg({ ogg: bytes, modelId: cfg.model })
  return new Error('not configured — run /whisper-setup (or `kimaki-whisper setup --model auto`)')
}

let server: http.Server | null = null

export function isServerRunning(): boolean {
  return server !== null
}

export function startServer(): number {
  if (server) return (server.address() as { port: number }).port
  const port = loadConfig().port ?? DEFAULT_PORT

  server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.url === '/health') return send(200, { ok: true, source: loadConfig().backendUrl ?? loadConfig().model ?? 'unconfigured' })
    if (req.url?.endsWith('/models')) return send(200, { object: 'list', data: [{ id: 'kimaki-whisper', object: 'model', owned_by: 'local' }] })
    if (!req.url?.endsWith('/chat/completions') || req.method !== 'POST') return send(404, { error: { message: 'not found' } })

    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        let body: ChatBody
        try {
          body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody
        } catch {
          return send(400, { error: { message: 'invalid JSON' } })
        }
        const audio = extractAudio(body)
        if (!audio) return send(400, { error: { message: 'no audio content found' } })

        const text = await transcribeAudioBytes(audio.bytes)
        if (text instanceof Error) {
          log('transcription failed:', text.message)
          return send(200, toolCallResponse({ transcription: '[inaudible audio]' }))
        }
        log(`transcribed ${audio.bytes.length}b → "${text.slice(0, 60)}..."`)
        send(200, toolCallResponse(postProcess(text || '[inaudible audio]')))
      })()
    })
  })

  server.listen(port, '127.0.0.1')
  log(`transcription endpoint: http://127.0.0.1:${port}/v1  (point OPENAI_BASE_URL here)`)
  return port
}

export function stopServer(): void {
  server?.close()
  server = null
}
