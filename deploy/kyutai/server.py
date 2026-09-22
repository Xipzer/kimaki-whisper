"""Kyutai STT + TTS streaming server (PyTorch) for Wendy.

  ws://host:8010/stt   client -> binary float32 PCM @24k, 1920 samples (80 ms) per frame
                       server -> {"type":"ready"} | {"type":"word","text":..,"t":..}
                                 | {"type":"vad","p":..,"t":..} every frame
  ws://host:8010/tts   client -> {"type":"text","text":"..."} (words, whitespace-delimited) | {"type":"eos"}
                       server -> {"type":"ready"} | binary float32 PCM @24k, 1920 samples/frame | {"type":"done"}
  GET  /health         {"ok":true, "stt":bool, "tts":bool, "sessions":{...}}

One live session per endpoint (Wendy has one owner). A new session pre-empts the old.
"""
import asyncio, json, os, queue, threading, time, sys
import numpy as np, torch, websockets
from websockets.asyncio.server import serve
from moshi.models.loaders import CheckpointInfo
from moshi.models import LMGen
from moshi.models.tts import TTSModel, script_to_entries
from moshi.conditioners import dropout_all_conditions

PORT = int(os.environ.get("PORT", "8010"))
DEVICE = "cuda"
STT_REPO = os.environ.get("STT_REPO", "kyutai/stt-1b-en_fr-candle")
TTS_REPO = os.environ.get("TTS_REPO", "kyutai/tts-1.6b-en_fr")
# Expresso speakers: ex01 + ex04 are female, ex02 + ex03 male; channel1 = first-named speaker.
TTS_VOICE = os.environ.get("TTS_VOICE", "expresso/ex04-ex02_happy_001_channel1_118s.wav")
log = lambda *a: print(time.strftime("[%H:%M:%S]"), *a, flush=True)

# ── models ────────────────────────────────────────────────────────────
t0 = time.time()
stt_info = CheckpointInfo.from_hf_repo(STT_REPO)
stt_mimi = stt_info.get_mimi(device=DEVICE)
stt_tok = stt_info.get_text_tokenizer()
stt_lm = stt_info.get_moshi(device=DEVICE, dtype=torch.bfloat16)
stt_gen = LMGen(stt_lm, temp=0, temp_text=0.0)
STT_DELAY = stt_info.stt_config.get("audio_delay_seconds", 0.5)
STT_PREFIX = stt_info.stt_config.get("audio_silence_prefix_seconds", 1.0)
FRAME = stt_mimi.frame_size          # 1920 @ 24k
FRAME_RATE = stt_mimi.frame_rate     # 12.5
log(f"stt loaded ({STT_REPO}) delay={STT_DELAY}s frame={FRAME} in {time.time()-t0:.1f}s")

t0 = time.time()
tts_info = CheckpointInfo.from_hf_repo(TTS_REPO)
tts_model = TTSModel.from_checkpoint_info(tts_info, n_q=32, temp=0.6, device=DEVICE)
voice_cache = {}
def voice_attrs(name):
    if name not in voice_cache:
        voice_cache[name] = tts_model.make_condition_attributes([tts_model.get_voice_path(name)], cfg_coef=2.0)
    return voice_cache[name]
tts_attrs = voice_attrs(TTS_VOICE)
log(f"tts loaded ({TTS_REPO}, voice {TTS_VOICE}) in {time.time()-t0:.1f}s")
log(f"vram {torch.cuda.memory_allocated()/2**30:.2f} GiB allocated")

gpu_lock = threading.Lock()  # one CUDA stepper at a time keeps both models' streaming state sane
sessions = {"stt": None, "tts": None}

# ── STT session ───────────────────────────────────────────────────────
class SttSession:
    def __init__(self, ws, loop):
        self.ws, self.loop, self.inq, self.alive = ws, loop, queue.Queue(), True
        self.th = threading.Thread(target=self.run, daemon=True); self.th.start()
    def send(self, obj):
        asyncio.run_coroutine_threadsafe(self.ws.send(json.dumps(obj)), self.loop)
    def stop(self):
        self.alive = False; self.inq.put(None)
    @torch.no_grad()
    def run(self):
        try: self._run()
        except Exception as e:
            log('stt session error:', repr(e)); self.send({'type': 'error', 'message': str(e)})
        finally: asyncio.run_coroutine_threadsafe(self.ws.close(), self.loop)
    def _run(self):
        silence = torch.zeros((1, 1, FRAME), dtype=torch.float32, device=DEVICE)
        with stt_mimi.streaming(1), stt_gen.streaming(1):
            n = 0
            for _ in range(int(STT_PREFIX * FRAME_RATE)):
                with gpu_lock: stt_gen.step_with_extra_heads(stt_mimi.encode(silence))
                n += 1
            self.send({"type": "ready"})
            word = ""
            while self.alive:
                buf = self.inq.get()
                if buf is None: break
                pcm = torch.from_numpy(np.frombuffer(buf, dtype=np.float32).copy()).to(DEVICE)[None, None, :]
                t = n / FRAME_RATE - STT_PREFIX - STT_DELAY
                with gpu_lock:
                    text_tokens, vad = stt_gen.step_with_extra_heads(stt_mimi.encode(pcm))
                n += 1
                tok = int(text_tokens[0, 0, 0].item())
                if vad: self.send({"type": "vad", "p": float(vad[2][0, 0, 0].item()), "t": round(t, 2)})
                if tok not in (0, 3):
                    piece = stt_tok.id_to_piece(tok)
                    if piece.startswith("▁") and word:
                        self.send({"type": "word", "text": word, "t": round(t, 2)}); word = ""
                    word += piece.replace("▁", " ")
                elif tok == 3 and word.strip():
                    # padding after content = word boundary
                    self.send({"type": "word", "text": word, "t": round(t, 2)}); word = ""

# ── TTS session ───────────────────────────────────────────────────────
class TtsSession:
    def __init__(self, ws, loop, voice):
        self.ws, self.loop, self.inq, self.alive, self.voice = ws, loop, queue.Queue(), True, voice
        self.th = threading.Thread(target=self.run, daemon=True); self.th.start()
    def send(self, obj):
        asyncio.run_coroutine_threadsafe(self.ws.send(obj if isinstance(obj, bytes) else json.dumps(obj)), self.loop)
    def stop(self):
        self.alive = False; self.inq.put(None)
    @torch.no_grad()
    def run(self):
        try: self._run()
        except Exception as e:
            log('tts session error:', repr(e)); self.send({'type': 'error', 'message': str(e)})
        finally: asyncio.run_coroutine_threadsafe(self.ws.close(), self.loop)
    def _run(self):
        m = tts_model
        attrs = [voice_attrs(self.voice)]
        if m.cfg_coef != 1.0 and not m.valid_cfg_conditionings: attrs = attrs + dropout_all_conditions(attrs)
        cond = m.lm.condition_provider(m.lm.condition_provider.prepare(attrs))
        state = m.machine.new_state([])
        offset = [0]
        def on_text_logits(tl):
            if m.padding_bonus: tl[..., m.machine.token_ids.pad] += m.padding_bonus
            return tl
        def on_audio(at):
            for q in range(at.shape[1]):
                if offset[0] < m.lm.delays[q + m.lm.audio_offset] + m.delay_steps: at[:, q] = m.machine.token_ids.zero
        def on_text(tt):
            out = [m.machine.process(offset[0], state, t)[0] for t in tt.tolist()]
            tt[:] = torch.tensor(out, dtype=torch.long, device=tt.device)
        m.lm.dep_q = m.n_q
        gen = LMGen(m.lm, temp=m.temp, temp_text=m.temp, cfg_coef=m.cfg_coef, condition_tensors=cond,
                    on_text_logits_hook=on_text_logits, on_text_hook=on_text, on_audio_hook=on_audio,
                    cfg_is_masked_until=None, cfg_is_no_text=True)
        missing = m.lm.n_q - m.lm.dep_q
        zeros = torch.full((1, missing, 1), m.machine.token_ids.zero, dtype=torch.long, device=m.lm.device)
        first_frame_at = [None]
        def step():
            with gpu_lock:
                frame = gen.step(zeros)
                offset[0] += 1
                if frame is not None and (frame != -1).all():
                    pcm = m.mimi.decode(frame[:, 1:, :]).cpu().numpy()
                    if first_frame_at[0] is None: first_frame_at[0] = time.time()
                    self.send(np.clip(pcm[0, 0], -1, 1).astype(np.float32).tobytes())
        with gen.streaming(1), m.mimi.streaming(1):
            self.send({"type": "ready"})
            first = True; t_start = time.time()
            while self.alive:
                msg = self.inq.get()
                if msg is None: break
                if msg.get("type") == "text":
                    txt = msg["text"].strip()
                    if not txt: continue
                    for e in script_to_entries(m.tokenizer, m.machine.token_ids, m.mimi.frame_rate, [txt], multi_speaker=first and m.multi_speaker, padding_between=1):
                        state.entries.append(e)
                        while len(state.entries) > m.machine.second_stream_ahead and self.alive: step()
                    first = False
                elif msg.get("type") == "eos":
                    while (len(state.entries) > 0 or state.end_step is not None) and self.alive: step()
                    for _ in range(m.delay_steps + max(m.lm.delays) + 8):
                        if not self.alive: break
                        step()
                    self.send({"type": "done", "first_audio_ms": round((first_frame_at[0] - t_start) * 1000) if first_frame_at[0] else None})
                    break

# ── ws routing ────────────────────────────────────────────────────────
async def handler(ws):
    path = ws.request.path
    loop = asyncio.get_running_loop()
    if path.split("?")[0] == "/stt":
        if sessions["stt"]: sessions["stt"].stop()
        s = sessions["stt"] = SttSession(ws, loop)
        try:
            async for msg in ws:
                if isinstance(msg, bytes): s.inq.put(msg)
        finally:
            s.stop()
            if sessions["stt"] is s: sessions["stt"] = None
    elif path.split("?")[0] == "/tts":
        if sessions["tts"]: sessions["tts"].stop()
        q = dict(p.split('=', 1) for p in ws.request.path.split('?', 1)[1].split('&')) if '?' in ws.request.path else {}
        s = sessions["tts"] = TtsSession(ws, loop, q.get('voice', TTS_VOICE))
        try:
            async for msg in ws:
                if isinstance(msg, str): s.inq.put(json.loads(msg))
        finally:
            s.stop()
            if sessions["tts"] is s: sessions["tts"] = None
    else:
        await ws.close(1008, "unknown path")

async def health(conn, req):
    if req.path == "/health":
        body = json.dumps({"ok": True, "stt": True, "tts": True, "voice": TTS_VOICE,
                           "sessions": {k: bool(v) for k, v in sessions.items()}}).encode()
        return conn.respond(200, body.decode() + "\n")
    return None

async def main():
    async with serve(handler, "0.0.0.0", PORT, process_request=health, max_size=None):
        log(f"kyutai server on :{PORT}  (/stt /tts /health)")
        await asyncio.Future()

asyncio.run(main())
