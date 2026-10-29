# Configuración ideal del servidor de transcripción

- **Hardware:** RTX 4090 de 24 GB, 8 o más núcleos de CPU, 32 GB de RAM o más, ~50 GB de disco. Aguanta ~10 usuarios.
- **Arranque:** `bash start-vast.sh` (con `--verbose` para ver el log). Los valores por defecto ya son la mejor configuración.
- **Whisper:** large-v3-turbo, 2 copias, beam 3, prompt de estilo encendido.
- **Traducción:** MADLAD-400 3B, 2 copias, beam 2, cifras protegidas.
- **Idioma:** si Whisper duda (menos de 0.80), transcribe en los dos idiomas y se queda con el mejor.
- **Pausas:** las detecta Silero VAD. El volumen solo abre el búfer, con un umbral adaptativo.
- **Cortes:** por pausa a 1.0 s de silencio (1.5 s si se ha dicho poco), con un máximo de 10 s por segmento.
- **Frases cortadas por el límite:** se retienen (hasta 8 s) y se transcriben completas con lo que sigue.
- **Texto provisional:** cada 1.5 s, con traducción rápida, solo si la GPU tiene hueco.
- **App 1.5.22:** muestra el texto provisional en gris, escrito palabra a palabra, y lo reemplaza con el definitivo.
- **Resultados en la 4090:** 5 clientes, 0.50 s de media; 10 clientes con provisional, 2.04 s de media. Texto correcto en las dos pruebas.
- **Pendiente:** el ⚠ en la frase con "$50", el error de Whisper con "background noise", y una prueba con audio de llamada real.
