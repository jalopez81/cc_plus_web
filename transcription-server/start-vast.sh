#!/usr/bin/env bash
# start-vast.sh — arranca el servidor en Vast.ai detrás de un Cloudflare Tunnel (wss:// sin abrir puertos)
#
# Modos:
#   CLOUDFLARE_TUNNEL_TOKEN=...  PUBLIC_HOSTNAME=whisper.tudominio.com  bash start-vast.sh
#       Túnel con nombre: URL fija en tu dominio (recomendado para producción).
#   bash start-vast.sh
#       Quick tunnel: URL aleatoria *.trycloudflare.com que cambia en cada arranque (solo pruebas).
set -e
cd "$(dirname "$0")"

# /workspace sobrevive a Stop en Vast; start.sh guarda ahí la caché de modelos.
mkdir -p /workspace/hf_cache

if ! command -v cloudflared >/dev/null 2>&1; then
  echo ">>> Instalando cloudflared..."
  curl -fsSL -o /usr/local/bin/cloudflared \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x /usr/local/bin/cloudflared
fi

# Al relanzar el script no deben quedar dos túneles apuntando al mismo puerto.
pkill -f "cloudflared tunnel" 2>/dev/null || true

# --protocol http2: Vast suele bloquear el UDP que usa QUIC, y cloudflared pierde un buen rato antes de caer a HTTP/2.
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
  echo ">>> Arrancando túnel de Cloudflare con nombre..."
  # El token va por variable de entorno, no como argumento, para que no aparezca en `ps`.
  TUNNEL_TOKEN="$CLOUDFLARE_TUNNEL_TOKEN" nohup cloudflared tunnel --no-autoupdate --protocol http2 run > cloudflared.log 2>&1 &
  if [ -n "$PUBLIC_HOSTNAME" ]; then
    export PUBLIC_URL="https://$PUBLIC_HOSTNAME"
  else
    echo "!!! Define PUBLIC_HOSTNAME (p. ej. whisper.tudominio.com) para que el servidor muestre la URL del cliente."
  fi
else
  echo ">>> Sin CLOUDFLARE_TUNNEL_TOKEN: usando quick tunnel (URL temporal)..."
  nohup cloudflared tunnel --no-autoupdate --protocol http2 --url http://localhost:8000 > cloudflared.log 2>&1 &
  for _ in $(seq 1 30); do
    PUBLIC_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' cloudflared.log | head -n 1 || true)
    [ -n "$PUBLIC_URL" ] && break
    sleep 1
  done
  if [ -n "$PUBLIC_URL" ]; then
    export PUBLIC_URL
  else
    echo "!!! No se obtuvo la URL del quick tunnel; revisa cloudflared.log"
  fi
fi

exec bash start.sh
