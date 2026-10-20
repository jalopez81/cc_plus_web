# cd /workspace && bash starth.bh
# server.py — Servidor optimizado puramente para transcripción en tiempo real (Faster-Whisper)
import os, asyncio, inspect
import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

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

@app.get("/")
def health():
    return {"status": "ok"}

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
    # 1. Detectar el idioma del audio original
    _, _, all_probs = model.detect_language(audio, vad_filter=True)
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
    transcript_text = "".join(s.text for s in segments_orig).strip()

    return transcript_text, lang

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
                text, lang = await loop.run_in_executor(
                    None, transcribe_sync, audio, prev_text, prev_lang
                )
            except Exception as e:
                print(f"[WHISPER ERROR]: {e}")
                continue

            if not text:
                print("[WHISPER] Silencio/ruido filtrado.")
                continue

            prev_text = (prev_text + " " + text)[-300:] if lang == prev_lang else text
            prev_lang = lang
            
            print(f"✅ [{lang.upper()}]: {text}")

            # Enviamos únicamente la transcripción limpia y el idioma detectado al cliente
            await websocket.send_json({
                "transcript": text,
                "language": lang
            })

    except WebSocketDisconnect:
        print(">>> Cliente desconectado. <<<")

if __name__ == "__main__":
    pod_id = os.environ.get("RUNPOD_POD_ID")
    if pod_id:
        print(f"\n * URL del cliente: wss://{pod_id}-8000.proxy.runpod.net/ws/transcribe\n")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")