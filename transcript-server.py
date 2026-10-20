!pip install -q fastapi uvicorn faster-whisper pyngrok nest-asyncio av transformers sentencepiece sacremoses
!pip install -q "ctranslate2==4.6.0" "nvidia-cublas-cu12==12.4.5.8" "nvidia-cudnn-cu12==9.1.0.70"
# ---- 1. Make CUDA 12 / cuDNN 9 libs findable ----
import glob, os, site, sysconfig, ctypes

roots = set(site.getsitepackages() + [sysconfig.get_paths()["purelib"], "/usr/local/lib/python3.13/dist-packages"])
lib_files, lib_dirs = [], set()
for r in roots:
    for pat in ("libcublas*.so.12*", "libcublasLt*.so.12*", "libcudnn*.so.9*"):
        for p in glob.glob(f"{r}/nvidia/**/{pat}", recursive=True):
            lib_files.append(p)
            lib_dirs.add(os.path.dirname(p))

os.environ["LD_LIBRARY_PATH"] = ":".join(lib_dirs) + ":" + os.environ.get("LD_LIBRARY_PATH", "")

for p in lib_files:
    dest = os.path.join("/usr/lib", os.path.basename(p))
    if not os.path.exists(dest):
        try:
            os.symlink(p, dest)
        except Exception:
            pass

for name in ("libcublasLt.so.12", "libcublas.so.12", "libcudnn.so.9"):
    match = sorted(p for p in lib_files if os.path.basename(p).startswith(name))
    if match:
        ctypes.CDLL(match[0], mode=ctypes.RTLD_GLOBAL)

# ---- 2. Patch for metadata_errors ----
import faster_whisper, inspect
audio_path = inspect.getfile(faster_whisper.audio)
with open(audio_path, "r", encoding="utf-8") as f:
    content = f.read()
if 'metadata_errors="ignore"' in content:
    with open(audio_path, "w", encoding="utf-8") as f:
        f.write(content.replace(', metadata_errors="ignore"', ""))

# ---- 3. Modelos y servidor ----
import asyncio, numpy as np, uvicorn, nest_asyncio, torch
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel
from transformers import MarianMTModel, MarianTokenizer
from pyngrok import ngrok

nest_asyncio.apply()
app = FastAPI()

print("Cargando modelo Whisper en la GPU...")
model = WhisperModel("medium", device="cuda", compute_type="float16")
print("¡Whisper cargado!")

# ---- Traductores (idioma detectado -> idioma destino) ----
TRANSLATE_TO = {"en": "es", "es": "en"}

TRANSLATORS = {}
for src, tgt in TRANSLATE_TO.items():
    name = f"Helsinki-NLP/opus-mt-{src}-{tgt}"
    print(f"Cargando traductor {src}->{tgt}...")
    tok = MarianTokenizer.from_pretrained(name)
    mdl = MarianMTModel.from_pretrained(name).to("cuda").half().eval()
    TRANSLATORS[src] = (tok, mdl, tgt)
print("¡Traductores cargados!")

def translate_sync(text, src_lang):
    if src_lang not in TRANSLATORS:
        return "", None
    tok, mdl, tgt = TRANSLATORS[src_lang]
    batch = tok([text], return_tensors="pt", padding=True, truncation=True, max_length=256).to("cuda")
    with torch.no_grad():
        out = mdl.generate(**batch, num_beams=4, max_new_tokens=256)
    return tok.decode(out[0], skip_special_tokens=True), tgt

# ---- Parámetros de segmentación (ajustables) ----
SAMPLE_RATE    = 16000
RMS_THRESHOLD  = 0.012   # umbral de "hay voz"; súbelo si el ruido de fondo cuenta como voz
SILENCE_CUT_S  = 0.5     # pausa que marca el fin de una frase
MIN_SEGMENT_S  = 1.0     # no transcribir bloques más cortos que esto
MAX_SEGMENT_S  = 8.0     # corte forzado si alguien habla sin pausa
PREROLL_S      = 0.3     # audio previo conservado para no comerse el inicio de la frase
DEBUG_RMS      = False   # ponlo en True para calibrar el umbral

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
    _, _, all_probs = model.detect_language(audio, vad_filter=True)
    probs = {code: p for code, p in all_probs if code in ALLOWED_LANGS}
    lang = max(probs, key=probs.get)

    # Contexto previo solo si es del mismo idioma y ya viene puntuado
    context = prev_text[-150:] if (prev_text and lang == prev_lang and any(c in prev_text for c in ",.?!¿")) else ""
    prompt = (STYLE_PROMPTS[lang] + " " + context).strip()

    segments, info = model.transcribe(
        audio,
        language=lang,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
        condition_on_previous_text=False,
        initial_prompt=prompt,
    )
    text = "".join(s.text for s in segments).strip()
    return text, lang

@app.websocket("/ws/transcribe")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print(">>> ¡Cliente conectado por WebSocket! <<<")
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

            # Sin voz todavía: solo conservamos un pequeño "pre-roll"
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

            motivo = "pausa" if pausa else "límite máx."
            print(f"[AUDIO] {len(audio)/SAMPLE_RATE:.1f} s ({motivo})")

            try:
                text, lang = await loop.run_in_executor(None, transcribe_sync, audio, prev_text, prev_lang)
            except Exception as e:
                print(f"[WHISPER ERROR]: {e}")
                continue

            if not text:
                print("[WHISPER] Silencio/ruido filtrado.")
                continue

            prev_text = (prev_text + " " + text)[-300:] if lang == prev_lang else text
            prev_lang = lang
            print(f"✅ [{lang.upper()}]: {text}")

            try:
                translation, tgt_lang = await loop.run_in_executor(None, translate_sync, text, lang)
            except Exception as e:
                print(f"[TRADUCCIÓN ERROR]: {e}")
                translation, tgt_lang = "", None

            if translation:
                print(f"🌐 [{tgt_lang.upper()}]: {translation}")

            await websocket.send_json({
                "transcript": text,
                "language": lang,
                "translation": translation,
                "translation_language": tgt_lang,
            })

    except WebSocketDisconnect:
        print(">>> Cliente desconectado. <<<")

# ---- 4. ngrok ----
from google.colab import userdata

try:
    NGROK_TOKEN = userdata.get("NGROK_TOKEN")
except Exception as e:
    raise RuntimeError(
        "No se pudo leer NGROK_TOKEN. Revisa que exista en Secrets (🔑) "
        f"y que 'Notebook access' esté activado. Detalle: {e}"
    )

ngrok.set_auth_token(NGROK_TOKEN.strip())
ngrok.kill()
public_url = ngrok.connect(8000)
print(f"\n * Túnel activo: {public_url.public_url.replace('https', 'wss')}/ws/transcribe \n")

config = uvicorn.Config(app, host="0.0.0.0", port=8000, log_level="info")
await uvicorn.Server(config).serve()