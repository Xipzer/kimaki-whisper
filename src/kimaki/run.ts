import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type KimakiRun = { out: string; head: string; code: number | null; timedOut: boolean }
export type KimakiRunner = (args: string[], timeoutMs?: number, maxChars?: number, fromEnd?: boolean) => Promise<KimakiRun>

// kimaki's pretty logger writes '│  HH:MM DB  ...' / '■  HH:MM CLI Failed ...' lines.
// They are noise to the brain except result lines such as "No matches found ...",
// which kimaki also prints through the logger.
const LOGGER_LINE = /^[│■]\s+\d\d:\d\d\s+\S+\s+(.*)\n?/gm
const RESULT_LOG = /^No\b.*\bfound\b/
export function stripLoggerLines(raw: string): string {
  return raw.replace(LOGGER_LINE, (_l, msg: string) => RESULT_LOG.test(msg) ? `${msg}\n` : '')
}
export function loggerFailure(raw: string): string | null {
  const fail = raw.match(/^■\s+\S+\s+CLI\s+(.*)$/m)
  return fail && !raw.replace(/^[│■].*$/gm, '').trim() ? `ERROR: ${fail[1].slice(0, 300)}` : null
}

export const runKimakiDetailed: KimakiRunner = (args, timeoutMs = 30000, maxChars = 6000, fromEnd = false) => {
  // kimaki CLI truncates piped stdout at ~64KB (exits before the pipe drains),
  // so route output through a temp file - file sinks flush completely.
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `wendy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`)
    const cleanup = (): void => { for (const f of [tmp, tmp + '.err']) try { fs.unlinkSync(f) } catch {} }
    const child = spawn('bash', ['-c', `exec kimaki "$@" > '${tmp}' 2> '${tmp}.err'`, 'kimaki', ...args], { stdio: 'ignore' })
    let timedOut = false
    const finish = (code: number | null): void => {
      try {
        let src = tmp
        try { if (!fs.statSync(tmp).size && fs.statSync(tmp + '.err').size) src = tmp + '.err' } catch {}
        const st = fs.statSync(src)
        const window = Math.min(st.size, Math.max(maxChars * 3, 400_000))
        const buf = Buffer.alloc(window)
        const fd = fs.openSync(src, 'r')
        fs.readSync(fd, buf, 0, window, fromEnd ? st.size - window : 0)
        const hb = Buffer.alloc(Math.min(st.size, 4000))
        fs.readSync(fd, hb, 0, hb.length, 0)
        fs.closeSync(fd)
        const raw = buf.toString()
        const head = stripLoggerLines(hb.toString())
        const fail = loggerFailure(raw)
        if (fail) { resolve({ out: fail, head, code, timedOut }); return }
        const out = stripLoggerLines(raw)
        resolve({ out: fromEnd ? out.slice(-maxChars) : out.slice(0, maxChars), head, code, timedOut })
      } catch (e) {
        resolve({ out: `ERROR: ${String((e as Error).message).slice(0, 300)}`, head: '', code, timedOut })
      } finally { cleanup() }
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); cleanup(); resolve({ out: `ERROR: ${String(e.message).slice(0, 300)}`, head: '', code: null, timedOut }) })
    child.on('close', (code) => { clearTimeout(timer); finish(code) })
  })
}

export const runKimaki = (args: string[], timeoutMs = 30000, maxChars = 6000, fromEnd = false): Promise<string> =>
  runKimakiDetailed(args, timeoutMs, maxChars, fromEnd).then((r) => r.out)
