# cd /workspace && bash starth.bh
# server.py — Servidor optimizado puramente para transcripción en tiempo real (Faster-Whisper)
import os, sys, asyncio, inspect, json, hashlib, secrets, time, itertools, argparse, bisect, collections
from datetime import datetime, timezone, timedelta

# ---- Códigos de acceso autorizados ----
# Solo se guarda el SHA-256 de cada código; el código en claro se muestra una única vez al crearlo.
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
CODES_FILE = os.path.join(BASE_DIR, "authorized_codes.json")
ADMIN_TOKEN_FILE = os.path.join(BASE_DIR, "admin_token.txt")
SESSIONS_FILE = os.path.join(BASE_DIR, "sessions.jsonl")  # una línea por sesión terminada
METRICS_FILE  = os.path.join(BASE_DIR, "metrics.jsonl")   # una línea por minuto con el resumen de rendimiento

def hash_code(code: str) -> str:
    return hashlib.sha256(code.strip().encode("utf-8")).hexdigest()

def load_codes() -> dict:
    try:
        with open(CODES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}

_codes_cache: tuple = (None, {})  # (firma del archivo, contenido)

def cached_codes() -> dict:
    """Solo lectura. Evita releer el JSON en cada segmento de audio: solo se recarga si el archivo cambió."""
    global _codes_cache
    try:
        st = os.stat(CODES_FILE)
        sig = (st.st_mtime_ns, st.st_size, st.st_ino)
    except FileNotFoundError:
        sig = None
    if sig != _codes_cache[0]:
        _codes_cache = (sig, load_codes())
    return _codes_cache[1]

def save_codes(codes: dict):
    # Escritura atómica: el servidor nunca lee un archivo a medio escribir.
    tmp = CODES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(codes, f, indent=2, ensure_ascii=False)
    os.replace(tmp, CODES_FILE)

def validate_codes(codes) -> dict:
    if not isinstance(codes, dict) or not all(
        isinstance(h, str) and len(h) == 64 and isinstance(i, dict) and i.get("name") for h, i in codes.items()
    ):
        raise ValueError("Formato de authorized_codes.json inválido")
    return codes

def load_admin_token() -> str:
    token = os.environ.get("ADMIN_TOKEN")
    if token:
        return token
    try:
        with open(ADMIN_TOKEN_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        token = secrets.token_hex(16)
        with open(ADMIN_TOKEN_FILE, "w", encoding="utf-8") as f:
            f.write(token)
        return token


def code_status(info: dict) -> tuple[bool, str]:
    """(vigente, texto) — los códigos sin 'expires' no caducan."""
    if "expires" not in info:
        return True, "sin caducidad"
    left = datetime.fromisoformat(info["expires"]) - datetime.now(timezone.utc)
    if left.total_seconds() <= 0:
        return False, f"VENCIDO el {info['expires'][:10]}"
    return True, f"vence {info['expires'][:10]} ({left.days} días)"

def find_codes(codes: dict, target: str) -> list[str]:
    """Hashes cuyo nombre coincide, o cuyo hash empieza por target (mín. 6 caracteres)."""
    return [h for h, i in codes.items() if i["name"] == target or (len(target) >= 6 and h.startswith(target))]

# ---- Operaciones sobre códigos (compartidas por el CLI y el panel admin) ----
def create_code(codes: dict, name: str, days: int, email: str = "", note: str = "") -> str:
    now = datetime.now(timezone.utc)
    code = secrets.token_hex(16)
    info = {"name": name, "email": email, "note": note, "created": now.isoformat(timespec="seconds")}
    if days > 0:
        info["expires"] = (now + timedelta(days=days)).isoformat(timespec="seconds")
    codes[hash_code(code)] = info
    return code

def extend_code(info: dict, days: int, note: str = ""):
    # Se suma desde la fecha de vencimiento si aún no ha llegado, para no perder días pagados.
    now = datetime.now(timezone.utc)
    base = max(now, datetime.fromisoformat(info["expires"])) if "expires" in info else now
    info["expires"] = (base + timedelta(days=days)).isoformat(timespec="seconds")
    if note:
        info["note"] = (info.get("note", "") + " | " + note).strip(" |")

def extend_all(codes: dict, days: int) -> int:
    # Se suma a la fecha de vencimiento (no a hoy): quien venció durante la caída recupera los días perdidos.
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    extended = 0
    for info in codes.values():
        if "expires" in info and datetime.fromisoformat(info["expires"]) > cutoff:
            info["expires"] = (datetime.fromisoformat(info["expires"]) + timedelta(days=days)).isoformat(timespec="seconds")
            extended += 1
    return extended

def admin_request(server: str, method: str, body=None):
    import urllib.request, urllib.error
    req = urllib.request.Request(
        server.rstrip("/") + "/api/admin/codes",
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        method=method,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {load_admin_token()}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        print(f"Error {e.code}: {e.read().decode(errors='replace')}")
        if e.code == 401:
            print("El servidor tiene otro token admin: sube tu admin_token.txt al pod (Jupyter) y reinicia server.py.")
        sys.exit(1)

def cli():
    parser = argparse.ArgumentParser(prog="python server.py", description="Gestión de códigos de acceso")
    sub = parser.add_subparsers(dest="cmd", required=True)
    add = sub.add_parser("add-code", help="Crear un código para un cliente")
    add.add_argument("name")
    add.add_argument("--days", type=int, default=30, help="Días de validez (por defecto 30; 0 = sin caducidad)")
    add.add_argument("--email", default="")
    add.add_argument("--note", default="", help="p. ej. referencia del pago")
    ext = sub.add_parser("extend-code", help="Renovar un código existente")
    ext.add_argument("target", help="Nombre o prefijo del hash")
    ext.add_argument("--days", type=int, default=30)
    ext.add_argument("--note", default="")
    sub.add_parser("list-codes", help="Ver todos los códigos y su vigencia")
    rev = sub.add_parser("revoke-code", help="Eliminar un código")
    rev.add_argument("target", help="Nombre o prefijo del hash")
    exa = sub.add_parser("extend-all", help="Compensar días a todos tras una caída del servicio")
    exa.add_argument("--days", type=int, required=True)
    push = sub.add_parser("push-codes", help="Subir authorized_codes.json de este equipo al servidor")
    push.add_argument("server", help="p. ej. https://<pod>-8000.proxy.runpod.net")
    push.add_argument("--force", action="store_true", help="Sobrescribir aunque el servidor tenga códigos que aquí no están")
    pull = sub.add_parser("pull-codes", help="Descargar los códigos del servidor a este equipo")
    pull.add_argument("server", help="p. ej. https://<pod>-8000.proxy.runpod.net")
    args = parser.parse_args()

    load_admin_token()  # crea admin_token.txt en el Mac para subirlo al pod junto con los códigos
    codes = load_codes()
    if args.cmd == "add-code":
        code = create_code(codes, args.name, args.days, args.email, args.note)
        save_codes(codes)
        print(f"Código para '{args.name}' — {code_status(codes[hash_code(code)])[1]}\n(guárdalo, no se vuelve a mostrar):\n\n{code}\n\nRecuerda: push-codes")
    elif args.cmd == "extend-code":
        matches = find_codes(codes, args.target)
        if len(matches) != 1:
            print(f"Se encontraron {len(matches)} códigos para '{args.target}'; usa el prefijo del hash (list-codes).")
            sys.exit(1)
        info = codes[matches[0]]
        extend_code(info, args.days, args.note)
        save_codes(codes)
        print(f"{info['name']}: {code_status(info)[1]}. Recuerda: push-codes")
    elif args.cmd == "list-codes":
        for h, info in sorted(codes.items(), key=lambda kv: kv[1].get("expires", "9999")):
            extra = "  ".join(x for x in (info.get("email"), info.get("note")) if x)
            print(f"{info['name']}  ·  {code_status(info)[1]}" + (f"  ·  {extra}" if extra else ""))
            print(f"{h[:12]}\n")
        if not codes:
            print("No hay códigos autorizados.")
    elif args.cmd == "extend-all":
        extended = extend_all(codes, args.days)
        save_codes(codes)
        print(f"{extended} código(s) extendidos {args.days} días. Recuerda: push-codes")
    elif args.cmd == "push-codes":
        # Los códigos creados desde admin.html solo existen en el servidor; no los pisamos sin querer.
        remote = admin_request(args.server, "GET")
        newer_remote = {h: i for h, i in remote.items() if h not in codes or i.get("expires", "") > codes[h].get("expires", "")}
        if newer_remote and not args.force:
            print("El servidor tiene códigos nuevos o renovados que no están en este equipo (¿hechos desde admin.html?):")
            for i in newer_remote.values():
                print(f"  - {i['name']}")
            print("Ejecuta pull-codes primero, o usa --force para descartarlos.")
            sys.exit(1)
        print(f"Servidor actualizado: {admin_request(args.server, 'PUT', codes)['codes']} código(s).")
    elif args.cmd == "pull-codes":
        remote = validate_codes(admin_request(args.server, "GET"))
        if os.path.exists(CODES_FILE):
            os.replace(CODES_FILE, CODES_FILE + ".bak")
        save_codes(remote)
        print(f"Descargados {len(remote)} código(s). Copia anterior en authorized_codes.json.bak")
    elif args.cmd == "revoke-code":
        matches = find_codes(codes, args.target)
        for h in matches:
            del codes[h]
        save_codes(codes)
        print(f"Revocados: {len(matches)}. Recuerda: push-codes")

if __name__ == "__main__" and len(sys.argv) > 1:
    cli()
    sys.exit(0)

import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware

ADMIN_TOKEN = load_admin_token()
GPU_HOURLY_RATE = float(os.environ.get("GPU_HOURLY_RATE", "0.09"))
STARTED_AT = time.time()

# Clientes conectados ahora mismo: id -> info visible en el panel de admin
clients: dict[int, dict] = {}
client_ids = itertools.count(1)

def session_record(c: dict, end: float) -> dict:
    return {"code_hash": c["code_hash_full"], "name": c["name"], "start": round(c["connected_at"]),
            "end": round(end), "audio_s": round(c["audio_s"], 1), "segments": c["segments"]}

# El historial se lee del disco una sola vez al arrancar; después solo se añade (memoria + una línea en disco).
try:
    with open(SESSIONS_FILE, "r", encoding="utf-8") as f:
        past_sessions: list[dict] = [json.loads(line) for line in f if line.strip()]
except FileNotFoundError:
    past_sessions = []

def log_session(c: dict):
    record = session_record(c, time.time())
    past_sessions.append(record)
    with open(SESSIONS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

def load_sessions() -> list[dict]:
    """Sesiones terminadas más las que siguen abiertas (con fin = ahora)."""
    now = time.time()
    return past_sessions + [{**session_record(c, now), "live": True} for c in clients.values()]

# ---- Métricas de rendimiento ----
# Por segmento solo se suman números en memoria; una vez por minuto se resume y se escribe una línea a disco.
# La latencia se guarda como histograma (fusionable entre minutos/horas) separado por "segmentos en curso",
# que es el solapamiento real entre usuarios: varios hablando a la vez compiten por la misma GPU.
LAT_BINS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12]  # límites superiores en s; el último cubo es "> 12 s"
METRICS_MEMORY_MIN = 7 * 24 * 60                         # minutos que el panel puede consultar (7 días)

def _new_bucket(ts: int) -> dict:
    return {"ts": ts, "segments": 0, "audio_s": 0.0, "proc_s": 0.0, "detect_s": 0.0, "queue_max": 0.0,
            "errors": 0, "speakers": set(), "lat_max": 0.0, "max_in_flight": 0, "by_conc": {},
            "connected_max": 0, "gpu_util": [], "gpu_mem_mb": 0}

class Metrics:
    def __init__(self):
        self.in_flight = 0
        self.bucket = _new_bucket(int(time.time() // 60 * 60))
        self.minutes = collections.deque(maxlen=METRICS_MEMORY_MIN)
        self._load_tail()

    def _load_tail(self):
        # Solo se lee el final del archivo, para que arrancar no dependa de cuánto historial haya.
        try:
            with open(METRICS_FILE, "rb") as f:
                f.seek(0, os.SEEK_END)
                f.seek(max(0, f.tell() - METRICS_MEMORY_MIN * 1024))
                lines = f.read().decode("utf-8", errors="ignore").splitlines()[1:]
            for line in lines:
                try:
                    self.minutes.append(json.loads(line))
                except ValueError:
                    pass
        except FileNotFoundError:
            pass

    def segment(self, user: str, audio_s: float, queue_s: float, detect_s: float, proc_s: float,
                latency_s: float, concurrency: int):
        b = self.bucket
        b["segments"] += 1
        b["audio_s"] += audio_s
        b["proc_s"] += proc_s
        b["detect_s"] += detect_s
        b["queue_max"] = max(b["queue_max"], queue_s)
        b["lat_max"] = max(b["lat_max"], latency_s)
        b["speakers"].add(user)  # por código, no por conexión: reconectar no cuenta como otro usuario
        hist = b["by_conc"].setdefault(concurrency, [0] * (len(LAT_BINS) + 1))
        hist[bisect.bisect_left(LAT_BINS, latency_s)] += 1

    def sample(self):
        """Cada 10 s: conexiones y GPU. Si cambió el minuto, cierra el anterior."""
        now_min = int(time.time() // 60 * 60)
        if now_min != self.bucket["ts"]:
            self._flush()
            self.bucket = _new_bucket(now_min)
        b = self.bucket
        b["connected_max"] = max(b["connected_max"], len(clients))
        b["max_in_flight"] = max(b["max_in_flight"], self.in_flight)
        gpu = sample_gpu()
        if gpu:
            b["gpu_util"].append(gpu[0])
            b["gpu_mem_mb"] = max(b["gpu_mem_mb"], gpu[1])

    def _flush(self):
        b = self.bucket
        record = {
            "ts": b["ts"], "connected": b["connected_max"], "speakers": len(b["speakers"]),
            "segments": b["segments"], "audio_s": round(b["audio_s"], 1), "proc_s": round(b["proc_s"], 2),
            "detect_s": round(b["detect_s"], 2), "queue_max": round(b["queue_max"], 2), "lat_max": round(b["lat_max"], 2),
            "max_in_flight": b["max_in_flight"], "errors": b["errors"],
            "by_conc": {str(k): v for k, v in b["by_conc"].items()},
            "gpu_util": round(sum(b["gpu_util"]) / len(b["gpu_util"])) if b["gpu_util"] else None,
            "gpu_mem_mb": b["gpu_mem_mb"] or None,
        }
        self.minutes.append(record)
        try:
            with open(METRICS_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
        except OSError as e:
            print(f"[METRICS] No se pudo escribir: {e}")

metrics = Metrics()

# GPU vía NVML (paquete nvidia-ml-py). Opcional: sin él, las métricas de GPU quedan vacías.
try:
    import pynvml
    pynvml.nvmlInit()
    _gpu_handle = pynvml.nvmlDeviceGetHandleByIndex(0)
except Exception:
    _gpu_handle = None

def sample_gpu():
    if _gpu_handle is None:
        return None
    try:
        util = pynvml.nvmlDeviceGetUtilizationRates(_gpu_handle).gpu
        mem = pynvml.nvmlDeviceGetMemoryInfo(_gpu_handle).used // (1024 * 1024)
        return util, mem
    except Exception:
        return None

# ---- Parche metadata_errors (versiones nuevas de PyAV) ----
import faster_whisper
audio_path = inspect.getfile(faster_whisper.audio)
with open(audio_path, "r", encoding="utf-8") as f:
    content = f.read()
if 'metadata_errors="ignore"' in content:
    with open(audio_path, "w", encoding="utf-8") as f:
        f.write(content.replace(', metadata_errors="ignore"', ""))

from faster_whisper import WhisperModel

app = FastAPI()
# El panel admin.html se abre desde file:// u otro origen, y autentica con cabecera Bearer.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "PUT", "DELETE"],
                   allow_headers=["Authorization", "Content-Type"])

@app.get("/")
def health():
    return {"status": "ok"}

def require_admin(request: Request):
    auth = request.headers.get("authorization", "")
    if not secrets.compare_digest(auth, f"Bearer {ADMIN_TOKEN}"):
        raise HTTPException(status_code=401, detail="Token de admin inválido")

def find_code_or_404(codes: dict, code_hash: str) -> dict:
    matches = [h for h in codes if h.startswith(code_hash)] if len(code_hash) >= 12 else []
    if len(matches) != 1:
        raise HTTPException(status_code=404, detail="Código no encontrado")
    return codes[matches[0]]

async def json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Se esperaba un objeto JSON")
    return body

def int_field(body: dict, key: str, default: int | None = None, minimum: int = 0) -> int:
    value = body.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > 3650:
        raise HTTPException(status_code=400, detail=f"'{key}' debe ser un número de días entre {minimum} y 3650")
    return value

@app.get("/api/admin/codes")
def admin_get_codes(request: Request):
    # Archivo completo: lo usan pull-codes y el botón de respaldo de admin.html.
    require_admin(request)
    return load_codes()

@app.post("/api/admin/codes")
async def admin_create_code(request: Request):
    require_admin(request)
    body = await json_body(request)
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Falta el nombre")
    days = int_field(body, "days", 30)
    codes = load_codes()
    code = create_code(codes, name, days, str(body.get("email", "")).strip(), str(body.get("note", "")).strip())
    save_codes(codes)
    print(f"[ADMIN] Código creado para {name}")
    return {"code": code, "name": name, "status": code_status(codes[hash_code(code)])[1]}

@app.post("/api/admin/codes/extend-all")
async def admin_extend_all(request: Request):
    require_admin(request)
    days = int_field(await json_body(request), "days", minimum=1)
    codes = load_codes()
    extended = extend_all(codes, days)
    save_codes(codes)
    print(f"[ADMIN] {extended} código(s) extendidos {days} días")
    return {"extended": extended}

@app.post("/api/admin/codes/{code_hash}/extend")
async def admin_extend_code(code_hash: str, request: Request):
    require_admin(request)
    body = await json_body(request)
    days = int_field(body, "days", 30, minimum=1)
    codes = load_codes()
    info = find_code_or_404(codes, code_hash)
    extend_code(info, days, str(body.get("note", "")).strip())
    save_codes(codes)
    print(f"[ADMIN] {info['name']} renovado: {code_status(info)[1]}")
    return {"name": info["name"], "status": code_status(info)[1]}

@app.delete("/api/admin/codes/{code_hash}")
def admin_revoke_code(code_hash: str, request: Request):
    require_admin(request)
    codes = load_codes()
    info = find_code_or_404(codes, code_hash)
    codes = {h: i for h, i in codes.items() if i is not info}
    save_codes(codes)
    print(f"[ADMIN] Código de {info['name']} revocado")
    return {"name": info["name"]}

@app.put("/api/admin/codes")
async def admin_put_codes(request: Request):
    # push-codes reemplaza aquí el archivo entero con la copia del Mac.
    require_admin(request)
    try:
        codes = validate_codes(await request.json())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    save_codes(codes)
    print(f"[ADMIN] Códigos actualizados: {len(codes)}")
    return {"codes": len(codes)}

@app.get("/api/admin/usage")
def admin_usage(request: Request, days: int = 30):
    # Totales históricos por código + sesiones recientes; el panel agrupa por día en la zona horaria local.
    require_admin(request)
    sessions = load_sessions()
    totals: dict[str, dict] = {}
    for x in sessions:
        t = totals.setdefault(x["code_hash"], {"sessions": 0, "connected_s": 0, "audio_s": 0.0, "last_seen": 0})
        t["sessions"] += 1
        t["connected_s"] += x["end"] - x["start"]
        t["audio_s"] += x["audio_s"]
        t["last_seen"] = max(t["last_seen"], x["end"])
    since = time.time() - max(1, min(days, 366)) * 86400
    return {
        "per_code": totals,
        "sessions": [{**x, "code_hash": x["code_hash"][:12]} for x in sessions if x["end"] >= since],
    }

@app.get("/api/admin/metrics")
def admin_metrics(request: Request, hours: int = 24):
    # Devuelve los minutos ya resumidos; el panel agrega por hora y por nivel de solapamiento.
    require_admin(request)
    since = time.time() - max(1, min(hours, METRICS_MEMORY_MIN // 60)) * 3600
    return {
        "lat_bins": LAT_BINS,
        "gpu_available": _gpu_handle is not None,
        "in_flight": metrics.in_flight,
        "minutes": [m for m in metrics.minutes if m["ts"] >= since],
    }

@app.on_event("startup")
async def start_metrics_sampler():
    async def loop():
        while True:
            await asyncio.sleep(10)
            metrics.sample()
    asyncio.create_task(loop())

@app.get("/api/admin/stats")
def admin_stats(request: Request):
    require_admin(request)
    now = time.time()
    return {
        "active_users": len(clients),
        "projected_monthly_cost": GPU_HOURLY_RATE * 24 * 30,
        "hourly_rate": GPU_HOURLY_RATE,
        "uptime_s": int(now - STARTED_AT),
        "authorized_codes": len(cached_codes()),
        "codes": [
            {"code_hash": h[:12], "hash": h, "name": i["name"], "email": i.get("email", ""), "note": i.get("note", ""),
             "expires": i.get("expires"), "valid": code_status(i)[0], "status": code_status(i)[1]}
            for h, i in cached_codes().items()
        ],
        "clients": [
            {**{k: v for k, v in c.items() if k != "code_hash_full"},
             "connected_s": int(now - c["connected_at"]), "idle_s": int(now - c["last_activity"])}
            for c in clients.values()
        ],
    }

print("Cargando modelo Whisper en la GPU...")
model = WhisperModel("small", device="cuda", compute_type="float16")
print("¡Whisper cargado correctamente!")

# ---- Parámetros de segmentación y estilos ----
SAMPLE_RATE    = 16000
RMS_THRESHOLD  = 0.012
SILENCE_CUT_S  = 0.5
MIN_SEGMENT_S  = 1.0
MAX_SEGMENT_S  = 8.0
PREROLL_S      = 0.3
DEBUG_RMS      = False

ALLOWED_LANGS = ("es", "en")
STYLE_PROMPTS = {
    "es": "Hola, buenos días. ¿Cómo está usted? Quisiera hablar del proyecto, si no le molesta; creo que es importante.",
    "en": "Hello, good morning. How are you? I would like to talk about the project, if you don't mind; I think it's important.",
}

def rms_int16(data: bytes) -> float:
    n = len(data) - (len(data) % 2)
    if n == 0:
        return 0.0
    a = np.frombuffer(data[:n], dtype=np.int16).astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(a * a)))

def transcribe_sync(audio, prev_text="", prev_lang=None):
    t_start = time.perf_counter()
    # 1. Detectar el idioma del audio original. Sin VAD aquí: transcribe() ya lo aplica abajo,
    #    y el segmento ya llega recortado por silencios (RMS), así que pasarlo dos veces no aporta.
    _, _, all_probs = model.detect_language(audio, vad_filter=False)
    t_detected = time.perf_counter()
    probs = {code: p for code, p in all_probs if code in ALLOWED_LANGS}
    lang = max(probs, key=probs.get) if probs else "es"

    context = prev_text[-150:] if (prev_text and lang == prev_lang and any(c in prev_text for c in ",.?!¿")) else ""
    prompt = (STYLE_PROMPTS.get(lang, "") + " " + context).strip()

    # 2. Transcripción pura en el idioma original
    segments_orig, _ = model.transcribe(
        audio,
        language=lang,
        beam_size=3,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
        condition_on_previous_text=False,
        initial_prompt=prompt,
    )
    # transcribe() es perezoso: el trabajo de GPU ocurre al recorrer los segmentos, dentro de esta medición.
    transcript_text = "".join(s.text for s in segments_orig).strip()

    timings = {"start": t_start, "detect_s": t_detected - t_start, "proc_s": time.perf_counter() - t_start}
    return transcript_text, lang, timings

@app.websocket("/ws/transcribe")
async def websocket_endpoint(websocket: WebSocket):
    # El cliente envía el código como subprotocolo: new WebSocket(url, ['token', código])
    offered = [p.strip() for p in websocket.headers.get("sec-websocket-protocol", "").split(",") if p.strip()]
    code = offered[1] if len(offered) >= 2 and offered[0] == "token" else ""
    await websocket.accept(subprotocol="token" if offered[:1] == ["token"] else None)

    code_hash = hash_code(code)
    info = cached_codes().get(code_hash) if code else None
    if not info or not code_status(info)[0]:
        motivo = "vencido" if info else "no autorizado"
        print(f">>> Conexión rechazada: código {motivo} ({info['name'] if info else '?'}) <<<")
        await websocket.send_json({"error": f"Código de acceso {motivo}."})
        await websocket.close(code=4401)
        return

    client_id = next(client_ids)
    forwarded = websocket.headers.get("x-forwarded-for", "")
    now = time.time()
    client = clients[client_id] = {
        "id": client_id,
        "name": info["name"],
        "code_hash": code_hash[:12],
        "expires": info.get("expires"),
        "ip": forwarded.split(",")[0].strip() or (websocket.client.host if websocket.client else "?"),
        "user_agent": websocket.headers.get("user-agent", ""),
        "connected_at": now,
        "code_hash_full": code_hash,
        "last_activity": now,
        "segments": 0,
        "audio_s": 0.0,
    }
    print(f">>> Cliente #{client_id} conectado: {info['name']} ({client['ip']}) <<<")
    loop = asyncio.get_running_loop()

    pcm = bytearray()
    has_speech = False
    silence_s = 0.0
    prev_text = ""
    prev_lang = None

    try:
        while True:
            data = await websocket.receive_bytes()
            if len(data) < 2:
                continue

            pcm.extend(data)
            dur = (len(data) // 2) / SAMPLE_RATE
            level = rms_int16(data)
            if DEBUG_RMS:
                print(f"rms={level:.4f}")

            if level >= RMS_THRESHOLD:
                has_speech = True
                silence_s = 0.0
            else:
                silence_s += dur

            if not has_speech:
                keep = int(PREROLL_S * SAMPLE_RATE) * 2
                if len(pcm) > keep:
                    del pcm[:len(pcm) - keep]
                continue

            buf_s = len(pcm) / 2 / SAMPLE_RATE
            pausa = silence_s >= SILENCE_CUT_S and buf_s >= MIN_SEGMENT_S
            demasiado_largo = buf_s >= MAX_SEGMENT_S
            if not (pausa or demasiado_largo):
                continue

            usable = len(pcm) - (len(pcm) % 2)
            audio = np.frombuffer(bytes(pcm[:usable]), dtype=np.int16).astype(np.float32) / 32768.0
            pcm.clear()
            has_speech = False
            silence_s = 0.0

            # Revocar o dejar vencer un código corta también la sesión que ya estaba abierta.
            info = cached_codes().get(code_hash)
            if not info or not code_status(info)[0]:
                print(f">>> Cliente #{client_id} ({client['name']}): código vencido o revocado, cerrando. <<<")
                await websocket.send_json({"error": "Tu código de acceso ha vencido."})
                await websocket.close(code=4401)
                break

            motivo = "pausa" if pausa else "límite máx."
            client["audio_s"] += len(audio) / SAMPLE_RATE
            print(f"[AUDIO] {len(audio)/SAMPLE_RATE:.1f} s ({motivo})")

            t_ready = time.perf_counter()
            metrics.in_flight += 1
            concurrency = metrics.in_flight  # segmentos compitiendo por la GPU, incluido este
            try:
                text, lang, timings = await loop.run_in_executor(
                    None, transcribe_sync, audio, prev_text, prev_lang
                )
            except Exception as e:
                print(f"[WHISPER ERROR]: {e}")
                metrics.bucket["errors"] += 1
                continue
            finally:
                metrics.in_flight -= 1
            metrics.segment(code_hash, len(audio) / SAMPLE_RATE, timings["start"] - t_ready, timings["detect_s"],
                            timings["proc_s"], time.perf_counter() - t_ready, concurrency)

            if not text:
                print("[WHISPER] Silencio/ruido filtrado.")
                continue

            prev_text = (prev_text + " " + text)[-300:] if lang == prev_lang else text
            prev_lang = lang
            client.update(segments=client["segments"] + 1, last_activity=time.time())

            print(f"✅ [{client['name']}] [{lang.upper()}]: {text}")

            # Enviamos únicamente la transcripción limpia y el idioma detectado al cliente
            await websocket.send_json({
                "transcript": text,
                "language": lang
            })

    except WebSocketDisconnect:
        pass
    finally:
        clients.pop(client_id, None)
        log_session(client)
        print(f">>> Cliente #{client_id} ({client['name']}) desconectado. <<<")

if __name__ == "__main__":
    pod_id = os.environ.get("RUNPOD_POD_ID")
    # Cada valor va solo en su línea para poder copiarlo con doble/triple clic sin arrastrar la etiqueta.
    if pod_id:
        print(f"\n * URL del cliente:\n\nwss://{pod_id}-8000.proxy.runpod.net/ws/transcribe\n")
        print(f" * URL admin:\n\nhttps://{pod_id}-8000.proxy.runpod.net/api/admin/stats\n")
    print(f" * Token admin:\n\n{ADMIN_TOKEN}\n")
    if os.path.exists(CODES_FILE):
        print(f" * Códigos autorizados: {len(load_codes())}\n")
    else:
        print(" * ⚠️  No hay authorized_codes.json: nadie podrá conectarse. Súbelo por Jupyter o con push-codes.\n")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")