// The live voice loop: always-on STT with semantic end-of-turn, one TTS
// session per reply with lookahead prosody, barge-in by cancelling the stream.
//
//   LISTEN ──end-of-turn──► (onUtterance) ──► THINK ──first text──► SPEAK ──done──► LISTEN
//      ▲                                                      │ owner speaks ≥2 words
//      └───────────────────── barge-in: cancel tts+player ◄───┘
import { createAudioResource, StreamType, AudioPlayerStatus, entersState, type AudioPlayer, type VoiceConnection } from '@discordjs/voice'
import { SttStream, TtsStream } from './kyutai.js'
import { ownerAudioIn, AudioOut } from './audio.js'
import { log } from '../config.js'
import { diag } from '../diag.js'

const BACKCHANNEL = /^(yeah|yep|yes|ok(ay)?|mhm+|uh-?huh|right|true|sure|lol|haha+|nice|cool|got it|go on|i see|wow|no|nah)[.!,\s]*$/i
const WAKE = /\bw[ei]+nd[iy]e?\b/i

export type LoopHooks = {
  onUtterance: (text: string, meta: { words: number; bargedIn: boolean; cutSpeech: string[] }) => void
  gate: () => { silenced: boolean; nameOnly: boolean; expectingAnswer: boolean }
}

export class VoiceLoop {
  private stt: SttStream | null = null
  private unsub: (() => void) | null = null
  private utter: string[] = []
  private lastWordAt = 0
  private vadEma = 0
  private eotTimer: NodeJS.Timeout | null = null
  // mouth
  private tts: TtsStream | null = null
  private out: AudioOut | null = null
  private spokenThisReply: string[] = []
  private replyStartedAt = 0
  lastSpeechEnd = 0
  lastSpokenText = ''
  bargeCount = 0

  constructor(private connection: VoiceConnection | null, private player: AudioPlayer, private ownerId: string, private hooks: LoopHooks, private audioSource?: (sink: (pcm: Float32Array) => void) => () => void) {}

  async start(): Promise<void> {
    this.stt = new SttStream({
      word: (w, t) => this.onWord(w, t),
      vad: (p) => this.onVad(p),
      close: () => { log('wendy: stt stream closed'); diag('stt_closed', {}); if (!this.stopped) setTimeout(() => void this.reconnect(), 1500) },
    })
    await this.stt.connect()
    const sink = (pcm: Float32Array): void => { this.stt?.push(pcm) }
    this.unsub = this.audioSource ? this.audioSource(sink) : ownerAudioIn(this.connection!.receiver, this.ownerId, sink)
    log('wendy: voice loop live (kyutai stt + tts)')
    diag('loop_started', {})
  }
  private stopped = false
  private async reconnect(): Promise<void> {
    if (this.stopped) return
    try { this.unsub?.(); await this.start() } catch (e) { log('wendy: stt reconnect failed:', (e as Error).message); setTimeout(() => void this.reconnect(), 3000) }
  }
  stop(): void {
    this.stopped = true
    this.unsub?.(); this.unsub = null
    this.stt?.close(); this.stt = null
    this.cancelSpeech('stop')
    if (this.eotTimer) clearTimeout(this.eotTimer)
  }

  // ── ears ──────────────────────────────────────────────────────
  private onWord(w: string, t: number): void {
    const word = w.trim()
    if (!word) return
    this.utter.push(word)
    this.lastWordAt = Date.now()
    diag('word', { w: word, t, n: this.utter.length })
    if (this.speaking) this.maybeBargeIn()
    this.armEot(this.vadArmed ? 650 : 1400, this.vadArmed ? 'vad' : 'timeout')
  }
  // The VAD predicts end-of-turn at the AUDIO position; the text stream trails
  // it by the model delay (0.5 s), so the last word is still in flight when the
  // VAD fires. Commit 650 ms after the crossing, re-armed by any trailing word.
  private vadArmed = false
  private onVad(p: number): void {
    this.vadEma = this.vadEma * 0.6 + p * 0.4
    if (!this.utter.length) { this.vadArmed = false; return }
    if (this.vadEma > 0.6 && !this.vadArmed) { this.vadArmed = true; this.armEot(650, 'vad') }
    if (this.vadEma < 0.3) this.vadArmed = false
  }
  private eotWhy: 'vad' | 'timeout' = 'timeout'
  private armEot(ms = 1400, why: 'vad' | 'timeout' = 'timeout'): void {
    if (this.eotTimer) clearTimeout(this.eotTimer)
    this.eotWhy = why
    // 1.4 s of no new words is the fallback when the VAD never fires (owner trails off)
    this.eotTimer = setTimeout(() => { if (this.utter.length) this.commit(this.eotWhy) }, ms)
  }
  private commit(why: 'vad' | 'timeout'): void {
    if (this.eotTimer) { clearTimeout(this.eotTimer); this.eotTimer = null }
    const text = this.utter.join(' ').replace(/\s+([.,!?])/g, '$1').trim()
    const words = this.utter.length
    this.utter = []
    this.vadEma = 0
    this.vadArmed = false
    if (!text) return
    const g = this.hooks.gate()
    const addressed = WAKE.test(text)
    if (g.silenced && !addressed) { diag('dropped', { why: 'silenced', text: text.slice(0, 60) }); return }
    if (g.nameOnly && !addressed) { diag('dropped', { why: 'name_only', words }); return }
    if (!g.expectingAnswer && BACKCHANNEL.test(text) && !this.speaking && Date.now() - this.lastSpeechEnd > 30000) { diag('dropped', { why: 'backchannel', text }); return }
    const bargedIn = this.bargedThisUtterance
    const cut = bargedIn ? this.cutSpeech.splice(0) : []
    this.bargedThisUtterance = false
    diag('utterance', { text: text.slice(0, 200), words, why, bargedIn })
    this.hooks.onUtterance(text, { words, bargedIn, cutSpeech: cut })
  }

  partialUtterance(): string { return this.utter.join(' ') }
  ownerTalking(): boolean { return this.utter.length > 0 && Date.now() - this.lastWordAt < 1200 }

  // ── barge-in ──────────────────────────────────────────────────
  private bargedThisUtterance = false
  private cutSpeech: string[] = []
  private maybeBargeIn(): void {
    const n = this.utter.length
    const first = this.utter[0]
    const real = n >= 2 || (n === 1 && !BACKCHANNEL.test(first) && first.length > 3)
    if (!real) return
    this.bargeCount++
    this.bargedThisUtterance = true
    this.cutSpeech = this.spokenThisReply.splice(0)
    log('wendy: barge-in - owner spoke over me, cancelling speech')
    diag('barge_in', { heard: this.utter.join(' ') })
    this.cancelSpeech('barge')
  }

  // ── mouth ─────────────────────────────────────────────────────
  get speaking(): boolean {
    const st = this.player.state.status
    return !!this.tts || st === AudioPlayerStatus.Playing || st === AudioPlayerStatus.Buffering
  }
  /** Open a reply session. Text arrives via say(); endReply() flushes. */
  beginReply(): void {
    if (this.tts) return
    this.replyStartedAt = Date.now()
    this.spokenThisReply = []
    const out = new AudioOut()
    let started = false
    const tts = new TtsStream((pcm) => {
      out.pushPcm(pcm)
      if (!started) {
        started = true
        diag('first_audio', { ms: Date.now() - this.replyStartedAt })
        this.player.play(createAudioResource(out, { inputType: StreamType.Raw }))
      }
    })
    this.tts = tts; this.out = out
  }
  say(text: string): void {
    const clean = speakable(text)
    if (!clean) return
    if (!this.tts) this.beginReply()
    this.spokenThisReply.push(clean)
    this.lastSpokenText = clean
    diag('speak', { text: clean })
    void this.tts!.write(clean + ' ')
  }
  async endReply(): Promise<void> {
    const tts = this.tts, out = this.out
    if (!tts || !out) return
    await tts.end()
    const r = await tts.done
    out.finish()
    this.tts = null; this.out = null
    if (!tts.cancelled) {
      await entersState(this.player, AudioPlayerStatus.Idle, 180000).catch(() => {})
      diag('reply_spoken', { ms: Date.now() - this.replyStartedAt, firstAudioMs: r.firstAudioMs, frames: tts.frames })
    }
    this.lastSpeechEnd = Date.now()
  }
  /** One-shot: whole text, wait until played. */
  async speak(text: string): Promise<void> {
    this.beginReply()
    this.say(text)
    await this.endReply()
  }
  cancelSpeech(why: string): void {
    const had = !!this.tts || this.player.state.status !== AudioPlayerStatus.Idle
    this.tts?.cancel(); this.tts = null
    try { this.out?.destroy() } catch {}
    this.out = null
    try { this.player.stop(true) } catch {}
    if (had) diag('speech_cancelled', { why })
    this.lastSpeechEnd = Date.now()
  }
}

export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
}
