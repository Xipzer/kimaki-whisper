import asyncio, json, time, sys, glob, os, numpy as np, websockets, sphn

async def tts_bench(text, voice=None, out="/tmp/opencode/tts-bench.wav"):
    t0 = time.time(); first = None; frames = 0; pcm = []
    async with websockets.connect("ws://localhost:8010/tts" + (f"?voice={voice}" if voice else ""), max_size=None, open_timeout=30) as ws:
        assert json.loads(await ws.recv())["type"] == "ready"
        t_ready = time.time()
        for w in text.split(" "): await ws.send(json.dumps({"type": "text", "text": w + " "}))
        await ws.send(json.dumps({"type": "eos"}))
        async for m in ws:
            if isinstance(m, bytes):
                if first is None: first = time.time()
                frames += 1; pcm.append(np.frombuffer(m, dtype=np.float32))
            else:
                d = json.loads(m)
                if d["type"] in ("done", "error"): print("  server:", d); break
    audio = np.concatenate(pcm) if pcm else np.zeros(1, np.float32); dur = len(audio) / 24000
    sphn.write_wav(out, audio, 24000)
    print(f"TTS: ready {(t_ready-t0)*1000:.0f}ms | first audio {((first or t_ready)-t_ready)*1000:.0f}ms after text | {dur:.1f}s audio in {time.time()-t_ready:.1f}s wall (RTF {(time.time()-t_ready)/max(dur,0.01):.2f}) | {frames} frames")

async def stt_bench(path):
    audio, sr = sphn.read(path); audio = audio[0] if audio.ndim > 1 else audio
    if sr != 24000:
        import julius, torch; audio = julius.resample_frac(torch.from_numpy(audio), sr, 24000).numpy()
    audio = audio.astype(np.float32); n = len(audio) // 1920 * 1920; audio = audio[:n]
    words = []; vads = []; t0 = time.time()
    async with websockets.connect("ws://localhost:8010/stt", max_size=None, open_timeout=30) as ws:
        assert json.loads(await ws.recv())["type"] == "ready"
        async def reader():
            async for m in ws:
                d = json.loads(m)
                if d["type"] == "word": words.append((d["text"], d["t"], round(time.time() - t0, 2)))
                elif d["type"] == "vad": vads.append((d["t"], d["p"]))
                elif d["type"] == "error": print("  server:", d)
        rt = asyncio.create_task(reader())
        for i in range(0, n, 1920):
            await ws.send(audio[i:i+1920].tobytes()); await asyncio.sleep(0.08)
        for _ in range(25): await ws.send(np.zeros(1920, np.float32).tobytes()); await asyncio.sleep(0.08)
        await asyncio.sleep(0.3); rt.cancel()
    clip = n / 24000
    print(f"STT: {clip:.1f}s clip → {len(words)} words, wall {time.time()-t0:.1f}s")
    print("  text:", "".join(w for w, _, _ in words).strip()[:400])
    eot = [t for t, p in vads if p > 0.5]
    print(f"  end-of-turn flagged at t={eot[0] if eot else None}s (clip ends {clip:.1f}s); last word wall {words[-1][2] if words else None}s; vad frames {len(vads)}")

which = sys.argv[1] if len(sys.argv) > 1 else "both"
if which == "voices":
    for v in sys.argv[2:]:
        asyncio.run(tts_bench("Hey, it's Wendy. Three things worth your attention. The pool verify is running but sitting three blocks behind, and the design pass was right, it's not a display bug. Anything you want me to dig into?", v, f"/tmp/opencode/voice-{v.split('/')[-1][:24]}.wav"))
if which in ("tts", "both"):
    asyncio.run(tts_bench("Three things worth your attention, in order. The COINc pool verify is running but sitting three blocks behind, and both supplies are still zero. The quiet-chrome design pass was right: it's not a display bug. Anything you want me to dig into?"))
if which in ("stt", "both"):
    f = sorted(glob.glob(os.path.expanduser("~/.kimaki-whisper/lost-audio/*.wav")))
    asyncio.run(stt_bench(sys.argv[2] if len(sys.argv) > 2 else (f[-1] if f else "/tmp/opencode/tts-bench.wav")))
