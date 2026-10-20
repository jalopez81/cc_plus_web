import asyncio, json, sys, time, wave, statistics
import websockets

URL, N, WAV = sys.argv[1], int(sys.argv[2]), sys.argv[3]
STAGGER = float(sys.argv[4]) if len(sys.argv) > 4 else 1.3   # segundos entre inicios
SR, CHUNK = 16000, 4096

with wave.open(WAV) as w:
    assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (SR, 1, 2), "usa 16 kHz mono PCM16"
    PCM = w.readframes(w.getnframes())
SPEECH_END = len(PCM) / 2 / SR
PCM += b"\x00" * (SR * 2 * 2)                                  # 2 s de silencio final

async def client(i, results):
    await asyncio.sleep(i * STAGGER)
    msgs = []
    try:
        async with websockets.connect(URL, max_size=None) as ws:
            t0 = time.perf_counter()

            async def reader():
                try:
                    async for m in ws:
                        d = json.loads(m)
                        if d.get("transcript"):
                            msgs.append(time.perf_counter() - t0)
                except websockets.ConnectionClosed:
                    pass

            r = asyncio.create_task(reader())
            step = CHUNK * 2
            for n, off in enumerate(range(0, len(PCM), step), start=1):
                await ws.send(PCM[off:off + step])
                await asyncio.sleep(max(0, t0 + n * CHUNK / SR - time.perf_counter()))
            await asyncio.sleep(15)                              # esperar respuestas pendientes
            r.cancel()
    except Exception as e:
        print(f"[cliente {i}] error: {e}")
    results[i] = (len(msgs), (msgs[-1] - SPEECH_END) if msgs else None)

async def main():
    results = {}
    await asyncio.gather(*(client(i, results) for i in range(N)))
    print(f"\n== {N} clientes ==")
    tails = []
    for i in sorted(results):
        n, tail = results[i]
        print(f"cliente {i}: {n} frases, retraso de la última: {tail:.1f} s" if tail is not None else f"cliente {i}: sin respuestas")
        if tail is not None:
            tails.append(tail)
    if tails:
        print(f"retraso medio {statistics.mean(tails):.1f} s | máximo {max(tails):.1f} s")

asyncio.run(main())