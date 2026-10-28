# Servidor de control (Cloudflare)

Servidor pequeño y siempre encendido, en el plan gratis de Cloudflare Workers. Hace dos cosas:

- **Guarda los códigos de acceso.** Es la lista maestra.
- **Recibe a los usuarios de Deepgram.** Su audio va directo a Deepgram, pero la app abre `wss://control.life-caption-plus.bid/ws/session` con el código y la mantiene abierta toda la llamada. Si el código no es válido, la app no arranca. Si lo eliminas o vence, la llamada se corta en segundos.

`admin.html` se conecta a él igual que al servidor GPU: elige **Control · Deepgram** en el selector de arriba.

## Primera vez

```bash
cd control-server
npm install
npx wrangler login                 # abre el navegador para entrar a tu cuenta de Cloudflare
npx wrangler secret put ADMIN_TOKEN # pega un token largo inventado; es la contraseña del panel
npx wrangler deploy
```

`deploy` crea el subdominio `control.life-caption-plus.bid`. El dominio tiene que estar en la misma cuenta de Cloudflare. Si prefieres otro nombre, cámbialo en `wrangler.toml` y en `CONTROL_URL` de `src/main.js`.

Después:

1. Abre `admin.html`, elige **Control · Deepgram** y pon el token.
2. Para cargar los códigos que ya tienes, usa **Importar respaldo** con tu `authorized_codes.json`.

## Día a día

- **Crear, renovar o eliminar códigos:** desde **Control · Deepgram**.
- **Cuando enciendas el GPU:** pulsa **Enviar códigos al GPU**. El GPU recibe una copia exacta de la lista.
- **Ver quién está conectado:** **Clientes Deepgram** (servidor de control) y **Clientes Conectados** (Whisper, servidor GPU).

## Probar en local

```bash
echo ADMIN_TOKEN=dev-token-local > .dev.vars
npm run dev          # http://127.0.0.1:8787
```

Para que la app de escritorio use el servidor local, arráncala con `CC_PLUS_CONTROL_URL=ws://127.0.0.1:8787/ws/session npm start`.

## Límites del plan gratis

El plan gratis cubre de sobra decenas de usuarios. La app manda un ping cada 20 s y Cloudflare lo contesta sin despertar el servidor.

Este control frena a cualquier usuario normal. Quien modifique el código de la app podría saltárselo, porque la clave de Deepgram es suya.
