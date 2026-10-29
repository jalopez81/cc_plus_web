"""
export PUBLIC_HOSTNAME=whisper.life-caption-plus.bid 
export WHISPER_MODEL="large-v3-turbo" 
bash start-vast.sh
"""
# server.py — Servidor optimizado puramente para transcripción en tiempo real (Faster-Whisper)
import os, re, sys, asyncio, inspect, json, hashlib, secrets, time, itertools, argparse, bisect, collections, unicodedata, wave
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta

# ---- Códigos de acceso autorizados ----
# Los clientes se validan por el SHA-256 del código. Desde que el admin puede volver a copiarlos, los códigos nuevos
# también guardan el texto en claro ("code"); los creados antes solo tienen el hash y no se pueden recuperar.
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
CODES_FILE = os.path.join(BASE_DIR, "authorized_codes.json")
ADMIN_TOKEN_FILE = os.path.join(BASE_DIR, "admin_token.txt")
SESSIONS_FILE = os.path.join(BASE_DIR, "sessions.jsonl")  # una línea por sesión terminada
METRICS_FILE  = os.path.join(BASE_DIR, "metrics.jsonl")   # una línea por minuto con el resumen de rendimiento

# Por defecto la consola solo muestra el arranque, conexiones y errores. VERBOSE=1 (bash start-vast.sh --verbose)
# añade cada segmento con su texto y traducción, y las peticiones HTTP como el sondeo del panel admin.
# Callado, además, el texto de los pacientes no queda escrito en server.log.
VERBOSE = os.environ.get("VERBOSE", "0") != "0"

def vlog(*args):
    if VERBOSE:
        print(*args)

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
    # El código en claro se guarda junto al hash para que el admin pueda volver a copiarlo; la validación sigue usando el hash.
    info = {"name": name, "email": email, "note": note, "created": now.isoformat(timespec="seconds"), "code": code}
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
    push.add_argument("server", help="p. ej. https://whisper.tudominio.com o https://<pod>-8000.proxy.runpod.net")
    push.add_argument("--force", action="store_true", help="Sobrescribir aunque el servidor tenga códigos que aquí no están")
    pull = sub.add_parser("pull-codes", help="Descargar los códigos del servidor a este equipo")
    pull.add_argument("server", help="p. ej. https://whisper.tudominio.com o https://<pod>-8000.proxy.runpod.net")
    args = parser.parse_args()

    load_admin_token()  # crea admin_token.txt en el Mac para subirlo al pod junto con los códigos
    codes = load_codes()
    if args.cmd == "add-code":
        code = create_code(codes, args.name, args.days, args.email, args.note)
        save_codes(codes)
        print(f"Código para '{args.name}' — {code_status(codes[hash_code(code)])[1]}\n(list-codes lo vuelve a mostrar):\n\n{code}\n\nRecuerda: push-codes")
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
            print(f"{info.get('code') or h[:12] + '… (creado antes de guardar códigos; no recuperable)'}\n")
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
        print(f"Eliminados: {len(matches)}. Recuerda: push-codes")

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

# Una sola conexión por código: hash del código -> (id del cliente, websocket).
# Gana la conexión más nueva; así una sesión colgada (portátil cerrado, red caída) no bloquea al usuario.
active_by_code: dict[str, tuple[int, WebSocket]] = {}

async def replace_previous(prev_id: int, prev_ws: WebSocket):
    if prev_id in clients:
        clients[prev_id]["replaced"] = True
        print(f">>> Cliente #{prev_id} ({clients[prev_id]['name']}): mismo código conectado en otro equipo, cerrando. <<<")
    try:
        await prev_ws.send_json({"error": "Tu código de acceso se conectó desde otro equipo; esta sesión se cerró."})
        await prev_ws.close(code=4409)
    except Exception:
        pass  # ya estaba cerrada

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
from faster_whisper.vad import get_speech_timestamps
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(_app):
    async def sample_metrics():
        while True:
            await asyncio.sleep(10)
            metrics.sample()
    task = asyncio.create_task(sample_metrics())
    yield
    task.cancel()

app = FastAPI(lifespan=lifespan)
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
    print(f"[ADMIN] Código de {info['name']} eliminado")
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
            {"code_hash": h[:12], "hash": h, "code": i.get("code", ""), "name": i["name"], "email": i.get("email", ""), "note": i.get("note", ""),
             "expires": i.get("expires"), "valid": code_status(i)[0], "status": code_status(i)[1]}
            for h, i in cached_codes().items()
        ],
        "clients": [
            {**{k: v for k, v in c.items() if k != "code_hash_full"},
             "connected_s": int(now - c["connected_at"]), "idle_s": int(now - c["last_activity"])}
            for c in clients.values()
        ],
    }

# WHISPER_MODEL permite probar otro tamaño sin tocar el código (p. ej. "medium" o "large-v3-turbo").
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
# Con un solo worker, CTranslate2 atiende las transcripciones de una en una y con varios clientes forman cola.
# Con dos, mientras un segmento está en CPU (espectrograma, VAD) o deja la GPU a medio llenar decodificando,
# otro avanza: más segmentos por segundo en la misma tarjeta. WHISPER_WORKERS=1 vuelve a la cola única.
WHISPER_WORKERS = int(os.environ.get("WHISPER_WORKERS", "2"))
print(f"Cargando modelo Whisper '{WHISPER_MODEL}' en la GPU ({WHISPER_WORKERS} workers)...")
model = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16", num_workers=WHISPER_WORKERS)
print("¡Whisper cargado correctamente!")

# Los modelos large-v3 (y sobre todo turbo, con solo 4 capas de decodificador) se desvían con prompts largos
# y van sobrados de velocidad, así que usan otro ajuste. El resto (small, medium...) conserva el original.
# BEAM_SIZE y STYLE_PROMPT=0/1 lo fuerzan para comparar sin tocar el código.
# faster-whisper resuelve "large" a large-v3 y "turbo" a large-v3-turbo.
# Beam 3 en vez de 5 para atender a 8–9 usuarios en una RTX 3060; BEAM_SIZE=5 si se nota en la calidad.
IS_V3_MODEL  = WHISPER_MODEL in ("large", "turbo") or "large-v3" in WHISPER_MODEL
BEAM_SIZE    = int(os.environ.get("BEAM_SIZE", "3"))
STYLE_PROMPT = os.environ.get("STYLE_PROMPT", "0" if IS_V3_MODEL else "1") != "0"
# Pasar lo dicho antes como prompt hace que Whisper copie palabras y cifras de ahí ("tenía 8.0" → otro "8.0"
# donde se dijo 9.0). Apagado por defecto; CONTEXT_PROMPT=1 lo vuelve a activar para comparar.
CONTEXT_PROMPT = os.environ.get("CONTEXT_PROMPT", "0") != "0"

# Términos que Whisper debe tender a reconocer (parámetro hotwords de faster-whisper). Es una lista corta a
# propósito: con muchas palabras turbo empieza a desviarse igual que con un prompt largo. HOTWORDS_ES/HOTWORDS_EN
# la sustituyen; vacía la apaga.
HOTWORDS = {
    "es": os.environ.get("HOTWORDS_ES", "glucosa, hemoglobina A1c, insulina, metformina, presión arterial, "
                                        "colesterol, miligramos, mg/dL, dosis, receta"),
    "en": os.environ.get("HOTWORDS_EN", "glucose, hemoglobin A1c, insulin, metformin, blood pressure, "
                                        "cholesterol, milligrams, mg/dL, dosage, prescription"),
}
print(f"Ajustes de decodificación: beam_size={BEAM_SIZE}, prompt de estilo={'sí' if STYLE_PROMPT else 'no'}, "
      f"contexto previo={'sí' if CONTEXT_PROMPT else 'no'}, hotwords={'sí' if any(HOTWORDS.values()) else 'no'}")

# SAVE_SEGMENTS=<carpeta> guarda cada segmento en WAV con su transcripción al lado, para escuchar exactamente qué
# recibió Whisper. Solo para llamadas de prueba: con pacientes reales serían datos protegidos (HIPAA).
SAVE_SEGMENTS = os.environ.get("SAVE_SEGMENTS", "")
if SAVE_SEGMENTS:
    print(f"⚠️  Guardando cada segmento de audio en {SAVE_SEGMENTS}")

# ---- Traducción en el servidor (CTranslate2, el mismo motor que faster-whisper) ----
# Cada transcripción sale ya traducida en el mismo mensaje, y lo que dicen los pacientes no pasa por servicios de
# traducción de terceros. TRANSLATE=0 la apaga y la app vuelve a traducir por su cuenta.
# Solo modelos con licencia que permite uso comercial (el servicio se alquila):
#   google/madlad400-3b-mt (Apache 2.0, por defecto): la mejor calidad; ~3 GB de VRAM.
#   facebook/m2m100_1.2B (MIT): más ligero y rápido, traduce algo peor.
# NLLB-200 traduciría bien, pero su licencia (CC-BY-NC) prohíbe el uso comercial, así que se rechaza.
# La primera vez el modelo se descarga y se convierte a CTranslate2 en MT_DIR: MADLAD baja ~12 GB antes de
# convertirse a ~3 GB, así que la instancia necesita unos 40 GB de disco.
TRANSLATE = os.environ.get("TRANSLATE", "1") != "0"
MT_MODEL  = os.environ.get("MT_MODEL", "google/madlad400-3b-mt")
MT_DIR    = os.environ.get("MT_DIR", "/workspace/mt-ct2" if os.path.isdir("/workspace") else os.path.join(BASE_DIR, "mt-ct2"))
IS_M2M    = "m2m100" in MT_MODEL
# Igual que WHISPER_WORKERS: traducciones en paralelo en la misma GPU. Beam 2 en vez de 4 por velocidad (las cifras
# van tapadas y no dependen del beam); MT_BEAM=4 si se nota en la calidad.
MT_THREADS = int(os.environ.get("MT_THREADS", "2"))
MT_BEAM    = int(os.environ.get("MT_BEAM", "2"))
# MADLAD indica el idioma destino con una etiqueta al inicio del texto ("<2en> …"); M2M100 fija el de origen en el
# tokenizador y abre la salida con el token del destino ("__en__").

def load_translator():
    import ctranslate2
    from transformers import AutoTokenizer
    if "nllb" in MT_MODEL.lower():
        raise ValueError("NLLB no permite uso comercial; usa google/madlad400-3b-mt o facebook/m2m100_1.2B")
    target = os.path.join(MT_DIR, MT_MODEL.split("/")[-1])
    if not os.path.isfile(os.path.join(target, "model.bin")):
        print(f"Convirtiendo {MT_MODEL} a CTranslate2 (solo la primera vez, puede tardar 10–20 min)...")
        from ctranslate2.converters import TransformersConverter
        # En float16 la conversión pide la mitad de RAM (MADLAD en float32 ocuparía ~12 GB).
        TransformersConverter(MT_MODEL, load_as_float16=True, low_cpu_mem_usage=True).convert(
            target, quantization="int8_float16", force=True)
        AutoTokenizer.from_pretrained(MT_MODEL).save_pretrained(target)
        # Los pesos originales ocupan varios GB y ya no hacen falta; el disco de Vast suele ser pequeño.
        from huggingface_hub import scan_cache_dir
        cache = scan_cache_dir()
        for repo in cache.repos:
            if repo.repo_id == MT_MODEL:
                cache.delete_revisions(*[r.commit_hash for r in repo.revisions]).execute()
    if IS_M2M:
        # Un tokenizador por idioma de origen: src_lang es estado del tokenizador y los segmentos van en paralelo.
        tokenizers = {lang: AutoTokenizer.from_pretrained(target, src_lang=lang) for lang in ("es", "en")}
    else:
        tok = AutoTokenizer.from_pretrained(target)
        tokenizers = {"es": tok, "en": tok}
    return ctranslate2.Translator(target, device="cuda", compute_type="int8_float16", inter_threads=MT_THREADS), tokenizers

mt_model, mt_tokenizers = None, {}
if TRANSLATE:
    try:
        print(f"Cargando traductor '{MT_MODEL}' ({MT_THREADS} en paralelo, beam {MT_BEAM})...")
        mt_model, mt_tokenizers = load_translator()
        print("¡Traductor cargado correctamente!")
    except Exception as e:
        print(f"!!! No se pudo cargar el traductor ({e}); la app traducirá por su cuenta.")

# ---- Parámetros de segmentación y estilos ----
# Segmentos de 1–2 s dejan a Whisper sin contexto y fallan mucho más en palabras sueltas, fármacos y cifras.
# Una pausa a mitad de frase partía "puede equivocar|se con palabras": Whisper cerraba el primer trozo y el
# segundo, de 1.3 s, salía como "Gracias." Por eso se corta tras 1.0 s de silencio, y si lo dicho hasta ahí es
# corto (menos de SHORT_SPEECH_S) se espera a END_OF_TURN_S: o la frase sigue, o la persona terminó.
SAMPLE_RATE    = 16000
RMS_THRESHOLD  = 0.012
SILENCE_CUT_S  = 1.0
SHORT_SPEECH_S = 3.0
END_OF_TURN_S  = 1.5
MIN_SEGMENT_S  = 1.0
MAX_SEGMENT_S  = 10.0  # con quien habla sin pausas, nada se ve hasta este límite; 14 s se hacía eterno
CUT_SEARCH_S   = 2.5  # al llegar a MAX_SEGMENT_S se corta en el punto más silencioso de estos últimos segundos
PREROLL_S      = 1.0  # audio previo que se conserva al empezar a hablar (Whisper recorta el silencio que sobre)
DEBUG_RMS      = os.environ.get("DEBUG_RMS", "0") != "0"  # imprime el volumen y el umbral de cada trozo recibido

# RMS_THRESHOLD fijo trataba como silencio a quien habla flojo, y también el final de frase que se dice más
# bajo ("…se con palabras"): cortaba a mitad de frase. El umbral de cada cliente se calcula a partir de su
# ruido de fondo, el percentil 20 del volumen de los últimos NOISE_WINDOW_S (en una conversación siempre hay
# pausas): 3 veces ese ruido, sin bajar de MIN_RMS. Los trozos de silencio digital (micrófono silenciado, el
# relleno de ceros del script de prueba) no cuentan: con ellos el ruido salía 0, el umbral se iba al mínimo y
# el ruido entre frases contaba como voz, así que nunca había pausa y todo se cortaba por el límite.
# Nunca sube por encima de RMS_THRESHOLD: con mucho ruido se comporta como antes, en vez de dejar de oír.
NOISE_WINDOW_S = 20.0
MIN_RMS        = 0.006
DIGITAL_SILENCE = 0.0005

def speech_threshold(levels, levels_s: float) -> float:
    real = [lv for lv, _ in levels if lv >= DIGITAL_SILENCE]
    if levels_s < 2.0 or len(real) < 5:
        return RMS_THRESHOLD
    return min(RMS_THRESHOLD, max(MIN_RMS, 3 * float(np.percentile(real, 20))))

# El volumen solo abre el búfer; las pausas las decide Silero VAD (el mismo detector que usa faster-whisper,
# en CPU). En una grabación con el ruido a la mitad del volumen de la voz ningún umbral servía: bajo, el ruido
# contaba como voz y nunca había pausa; alto, el final flojo de una frase contaba como silencio y la partía.
# Se mira solo el final del búfer (VAD_TAIL_S) para que cada trozo recibido cueste unos pocos milisegundos.
VAD_TAIL_S = 3.0

def _speech(pcm: bytes, **opts):
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    return audio, get_speech_timestamps(audio, threshold=0.5, speech_pad_ms=30, **opts)

def trailing_silence(pcm: bytes) -> float:
    """Segundos sin voz al final de `pcm` (todo `pcm` si no hay voz)."""
    audio, spans = _speech(pcm, min_silence_duration_ms=100)
    return (len(audio) - (spans[-1]["end"] if spans else 0)) / SAMPLE_RATE

def has_voice(pcm: bytes) -> bool:
    return bool(_speech(pcm)[1])

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

def quietest_cut(pcm: bytearray) -> int:
    """Byte donde cortar un búfer que llegó a MAX_SEGMENT_S sin pausa: el centro de la ventana de 250 ms más
    silenciosa de los últimos CUT_SEARCH_S, deslizándola de 25 en 25 ms. Cortar justo en el límite partía
    palabras, que salían mal en los dos segmentos; lo que queda tras el corte pasa al siguiente.
    Con ventanas de 100 ms el cierre de una "t" o una "p" contaba como pausa y partía "real-time trans|lation";
    250 ms solo caben entre palabras."""
    a = np.frombuffer(bytes(pcm[:len(pcm) - len(pcm) % 2]), dtype=np.int16).astype(np.float64)
    win, hop = int(0.25 * SAMPLE_RATE), int(0.025 * SAMPLE_RATE)
    start = max(0, len(a) - int(CUT_SEARCH_S * SAMPLE_RATE))
    if len(a) - start < win:
        return len(a) * 2
    power = np.concatenate(([0.0], np.cumsum(a[start:] ** 2)))
    offsets = np.arange(0, len(power) - win, hop)
    energy = power[offsets + win] - power[offsets]
    return (start + int(offsets[np.argmin(energy)]) + win // 2) * 2

def save_segment(audio, client_id: int, text: str, lang, motivo: str):
    os.makedirs(SAVE_SEGMENTS, exist_ok=True)
    name = os.path.join(SAVE_SEGMENTS, f"{datetime.now():%Y%m%d-%H%M%S-%f}-c{client_id}")
    with wave.open(name + ".wav", "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
    with open(name + ".txt", "w", encoding="utf-8") as f:
        f.write(f"[{lang}] ({motivo}, {len(audio) / SAMPLE_RATE:.1f} s) {text or '(vacío / filtrado)'}\n")

# La detección de idioma de Whisper falla a menudo en fragmentos cortos o con acento. Si su reparto entre
# es/en no supera LANG_CONFIDENT, se transcribe en ambos idiomas y se queda el que Whisper decodifica con más
# seguridad. No se favorece el idioma anterior: en una llamada interpretada cada turno cambia de idioma.
LANG_CONFIDENT = float(os.environ.get("LANG_CONFIDENT", "0.80"))

# Whisper "oye" estas frases en ruido, música o voces lejanas. Solo se descartan si además el audio es flojo
# o Whisper duda; un "thank you" claro y en primer plano se mantiene.
HALLUCINATIONS = {
    "thank you", "thank you very much", "thanks", "thank you so much", "thanks for watching",
    "thank you for watching", "please subscribe", "you", "bye", "bye bye",
    "gracias", "muchas gracias", "gracias por ver", "gracias por ver el video", "suscribete",
    "subtitulos realizados por la comunidad de amaraorg", "chao",
}
HALLU_QUIET_RMS   = RMS_THRESHOLD * 2.5  # por debajo de esto suena a voz lejana o ruido de fondo
HALLU_NO_SPEECH   = 0.2
HALLU_MIN_LOGPROB = -0.6
MAX_REPEATS       = 2  # una frase se muestra como mucho dos veces seguidas

def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return " ".join(re.sub(r"[^\w\s]", "", text).split())

def collapse_repeats(text: str, max_repeats: int = MAX_REPEATS) -> str:
    """'thank you, thank you, thank you, thank you' -> 'thank you, thank you'. Compara frases de 1 a 8 palabras."""
    words = text.split()
    keys = [normalize_text(w) for w in words]
    for n in range(1, 9):
        i = 0
        while i + n * (max_repeats + 1) <= len(words):
            run = 1
            while keys[i + run * n:i + (run + 1) * n] == keys[i:i + n]:
                run += 1
            if run > max_repeats and any(keys[i:i + n]):
                last = i + max_repeats * n - 1  # la última copia que queda hereda el cierre (". ?") de la eliminada
                words[last] = re.sub(r"\W*$", "", words[last]) + re.search(r"\W*$", words[i + run * n - 1]).group()
                del words[i + max_repeats * n:i + run * n]
                del keys[i + max_repeats * n:i + run * n]
            i += 1
    return " ".join(words)

def is_hallucination(text: str) -> bool:
    chunks = [normalize_text(c) for c in re.split(r"[.,!?¿¡;]+", text)]
    chunks = [c for c in chunks if c]
    return bool(chunks) and (
        all(c in HALLUCINATIONS for c in chunks)
        or normalize_text(collapse_repeats(text, 1)) in HALLUCINATIONS
    )

def keep_segment(audio, seg) -> bool:
    if not is_hallucination(seg.text):
        return True
    piece = audio[int(seg.start * SAMPLE_RATE):int(seg.end * SAMPLE_RATE)]
    rms = float(np.sqrt(np.mean(piece * piece))) if len(piece) else 0.0
    keep = rms >= HALLU_QUIET_RMS and seg.no_speech_prob < HALLU_NO_SPEECH and seg.avg_logprob > HALLU_MIN_LOGPROB
    if not keep:
        vlog(f"[FILTRO] descartado '{seg.text.strip()}' (rms={rms:.3f} no_speech={seg.no_speech_prob:.2f} "
              f"logprob={seg.avg_logprob:.2f})")
    return keep

# Palabras dudosas: Whisper da una probabilidad por palabra y la app subraya las que quedan por debajo de
# LOW_CONFIDENCE. Pedir esas probabilidades añade un paso corto de alineación en la GPU; WORD_CONFIDENCE=0 lo apaga.
WORD_CONFIDENCE = os.environ.get("WORD_CONFIDENCE", "1") != "0"
LOW_CONFIDENCE  = 0.5

def uncertain_tokens(text: str, words) -> list[int]:
    """Posiciones (en text.split()) de las palabras con probabilidad baja. collapse_repeats puede haber quitado
    palabras, así que se alinea por contenido, avanzando en orden, en vez de asumir que coinciden una a una."""
    out, j = [], 0
    for i, token in enumerate(text.split()):
        key = normalize_text(token)
        if not key:
            continue
        for k in range(j, min(j + 8, len(words))):
            if normalize_text(words[k].word) == key:
                if words[k].probability < LOW_CONFIDENCE:
                    out.append(i)
                j = k + 1
                break
    return out

def run_transcribe(audio, lang, prev_text, prev_lang):
    """Transcribe forzando `lang`. Devuelve (texto, avg_logprob ponderado por duración, palabras dudosas,
    palabras con sus tiempos)."""
    context = prev_text[-150:] if (CONTEXT_PROMPT and prev_text and lang == prev_lang and any(c in prev_text for c in ",.?!¿")) else ""
    style = STYLE_PROMPTS.get(lang, "") if STYLE_PROMPT else ""
    prompt = (style + " " + context).strip() or None
    segments, info = model.transcribe(
        audio,
        language=lang,
        beam_size=BEAM_SIZE,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
        condition_on_previous_text=False,
        initial_prompt=prompt,
        hotwords=HOTWORDS.get(lang) or None,
        word_timestamps=WORD_CONFIDENCE,
    )
    # transcribe() es perezoso: el trabajo de GPU ocurre al recorrer los segmentos.
    raw = list(segments)
    segs = [s for s in raw if keep_segment(audio, s)]
    if not segs:
        # Para saber quién se comió el audio: el VAD (poco o nada tras él) o Whisper (audio de sobra, sin texto).
        vlog(f"[WHISPER] sin texto en {lang}: {info.duration_after_vad:.1f} de {info.duration:.1f} s pasan el VAD, "
             f"{len(raw)} segmentos de Whisper")
        return "", float("-inf"), [], []
    weights = [max(s.end - s.start, 0.01) for s in segs]
    score = sum(s.avg_logprob * w for s, w in zip(segs, weights)) / sum(weights)
    text = collapse_repeats("".join(s.text for s in segs).strip())
    words = [w for s in segs for w in (s.words or [])]
    return text, score, uncertain_tokens(text, words), words

def transcribe_sync(audio, prev_text="", prev_lang=None):
    t_start = time.perf_counter()
    # 1. Detectar el idioma del audio original. Sin VAD aquí: transcribe() ya lo aplica abajo,
    #    y el segmento ya llega recortado por silencios (RMS), así que pasarlo dos veces no aporta.
    _, _, all_probs = model.detect_language(audio, vad_filter=False)
    t_detected = time.perf_counter()
    probs = {code: p for code, p in all_probs if code in ALLOWED_LANGS}
    total = sum(probs.values())
    shares = {c: (probs.get(c, 0.0) / total if total > 0 else 0.5) for c in ALLOWED_LANGS}
    lang = max(shares, key=shares.get)

    # 2. Transcripción en el idioma original
    confident = shares[lang] >= LANG_CONFIDENT
    if confident:
        transcript_text, _, uncertain, words = run_transcribe(audio, lang, prev_text, prev_lang)
    else:
        # Con la GPU libre, es y en se transcriben a la vez y la duda no duplica la espera. Si hay otros segmentos
        # en curso van una detrás de otra: con 5 clientes dudando a la vez, 10 transcripciones simultáneas
        # dejaban las traducciones esperando 2–2.6 s.
        if metrics.in_flight <= 1:
            with ThreadPoolExecutor(max_workers=len(ALLOWED_LANGS)) as pool:
                futures = {c: pool.submit(run_transcribe, audio, c, prev_text, prev_lang) for c in ALLOWED_LANGS}
                results = {c: f.result() for c, f in futures.items()}
        else:
            results = {c: run_transcribe(audio, c, prev_text, prev_lang) for c in ALLOWED_LANGS}
        lang = max(ALLOWED_LANGS, key=lambda c: results[c][1])
        transcript_text, _, uncertain, words = results[lang]
        vlog(f"[IDIOMA] dudoso (es={shares['es']:.2f} en={shares['en']:.2f}) → logprob "
              f"es={results['es'][1]:.2f} en={results['en'][1]:.2f}, anterior={prev_lang} → {lang}")

    timings = {"start": t_start, "detect_s": t_detected - t_start, "proc_s": time.perf_counter() - t_start}
    return transcript_text, lang, confident, uncertain, words, timings

# Al cortar por MAX_SEGMENT_S la persona sigue hablando, y Whisper "termina" la frase partida inventando:
# "how the real translation system works" salió "how the real truth is." Por eso la última frase de un
# segmento cortado por el límite no se muestra: su audio vuelve al búfer y se transcribe con lo que sigue.
# Si esa frase ocupa más de HOLD_MAX_S (o no hay ningún final de frase), se retienen solo las palabras de
# los últimos HOLD_TAIL_S. Necesita los tiempos por palabra (WORD_CONFIDENCE=1, el valor por defecto).
HOLD_MAX_S  = 8.0
HOLD_TAIL_S = 2.0

def split_unfinished(words, audio_s: float):
    """(palabras que se muestran ya, segundo desde el que se retiene el audio) o None si no hay que retener."""
    if len(words) < 2:
        return None
    ends = [i for i, w in enumerate(words[:-1]) if w.word.strip().endswith((".", "?", "!", "…"))]
    if ends and audio_s - words[ends[-1] + 1].start <= HOLD_MAX_S:
        keep = ends[-1] + 1
    else:
        keep = next((i for i, w in enumerate(words) if w.start >= audio_s - HOLD_TAIL_S), len(words))
    if keep == 0 or keep >= len(words):
        return None
    return words[:keep], max(0.0, words[keep].start - 0.1)

SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")
# Cifras con sus separadores, incluido el guion de los teléfonos (1-431-1000) y rangos (5-10).
NUMBER = re.compile(r"\d+(?:[.,:/-]\d+)*")
# Lo que un traductor puede devolver sin estar roto: alfabeto latino con acentos, puntuación y símbolos comunes.
# Otra escritura (los "瀛ʘ" de una salida degenerada) o una letra repetida sin fin delatan que el modelo se perdió.
NON_LATIN = re.compile(r"[^\u0000-ɏ -⁯€]")
RUNAWAY   = re.compile(r"(.)\1{7,}")

def number_digits(text: str) -> list[str]:
    """Cifras sin separadores, para comparar "9.0" con "9,0" o "1,000" con "1.000"."""
    return sorted(re.sub(r"\D", "", n) for n in NUMBER.findall(text))

def mask_numbers(sentence: str) -> tuple[str, list[str]]:
    """'mi teléfono es 801-431-1000' → ('mi teléfono es [1]', ['801-431-1000']). Los modelos de traducción se
    inventan o repiten dígitos (un 7.7 salió como "2.2.1.1. 7.7", un teléfono como "2177777…"); con la cifra
    tapada no pueden tocarla, y al final se devuelve tal cual."""
    numbers = []
    def hide(m):
        numbers.append(m.group())
        return f"[{len(numbers)}]"
    return NUMBER.sub(hide, sentence), numbers

def unmask_numbers(text: str, numbers: list[str]) -> str | None:
    """Repone las cifras; None si el modelo perdió, duplicó o renumeró alguna marca."""
    for i, n in enumerate(numbers, 1):
        if text.count(f"[{i}]") != 1:
            return None
        text = text.replace(f"[{i}]", n)
    return text

def looks_broken(out: str, source: str) -> bool:
    return (not out or NON_LATIN.search(out) is not None or RUNAWAY.search(out) is not None
            or len(out) > 2.5 * len(source) + 20)

def run_mt(sentences: list[str], tgt: str, tok, beam: int = MT_BEAM, **options) -> list[str]:
    if IS_M2M:
        source = [tok.convert_ids_to_tokens(tok.encode(s)) for s in sentences]
        prefix, skip = [[f"__{tgt}__"]] * len(sentences), 1  # la salida empieza por el token del idioma
    else:
        source = [tok.convert_ids_to_tokens(tok.encode(f"<2{tgt}> {s}")) for s in sentences]
        prefix, skip = None, 0
    # Tope proporcional a la frase: una salida que se desboca se corta pronto en vez de llenar la burbuja.
    limit = min(256, 2 * max(len(s) for s in source) + 16)
    results = mt_model.translate_batch(source, target_prefix=prefix, beam_size=beam, max_decoding_length=limit, **options)
    return [tok.decode(tok.convert_tokens_to_ids(r.hypotheses[0][skip:]), skip_special_tokens=True).strip()
            for r in results]

# Palabras muy frecuentes de cada idioma, para saber en qué idioma está cada frase de un segmento.
# Fuera las que existen en los dos ("no", "me", "he", "has", "son").
ES_WORDS = set("el la los las de del que y en un una por para con es lo se su al como pero más muy qué "
               "hay si mi yo le te esto eso está están fue ser tengo tiene puede".split())
EN_WORDS = set("the and of to is in it that you for with on this are be was have what my i not but at so "
               "there if do does can will your we they she am get".split())

def sentence_lang(sentence: str, default: str) -> str:
    """es/en de una frase suelta. Un segmento cortado por el límite puede juntar a dos personas, una en cada
    idioma; Whisper deja cada parte en su idioma, y "traducir" inglés a inglés hacía que el modelo recortara
    ("Good morning, my name is…" salió sin el "Good morning")."""
    lower = sentence.lower()
    words = re.findall(r"[a-záéíóúüñ']+", lower)
    es = sum(w in ES_WORDS for w in words) + 2 * bool(re.search(r"[ñ¿¡]", lower))
    en = sum(w in EN_WORDS for w in words)
    return "es" if es > en else "en" if en > es else default

def translate_sync(text: str, src: str):
    """Traduce es↔en frase a frase (estos modelos se entrenaron con frases sueltas), en un solo lote.
    Las frases que ya están en el idioma destino pasan tal cual. Devuelve (traducción, idioma destino,
    si las cifras coinciden, segundos)."""
    t_start = time.perf_counter()
    tgt = "en" if src == "es" else "es"
    tok = mt_tokenizers[src]
    sentences = [s for s in SENTENCE_END.split(text) if s.strip()]
    out: list[str | None] = [s if sentence_lang(s, src) == tgt else None for s in sentences]
    todo = [i for i, o in enumerate(out) if o is None]

    if todo:
        masked = [mask_numbers(sentences[i]) for i in todo]
        first = run_mt([m for m, _ in masked], tgt, tok)
        for i, (_, numbers), o in zip(todo, masked, first):
            unmasked = unmask_numbers(o, numbers)
            out[i] = None if unmasked is None or looks_broken(unmasked, sentences[i]) else unmasked
            if out[i] is None:
                vlog(f"   ⚠️ [TRADUCCIÓN] descartada: {sentences[i]!r} → {o[:160]!r}")

    # Lo que salió mal se reintenta sin marcas, con beam 4 y prohibiendo repetir 4 palabras seguidas (corta los
    # bucles). Antes se usaba repetition_penalty, que castiga cualquier palabra ya usada: una frase con dos "y"
    # no podía repetir "and" y el modelo se inventó media frase ("sets the language of the speaker…").
    # Si tampoco sirve, el intérprete ve la frase original con ⚠: mejor sin traducir que con una cifra inventada.
    retry = [i for i, o in enumerate(out) if o is None]
    if retry:
        second = run_mt([sentences[i] for i in retry], tgt, tok, beam=4, no_repeat_ngram_size=4)
        for i, o in zip(retry, second):
            ok = not looks_broken(o, sentences[i]) and number_digits(o) == number_digits(sentences[i])
            out[i] = o if ok else f"⚠ {sentences[i]}"
            vlog(f"   ⚠️ [TRADUCCIÓN] reintento {'válido' if ok else 'fallido'}: {sentences[i]!r} → {o[:120]!r}")

    result = " ".join(out)
    # Un 9.0 traducido como 8.0 es peor que no traducir: se avisa para que el intérprete lo compruebe.
    return result, tgt, number_digits(result) == number_digits(text), time.perf_counter() - t_start

def warm_up():
    """La primera pasada por cada modelo inicializa la GPU y tardaba ~1 s de más; mejor aquí que con el primer
    usuario. El silencio con ruido suave obliga a Whisper a decodificar (con VAD no llegaría al modelo)."""
    t = time.perf_counter()
    noise = (np.random.default_rng(0).standard_normal(SAMPLE_RATE * 2) * 0.01).astype(np.float32)
    model.detect_language(noise, vad_filter=False)
    list(model.transcribe(noise, language="es", beam_size=BEAM_SIZE, vad_filter=False, word_timestamps=WORD_CONFIDENCE)[0])
    if mt_model:
        run_mt(["Buenos días, ¿cómo se siente hoy?"], "en", mt_tokenizers["es"])
    print(f"Modelos calentados ({time.perf_counter() - t:.1f} s)")

warm_up()

async def accept_with_code(websocket: WebSocket) -> tuple[str, dict] | None:
    """Acepta el socket y valida el código; si no vale, avisa, cierra y devuelve None."""
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
        return None
    return code_hash, info

def new_client(websocket: WebSocket, client_id: int, code_hash: str, info: dict) -> dict:
    forwarded = websocket.headers.get("x-forwarded-for", "")
    now = time.time()
    return {
        "id": client_id,
        "name": info["name"],
        "code_hash": code_hash[:12],
        "expires": info.get("expires"),
        "ip": forwarded.split(",")[0].strip() or (websocket.client.host if websocket.client else "?"),
        "user_agent": websocket.headers.get("user-agent", ""),
        "connected_at": now,
        "code_hash_full": code_hash,
        "last_activity": now,
    }

@app.websocket("/ws/transcribe")
async def websocket_endpoint(websocket: WebSocket):
    auth = await accept_with_code(websocket)
    if not auth:
        return
    code_hash, info = auth
    client_id = next(client_ids)
    client = clients[client_id] = {**new_client(websocket, client_id, code_hash, info), "segments": 0, "audio_s": 0.0}
    print(f">>> Cliente #{client_id} conectado: {info['name']} ({client['ip']}) <<<")
    # Se registra antes de esperar el cierre de la anterior, para que dos conexiones simultáneas no se cuelen.
    previous = active_by_code.get(code_hash)
    active_by_code[code_hash] = (client_id, websocket)
    if previous:
        await replace_previous(*previous)
    # La app saluda al usuario por su nombre ("Welcome …!") y muestra el tiempo ya usado con este código;
    # los clientes viejos ignoran este mensaje.
    used_s = sum(x["end"] - x["start"] for x in load_sessions() if x["code_hash"] == code_hash)
    # "flush" avisa de que el servidor acepta {"flush": true}; las apps viejas solo envían audio binario.
    await websocket.send_json({"ok": True, "name": info["name"], "used_s": max(0, round(used_s)), "flush": True})
    loop = asyncio.get_running_loop()

    pcm = bytearray()
    has_speech = False
    silence_s = 0.0
    held_s = 0.0  # audio retenido de una frase sin terminar, ya contado en el uso del cliente
    held_text = ""  # lo que Whisper entendió en ese audio, por si al repetirlo se lo salta
    levels, levels_s = collections.deque(), 0.0  # (rms, duración) de lo recibido, para el umbral adaptativo
    threshold = RMS_THRESHOLD
    prev_text = ""
    prev_lang = None
    recent = collections.deque(maxlen=MAX_REPEATS)

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))
            data = message.get("bytes")
            # Botón "SEND" de la app: transcribir ya lo que haya en el búfer, sin esperar pausa ni límite.
            manual = False
            if data is None:
                try:
                    manual = json.loads(message.get("text") or "{}").get("flush") is True
                except (ValueError, AttributeError):
                    pass
                if not manual:
                    continue
                data = b""
            elif len(data) < 2:
                continue

            pcm.extend(data)
            dur = (len(data) // 2) / SAMPLE_RATE
            level = rms_int16(data)
            if dur > 0:
                levels.append((level, dur))
                levels_s += dur
                while levels_s > NOISE_WINDOW_S:
                    levels_s -= levels.popleft()[1]
                threshold = speech_threshold(levels, levels_s)
            if not has_speech:
                keep = int(PREROLL_S * SAMPLE_RATE) * 2
                if len(pcm) > keep:
                    del pcm[:len(pcm) - keep]
                # Un "Good morning" dicho flojo no llegaba al umbral de volumen y se tiraba como silencio: con
                # algo de sonido, el VAD decide si ya es voz.
                has_speech = level >= threshold or (
                    level >= DIGITAL_SILENCE and await loop.run_in_executor(None, has_voice, bytes(pcm)))
                if not has_speech:
                    continue

            buf_s = len(pcm) / 2 / SAMPLE_RATE
            # Un trozo claramente fuerte es voz seguro: se ahorra el VAD.
            if level >= 2 * threshold or buf_s < MIN_SEGMENT_S:
                silence_s = 0.0
            else:
                tail = bytes(pcm[-int(VAD_TAIL_S * SAMPLE_RATE) * 2:])
                silence_s = await loop.run_in_executor(None, trailing_silence, tail)
            if DEBUG_RMS:
                print(f"rms={level:.4f} umbral={threshold:.4f} silencio={silence_s:.2f}")
            needed = END_OF_TURN_S if buf_s - silence_s < SHORT_SPEECH_S else SILENCE_CUT_S
            pausa = silence_s >= needed and buf_s >= MIN_SEGMENT_S
            demasiado_largo = buf_s >= MAX_SEGMENT_S
            if not (pausa or demasiado_largo or manual):
                continue

            usable = len(pcm) - (len(pcm) % 2)
            cut = quietest_cut(pcm) if (demasiado_largo and not pausa and not manual) else usable
            seg_bytes = bytes(pcm[:cut])
            audio = np.frombuffer(seg_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            if cut < usable:
                del pcm[:cut]
            else:
                pcm.clear()
            # Si se cortó en mitad del habla, lo que queda sigue siendo voz y abre el siguiente segmento.
            has_speech = len(pcm) >= 2
            silence_s = 0.0

            # Ruido que pasó el umbral de volumen pero no tiene voz: fuera sin gastar GPU (antes llegaba a
            # Whisper y a veces salía un "Gracias.").
            if not manual and not held_s and not await loop.run_in_executor(None, has_voice, seg_bytes):
                vlog(f"[VAD] {len(seg_bytes) / 2 / SAMPLE_RATE:.1f} s sin voz, descartados")
                continue

            # Eliminar o dejar vencer un código corta también la sesión que ya estaba abierta.
            info = cached_codes().get(code_hash)
            if not info or not code_status(info)[0]:
                print(f">>> Cliente #{client_id} ({client['name']}): código vencido o eliminado, cerrando. <<<")
                await websocket.send_json({"error": "Tu código de acceso ha vencido."})
                await websocket.close(code=4401)
                break

            motivo = "pausa" if pausa else "límite máx." if demasiado_largo else "manual"
            client["audio_s"] += len(audio) / SAMPLE_RATE - held_s
            seg_held_s, seg_held_text = held_s, held_text
            held_s, held_text = 0.0, ""
            vlog(f"[AUDIO] {len(audio)/SAMPLE_RATE:.1f} s ({motivo}, umbral {threshold:.3f})")
            # La app muestra una flecha ↑ mientras procesa y la cambia por lo que tardó la respuesta; si el
            # segmento se descarta, {"processing": false} la quita. Las apps viejas ignoran estos mensajes.
            await websocket.send_json({"processing": True})

            t_ready = time.perf_counter()
            metrics.in_flight += 1
            concurrency = metrics.in_flight  # segmentos compitiendo por la GPU, incluido este
            try:
                text, lang, confident, uncertain, words, timings = await loop.run_in_executor(
                    None, transcribe_sync, audio, prev_text, prev_lang
                )
            except Exception as e:
                print(f"[WHISPER ERROR]: {e}")
                metrics.bucket["errors"] += 1
                await websocket.send_json({"processing": False})
                continue
            finally:
                metrics.in_flight -= 1
            metrics.segment(code_hash, len(audio) / SAMPLE_RATE, timings["start"] - t_ready, timings["detect_s"],
                            timings["proc_s"], time.perf_counter() - t_ready, concurrency)

            if SAVE_SEGMENTS:
                try:
                    save_segment(audio, client_id, text, lang, motivo)
                except OSError as e:
                    print(f"[SAVE_SEGMENTS ERROR]: {e}")

            # Si este segmento empieza con audio retenido y Whisper no puso ninguna palabra ahí, se lo saltó
            # ("within a few seconds." desapareció así): se repone lo que entendió la primera vez.
            skipped_held = seg_held_s >= 0.8 and not any(w.start < seg_held_s - 0.3 for w in words)

            # El búfer solo crece con lo que llega por el socket, y mientras se transcribía no se leyó nada:
            # la frase retenida va delante de lo que quedó tras el corte, en su orden.
            split = split_unfinished(words, len(audio) / SAMPLE_RATE) if (text and motivo == "límite máx.") else None
            if split:
                kept, hold_from = split
                tail = seg_bytes[int(hold_from * SAMPLE_RATE) * 2:]
                pcm[:0] = tail
                has_speech = True
                held_s = len(tail) / 2 / SAMPLE_RATE
                held_text = "".join(w.word for w in words[len(kept):]).strip()
                vlog(f"[CORTE] retenidos {held_s:.1f} s sin terminar: {held_text!r}")
                text = collapse_repeats("".join(w.word for w in kept).strip())
                uncertain = uncertain_tokens(text, kept)

            if skipped_held:
                vlog(f"[CORTE] Whisper se saltó lo retenido; se repone: {seg_held_text!r}")
                shift = len(seg_held_text.split())
                text = (seg_held_text + " " + text).strip()
                uncertain = [i + shift for i in uncertain]

            if not text:
                vlog("[WHISPER] Silencio/ruido filtrado.")
                await websocket.send_json({"processing": False})
                continue

            # La misma frase en segmentos seguidos (un "thank you" en bucle) también se corta tras dos veces.
            key = normalize_text(text)
            if len(recent) == MAX_REPEATS and all(r == key for r in recent):
                vlog(f"[FILTRO] repetido, omitido: {text}")
                await websocket.send_json({"processing": False})
                continue
            recent.append(key)

            prev_text = (prev_text + " " + text)[-300:] if lang == prev_lang else text
            prev_lang = lang
            client.update(segments=client["segments"] + 1, last_activity=time.time())

            vlog(f"✅ [{client['name']}] [{lang.upper()}]: {text}")

            # La traducción va en el mismo mensaje, para que el original y su traducción aparezcan a la vez.
            # Si falla, se envía solo la transcripción y la app traduce por su cuenta.
            # Se espera a la traducción antes de seguir con el audio: mandarla a segundo plano para adelantar el
            # siguiente segmento solo metía más trabajos a la vez en una GPU ya llena (con 5 clientes, la última
            # frase llegaba 1.5 s más tarde).
            reply = {
                "transcript": text,
                "language": lang,
                "confident": confident,
                "uncertain": uncertain,  # índices de palabras (text.split()) que Whisper no tiene claras
            }
            if mt_model:
                try:
                    translation, tr_lang, numbers_ok, tr_s = await loop.run_in_executor(None, translate_sync, text, lang)
                    reply.update(translation=translation, translation_language=tr_lang,
                                   translation_numbers_ok=numbers_ok)
                    vlog(f"   ↳ [{tr_lang.upper()}] ({tr_s * 1000:.0f} ms): {translation}")
                    if not numbers_ok:
                        vlog(f"   ⚠️ [CIFRAS] no coinciden: {number_digits(text)} → {number_digits(translation)}")
                except Exception as e:
                    print(f"[TRADUCCIÓN ERROR]: {e}")
            await websocket.send_json(reply)

    except WebSocketDisconnect:
        pass
    except Exception:
        # Una sesión reemplazada puede fallar al recibir/enviar sobre el socket ya cerrado: es lo esperado.
        if not client.get("replaced"):
            raise
    finally:
        clients.pop(client_id, None)
        if active_by_code.get(code_hash, (None,))[0] == client_id:
            del active_by_code[code_hash]
        log_session(client)
        print(f">>> Cliente #{client_id} ({client['name']}) desconectado. <<<")

if __name__ == "__main__":
    # PUBLIC_URL lo define start-vast.sh (Cloudflare Tunnel); en RunPod se deduce del proxy del pod.
    pod_id = os.environ.get("RUNPOD_POD_ID")
    public_url = os.environ.get("PUBLIC_URL", "").rstrip("/")
    if not public_url and pod_id:
        public_url = f"https://{pod_id}-8000.proxy.runpod.net"
    # Cada valor va solo en su línea para poder copiarlo con doble/triple clic sin arrastrar la etiqueta.
    if public_url:
        host = public_url.removeprefix("https://")
        print(f"\n * URL del cliente:\n\nwss://{host}/ws/transcribe\n")
        print(f" * URL admin:\n\n{public_url}/api/admin/stats\n")
    print(f" * Token admin:\n\n{ADMIN_TOKEN}\n")
    if os.path.exists(CODES_FILE):
        print(f" * Códigos autorizados: {len(load_codes())}\n")
    else:
        print(" * ⚠️  No hay authorized_codes.json: nadie podrá conectarse. Súbelo por Jupyter o con push-codes.\n")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info", access_log=VERBOSE)