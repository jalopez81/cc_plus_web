# Prueba de carga y calidad del servidor de transcripción: N clientes envían el mismo WAV en tiempo real.
#
#   python test_multiple_users.py wss://whisper.tudominio.com/ws/transcribe test.wav CODIGO1,CODIGO2,CODIGO3
#   python test_multiple_users.py wss://… test.wav CODIGO1 --show        # 1 cliente, imprime texto y traducción
#
# Cada cliente necesita su propio código de acceso: el servidor cierra la sesión anterior cuando el mismo
# código se conecta otra vez. Crea códigos de prueba con `python server.py add-code prueba1 --days 1` (y push-codes);
# el tiempo de estas pruebas cuenta como uso de esos códigos.
# El WAV debe ser 16 kHz, mono, PCM de 16 bits, como el que manda la app (y el que guarda SAVE_SEGMENTS).

"""
crear codigos temporales: 
for i in $(seq 1 10); do python server.py add-code prueba$i --days 1 --note "test de carga"; done
"""

import argparse, asyncio, collections, json, math, statistics, time, wave
import websockets

parser = argparse.ArgumentParser(description="Prueba de varios clientes contra el servidor de transcripción")
parser.add_argument("url", help="wss://…/ws/transcribe")
parser.add_argument("wav", help="WAV 16 kHz mono PCM16")
parser.add_argument("codes", nargs="+", help="códigos de acceso, uno por cliente (separados por espacios o comas)")
parser.add_argument("--stagger", type=float, default=1.3, help="segundos entre el inicio de cada cliente")
parser.add_argument("--show", action="store_true", help="imprime cada transcripción y su traducción")
args = parser.parse_args()

CODES = [c.strip() for arg in args.codes for c in arg.split(",") if c.strip()]
SR, CHUNK = 16000, 4096

with wave.open(args.wav) as w:
    assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (SR, 1, 2), "usa 16 kHz mono PCM16"
    PCM = w.readframes(w.getnframes())
SPEECH_END = len(PCM) / 2 / SR
PCM += b"\x00" * (SR * 2 * 2)  # 2 s de silencio final, para que el servidor corte el último segmento


async def client(i, code, results):
    await asyncio.sleep(i * args.stagger)
    r = {"segments": 0, "latencies": [], "last": None, "warn": 0, "numbers": 0, "error": None}
    results[i] = r
    try:
        # El código va como subprotocolo, igual que en la app: new WebSocket(url, ['token', código])
        async with websockets.connect(args.url, max_size=None, subprotocols=["token", code]) as ws:
            t0 = time.perf_counter()
            # Cuándo empezó el servidor con cada segmento en curso ({"processing": true}). Hoy hay uno a la vez,
            # pero el servidor responde siempre en orden: con una cola, cada respuesta va con su propio inicio.
            sent_at = collections.deque()

            async def reader():
                try:
                    async for m in ws:
                        d = json.loads(m)
                        if d.get("error"):
                            r["error"] = d["error"]
                        elif d.get("processing") is True:
                            sent_at.append(time.perf_counter())
                        elif d.get("processing") is False:
                            if sent_at:
                                sent_at.popleft()
                        elif d.get("transcript"):
                            now = time.perf_counter()
                            latency = now - sent_at.popleft() if sent_at else None
                            if latency is not None:
                                r["latencies"].append(latency)
                            r["segments"] += 1
                            r["last"] = now - t0
                            tr = d.get("translation", "")
                            r["warn"] += tr.count("⚠")
                            r["numbers"] += d.get("translation_numbers_ok") is False
                            if args.show:
                                lat = f"{latency:.2f} s" if latency is not None else "?"
                                print(f"[cliente {i}] [{d.get('language', '?').upper()}] ({lat}) {d['transcript']}")
                                if tr:
                                    print(f"{'':>11}↳ [{(d.get('translation_language') or '?').upper()}] {tr}")
                except websockets.ConnectionClosed:
                    pass

            reader_task = asyncio.create_task(reader())
            step = CHUNK * 2
            for n, off in enumerate(range(0, len(PCM), step), start=1):
                await ws.send(PCM[off:off + step])
                await asyncio.sleep(max(0, t0 + n * CHUNK / SR - time.perf_counter()))
            await asyncio.sleep(15)  # esperar respuestas pendientes
            reader_task.cancel()
    except Exception as e:
        r["error"] = str(e)


async def main():
    results = {}
    await asyncio.gather(*(client(i, code, results) for i, code in enumerate(CODES)))
    print(f"\n== {len(CODES)} cliente(s) · audio de {SPEECH_END:.1f} s ==")
    all_lat, tails = [], []
    for i in sorted(results):
        r = results[i]
        if r["error"]:
            print(f"cliente {i}: error: {r['error']}")
            continue
        if not r["segments"]:
            print(f"cliente {i}: sin respuestas")
            continue
        lat = r["latencies"]
        all_lat += lat
        tail = r["last"] - SPEECH_END
        lat_txt = f"latencia media {statistics.mean(lat):.2f} s, máx {max(lat):.2f} s" if lat else "latencia ?"
        extra = (f" · ⚠ sin traducir: {r['warn']}" if r["warn"] else "") + \
                (f" · cifras distintas: {r['numbers']}" if r["numbers"] else "")
        # La última respuesta llegó antes de que acabara el audio: lo final no se transcribió (volumen, filtros…).
        if tail < 0:
            tail_txt = f"⚠ nada en los últimos {-tail:.1f} s del audio"
        else:
            tails.append(tail)
            tail_txt = f"última frase +{tail:.1f} s"
        print(f"cliente {i}: {r['segments']} segmentos · {lat_txt} · {tail_txt}{extra}")
    if all_lat:
        p95 = sorted(all_lat)[max(0, math.ceil(len(all_lat) * 0.95) - 1)]
        print(f"\nlatencia por segmento: media {statistics.mean(all_lat):.2f} s · p95 {p95:.2f} s · "
              f"máx {max(all_lat):.2f} s")
    if tails:
        print(f"retraso de la última frase: medio {statistics.mean(tails):.1f} s · máximo {max(tails):.1f} s")


asyncio.run(main())
