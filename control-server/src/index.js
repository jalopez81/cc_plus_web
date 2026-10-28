// Servidor de control (Cloudflare Worker + Durable Object): códigos de acceso y sesiones de Deepgram.
// Los usuarios de Deepgram mandan el audio directo a Deepgram, pero la app abre /ws/session aquí con su código
// y la mantiene abierta toda la llamada. Así el panel los ve conectados y eliminar un código les corta la sesión.
// Habla la misma API de admin que server.py, para que admin.html funcione igual con los dos servidores.
import { DurableObject } from 'cloudflare:workers';

const SESSION_TIMEOUT_S = 75; // la app manda "ping" cada 20 s; sin noticias en este tiempo se da por caída
const SWEEP_MS = 60_000;      // cada cuánto se revisan vencimientos y conexiones muertas mientras haya sesiones

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

async function hashCode(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code.trim()));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Mismo formato que Python: isoformat(timespec="seconds") en UTC.
const isoNow = (date = new Date()) => date.toISOString().slice(0, 19) + '+00:00';

// [vigente, texto] — los códigos sin 'expires' no caducan.
function codeStatus(info) {
  if (!info.expires) return [true, 'sin caducidad'];
  const left = Date.parse(info.expires) - Date.now();
  if (left <= 0) return [false, `VENCIDO el ${info.expires.slice(0, 10)}`];
  return [true, `vence ${info.expires.slice(0, 10)} (${Math.floor(left / 86_400_000)} días)`];
}

function intField(body, key, fallback, minimum = 0) {
  const value = body[key] ?? fallback;
  if (!Number.isInteger(value) || value < minimum || value > 3650) {
    throw new HttpError(400, `'${key}' debe ser un número de días entre ${minimum} y 3650`);
  }
  return value;
}

async function jsonBody(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Se esperaba un objeto JSON');
  return body;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    // Un solo Durable Object guarda todo: los códigos y las sesiones abiertas.
    return env.HUB.get(env.HUB.idFromName('main')).fetch(request);
  },
};

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.startedAt = Date.now();
    // Los pings se contestan sin despertar al objeto; su hora queda en getWebSocketAutoResponseTimestamp.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec('CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, info TEXT NOT NULL)');
      sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL, name TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER)`);
      sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
      this.codes = Object.fromEntries(sql.exec('SELECT hash, info FROM codes').toArray().map((r) => [r.hash, JSON.parse(r.info)]));
    });
  }

  // ---- códigos ----

  saveCode(hash) {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO codes (hash, info) VALUES (?, ?)', hash, JSON.stringify(this.codes[hash]));
  }

  findCode(prefix) {
    const matches = prefix.length >= 12 ? Object.keys(this.codes).filter((h) => h.startsWith(prefix)) : [];
    if (matches.length !== 1) throw new HttpError(404, 'Código no encontrado');
    return matches[0];
  }

  // ---- sesiones ----

  // Cierra las sesiones de un código (o todas las que cumplan `filter`) avisando el motivo a la app.
  closeSessions(sockets, code, message) {
    for (const ws of sockets) {
      try {
        ws.send(JSON.stringify({ error: message }));
        ws.close(code, message.slice(0, 120));
      } catch {
        // ya estaba cerrada
      }
      this.endSession(ws);
    }
  }

  endSession(ws) {
    const att = ws.deserializeAttachment();
    if (!att || att.ended) return;
    this.ctx.storage.sql.exec('UPDATE sessions SET end = ? WHERE id = ? AND end IS NULL', Math.round(Date.now() / 1000), att.id);
    ws.serializeAttachment({ ...att, ended: true });
  }

  liveSockets() {
    return this.ctx.getWebSockets().filter((ws) => !ws.deserializeAttachment()?.ended);
  }

  lastPing(ws) {
    const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws);
    return Math.max(auto ? auto.getTime() : 0, ws.deserializeAttachment().connected_at);
  }

  // Corta códigos vencidos y conexiones que dejaron de mandar ping (portátil cerrado, red caída).
  sweep() {
    const now = Date.now();
    for (const ws of this.liveSockets()) {
      const att = ws.deserializeAttachment();
      const info = this.codes[att.hash];
      if (!info || !codeStatus(info)[0]) this.closeSessions([ws], 4401, 'Tu código de acceso ha vencido.');
      else if (now - this.lastPing(ws) > SESSION_TIMEOUT_S * 1000) this.closeSessions([ws], 4408, 'Sin ping, sesión cerrada.');
    }
  }

  async alarm() {
    this.sweep();
    if (this.liveSockets().length) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async openSession(request) {
    // Igual que server.py: el código viaja como subprotocolo, new WebSocket(url, ['token', código]).
    const offered = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((p) => p.trim()).filter(Boolean);
    const code = offered[0] === 'token' && offered[1] ? offered[1] : '';
    const headers = offered[0] === 'token' ? { 'Sec-WebSocket-Protocol': 'token' } : {};
    const hash = code ? await hashCode(code) : '';
    const info = hash ? this.codes[hash] : null;
    const [client, server] = Object.values(new WebSocketPair());

    if (!info || !codeStatus(info)[0]) {
      server.accept();
      server.send(JSON.stringify({ error: `Código de acceso ${info ? 'vencido' : 'no autorizado'}.` }));
      server.close(4401, 'codigo no valido');
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    // Una sola conexión por código: gana la más nueva, como en server.py.
    this.closeSessions(this.ctx.getWebSockets(hash).filter((ws) => !ws.deserializeAttachment()?.ended), 4409,
      'Tu código de acceso se conectó desde otro equipo; esta sesión se cerró.');

    const now = Date.now();
    // Tiempo ya usado con este código (sesiones anteriores), para que la app lo muestre y siga sumando.
    const usedS = this.ctx.storage.sql.exec(
      'SELECT COALESCE(SUM(COALESCE(end, ?) - start), 0) AS s FROM sessions WHERE code_hash = ?', Math.round(now / 1000), hash,
    ).one().s;
    const id = this.ctx.storage.sql.exec(
      'INSERT INTO sessions (code_hash, name, start) VALUES (?, ?, ?) RETURNING id', hash, info.name, Math.round(now / 1000),
    ).one().id;
    this.ctx.acceptWebSocket(server, [hash]);
    // El adjunto sobrevive a la hibernación (máx. 2 KB): de ahí sale la fila del panel.
    server.serializeAttachment({
      id,
      hash,
      ip: request.headers.get('CF-Connecting-IP') || '?',
      user_agent: (request.headers.get('User-Agent') || '').slice(0, 300),
      connected_at: now,
    });
    server.send(JSON.stringify({ ok: true, name: info.name, used_s: Math.max(0, usedS) }));
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now + SWEEP_MS);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage() {
    // Los "ping" los contesta la auto-respuesta; cualquier otro mensaje se ignora.
  }

  async webSocketClose(ws, code) {
    this.endSession(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // ya cerrada
    }
  }

  async webSocketError(ws) {
    this.endSession(ws);
  }

  // ---- API de admin (misma forma que server.py) ----

  async requireAdmin(request) {
    const token = (this.env.ADMIN_TOKEN || '').trim(); // `secret put` por pipe puede dejar un salto de línea
    const expected = new TextEncoder().encode(`Bearer ${token}`);
    const given = new TextEncoder().encode((request.headers.get('Authorization') || '').trim());
    const ok = token &&given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
    if (!ok) throw new HttpError(401, 'Token de admin inválido');
  }

  stats() {
    this.sweep();
    const now = Date.now();
    const deepgram = this.liveSockets().map((ws) => {
      const att = ws.deserializeAttachment();
      const info = this.codes[att.hash] || {};
      return {
        id: att.id,
        name: info.name || '?',
        code_hash: att.hash.slice(0, 12),
        expires: info.expires ?? null,
        ip: att.ip,
        user_agent: att.user_agent,
        connected_s: Math.round((now - att.connected_at) / 1000),
        ping_s: Math.round((now - this.lastPing(ws)) / 1000),
      };
    });
    return {
      server: 'control',
      active_users: deepgram.length,
      projected_monthly_cost: 0,
      hourly_rate: 0,
      uptime_s: Math.round((now - this.startedAt) / 1000),
      authorized_codes: Object.keys(this.codes).length,
      codes: Object.entries(this.codes).map(([h, i]) => ({
        code_hash: h.slice(0, 12), hash: h, code: i.code || '', name: i.name, email: i.email || '', note: i.note || '',
        expires: i.expires ?? null, valid: codeStatus(i)[0], status: codeStatus(i)[1],
      })),
      clients: [], // Whisper vive en el servidor GPU
      deepgram_clients: deepgram,
    };
  }

  usage(days) {
    const now = Math.round(Date.now() / 1000);
    const rows = this.ctx.storage.sql.exec('SELECT code_hash, name, start, end FROM sessions').toArray();
    const totals = {};
    const sessions = [];
    const since = now - Math.max(1, Math.min(days, 366)) * 86400;
    for (const r of rows) {
      const end = r.end ?? now;
      const t = (totals[r.code_hash] ??= { sessions: 0, connected_s: 0, audio_s: 0, last_seen: 0 });
      t.sessions += 1;
      t.connected_s += end - r.start;
      t.last_seen = Math.max(t.last_seen, end);
      if (end >= since) {
        sessions.push({ code_hash: r.code_hash.slice(0, 12), name: r.name, start: r.start, end, audio_s: 0, segments: 0, ...(r.end == null ? { live: true } : {}) });
      }
    }
    return { per_code: totals, sessions };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/ws/session') {
        if (request.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, 'Se esperaba un WebSocket');
        return await this.openSession(request);
      }
      if (path === '/') return json({ status: 'ok', server: 'control' });
      if (!path.startsWith('/api/admin/')) throw new HttpError(404, 'No encontrado');
      await this.requireAdmin(request);
      return json(await this.admin(request, path.slice('/api/admin/'.length), url));
    } catch (err) {
      if (err instanceof HttpError) return json({ detail: err.message }, err.status);
      console.error(err);
      return json({ detail: 'Error interno' }, 500);
    }
  }

  async admin(request, route, url) {
    const method = request.method;
    if (route === 'stats' && method === 'GET') return this.stats();
    if (route === 'usage' && method === 'GET') return this.usage(Number(url.searchParams.get('days')) || 30);
    // No hay GPU aquí: métricas vacías para que el panel no falle.
    if (route === 'metrics' && method === 'GET') return { lat_bins: [], gpu_available: false, in_flight: 0, minutes: [] };

    if (route === 'codes' && method === 'GET') return this.codes;

    if (route === 'codes' && method === 'POST') {
      const body = await jsonBody(request);
      const name = String(body.name ?? '').trim();
      if (!name) throw new HttpError(400, 'Falta el nombre');
      const days = intField(body, 'days', 30);
      const code = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const now = new Date();
      const info = { name, email: String(body.email ?? '').trim(), note: String(body.note ?? '').trim(), created: isoNow(now), code };
      if (days > 0) info.expires = isoNow(new Date(now.getTime() + days * 86_400_000));
      const hash = await hashCode(code);
      this.codes[hash] = info;
      this.saveCode(hash);
      return { code, name, status: codeStatus(info)[1] };
    }

    if (route === 'codes' && method === 'PUT') {
      const codes = await request.json().catch(() => null);
      const valid = codes && typeof codes === 'object' && !Array.isArray(codes) &&
        Object.entries(codes).every(([h, i]) => h.length === 64 && i && typeof i === 'object' && i.name);
      if (!valid) throw new HttpError(400, 'Formato de authorized_codes.json inválido');
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM codes');
        this.codes = codes;
        for (const hash of Object.keys(codes)) this.saveCode(hash);
      });
      this.sweep(); // quien ya no tenga código válido se desconecta ahora
      return { codes: Object.keys(codes).length };
    }

    if (route === 'codes/extend-all' && method === 'POST') {
      const days = intField(await jsonBody(request), 'days', undefined, 1);
      // Se suma a la fecha de vencimiento (no a hoy): quien venció durante la caída recupera los días perdidos.
      const cutoff = Date.now() - days * 86_400_000;
      let extended = 0;
      for (const [hash, info] of Object.entries(this.codes)) {
        if (info.expires && Date.parse(info.expires) > cutoff) {
          info.expires = isoNow(new Date(Date.parse(info.expires) + days * 86_400_000));
          this.saveCode(hash);
          extended += 1;
        }
      }
      return { extended };
    }

    const extend = route.match(/^codes\/([0-9a-f]+)\/extend$/);
    if (extend && method === 'POST') {
      const body = await jsonBody(request);
      const days = intField(body, 'days', 30, 1);
      const hash = this.findCode(extend[1]);
      const info = this.codes[hash];
      // Se suma desde la fecha de vencimiento si aún no ha llegado, para no perder días pagados.
      const base = info.expires ? Math.max(Date.now(), Date.parse(info.expires)) : Date.now();
      info.expires = isoNow(new Date(base + days * 86_400_000));
      const note = String(body.note ?? '').trim();
      if (note) info.note = [info.note, note].filter(Boolean).join(' | ');
      this.saveCode(hash);
      return { name: info.name, status: codeStatus(info)[1] };
    }

    const remove = route.match(/^codes\/([0-9a-f]+)$/);
    if (remove && method === 'DELETE') {
      const hash = this.findCode(remove[1]);
      const { name } = this.codes[hash];
      delete this.codes[hash];
      this.ctx.storage.sql.exec('DELETE FROM codes WHERE hash = ?', hash);
      this.closeSessions(this.ctx.getWebSockets(hash), 4401, 'Tu código de acceso fue eliminado.');
      return { name };
    }

    throw new HttpError(404, 'No encontrado');
  }
}
