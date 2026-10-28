const PING_MS = 20000;
const MAX_RETRIES = 3;
// Server close codes that end the session for good: bad/expired code, or the code connected elsewhere.
const FINAL_CLOSE_CODES = new Set([4401, 4409]);

// Unknown or expired codes are issued by the admin, so point users there (not when the code moved to another computer).
export function withCodeHint(message) {
  const needsCode = /c[oó]digo de acceso/i.test(message) && !/otro equipo/i.test(message);
  return needsCode ? `${message} Ask in the LCP_LIVE_CAPTION_PLUS WhatsApp group.` : message;
}

// Deepgram audio goes straight to Deepgram, but the access code is still checked by our server:
// this socket stays open for the whole session so the admin panel shows the user as connected.
export class AccessSession {
  constructor({ url, accessCode, onLost }) {
    this.url = url;
    this.accessCode = accessCode;
    this.onLost = onLost;
    this.retries = 0;
    this.closed = false;
  }

  // Resolves once the server accepts the code; rejects with the server's message (or a network error) otherwise.
  open() {
    return new Promise((resolve, reject) => {
      let accepted = false;
      let serverError = '';
      const ws = new WebSocket(this.url, ['token', this.accessCode]);
      this.ws = ws;

      ws.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data?.ok) {
          accepted = true;
          this.retries = 0;
          this.ping = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send('ping');
          }, PING_MS);
          resolve({ name: data.name ? String(data.name) : '', usedS: Number.isFinite(data.used_s) ? data.used_s : null });
        } else if (data?.error) {
          serverError = withCodeHint(String(data.error));
          // Revoked, expired or moved to another computer: end the call now, without waiting for the close handshake.
          if (accepted && !this.closed) {
            this.close();
            this.onLost(serverError);
          }
        }
      };

      ws.onclose = (event) => {
        clearInterval(this.ping);
        if (this.closed) return;
        if (!accepted) {
          const error = new Error(serverError || 'Could not reach the access server. Check the server URL and network.');
          error.final = Boolean(serverError);
          reject(error);
          return;
        }
        if (FINAL_CLOSE_CODES.has(event.code)) this.onLost(serverError || 'Access code rejected by the server.');
        else this.reconnect();
      };
    });
  }

  // A dropped network shouldn't end the call right away; give the server a few chances to come back.
  reconnect() {
    if (this.closed) return;
    if (this.retries >= MAX_RETRIES) {
      this.onLost('Lost connection to the access server.');
      return;
    }
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.open().catch((error) => {
        if (this.closed) return;
        if (error.final) this.onLost(error.message);
        else this.reconnect();
      });
    }, 2000 * this.retries);
  }

  close() {
    this.closed = true;
    clearInterval(this.ping);
    clearTimeout(this.retryTimer);
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.close(1000);
    this.ws = null;
  }
}
