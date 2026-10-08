/* =========================================================
   Endpoint del asistente · Serna-Rincón Abogados
   POST /api/chat  →  respuesta en streaming (NDJSON)

   · La clave GEMINI_API_KEY solo existe aquí, en el servidor.
   · No se registra el contenido de las conversaciones: los logs
     solo guardan el tipo de error y su código HTTP.
   ========================================================= */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleGenAI, ApiError } from '@google/genai';

/* ---------- Límites ---------- */
const MAX_MESSAGE_CHARS = 1000;      // por mensaje
const MAX_HISTORY = 10;              // turnos (mensajes) que se aceptan por petición
const MAX_USER_TURNS_PER_SESSION = 24;   // el widget corta en 20; el margen cubre reintentos
const MAX_BODY_BYTES = 16 * 1024;
const MAX_OUTPUT_TOKENS = 700;
const TIMEOUT_MS = 20_000;
const RATE_PER_MINUTE = 8;           // por IP
const RATE_PER_HOUR = 60;            // por IP
const DEFAULT_MODEL = 'gemini-3.8-flash';

/* ---------- Mensajes genéricos (nunca se exponen detalles internos) ---------- */
const MSG = {
  invalid: 'No pudimos procesar su mensaje. Verifique el texto e intente de nuevo.',
  tooLong: `Su mensaje supera el límite de ${MAX_MESSAGE_CHARS} caracteres. Por favor, resúmalo.`,
  rate: 'Ha enviado varios mensajes en poco tiempo. Espere un momento e intente de nuevo.',
  session: 'Se alcanzó el límite de mensajes de esta conversación. Para continuar, contáctenos por teléfono, WhatsApp o correo.',
  forbidden: 'Solicitud no permitida.',
  busy: 'El asistente está recibiendo muchas consultas en este momento. Espere un minuto e intente de nuevo, o contáctenos por teléfono, WhatsApp o correo.',
  unavailable: 'El asistente no está disponible en este momento. Intente más tarde o contáctenos por teléfono, WhatsApp o correo.',
};

/* ---------- Instrucción de sistema (archivo editable) ---------- */
let systemPrompt = null;
function getSystemPrompt() {
  if (systemPrompt === null) {
    const raw = readFileSync(join(process.cwd(), 'chatbot', 'system-prompt.md'), 'utf8');
    systemPrompt = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  }
  return systemPrompt;
}

/* ---------- CORS: solo orígenes permitidos ----------
   ALLOWED_ORIGINS = lista separada por comas (p. ej. "https://www.ejemplo.com").
   Si está vacía, solo se permite localhost / 127.0.0.1 en cualquier puerto. */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  // Un HTML abierto con doble clic (file://) envía Origin "null". Solo lo acepta el servidor
  // local (dev-server.mjs activa ALLOW_FILE_ORIGIN); en Vercel queda rechazado.
  if (origin === 'null') return process.env.ALLOW_FILE_ORIGIN === '1';
  const list = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length) return list.includes(origin);
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch { return false; }
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

/* ---------- Rate limiting básico en memoria ----------
   Es por instancia: en serverless cada instancia lleva su propio conteo.
   Suficiente como freno básico; ver README para una versión distribuida. */
const hits = new Map();      // ip -> [timestamps]
const sessions = new Map();  // sessionId -> { count, exp }

function prune(now) {
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > 3_600_000) hits.delete(k);
  if (sessions.size > 5000) for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
}

function rateLimited(ip, now) {
  const list = (hits.get(ip) || []).filter(t => now - t < 3_600_000);
  const lastMinute = list.filter(t => now - t < 60_000).length;
  if (lastMinute >= RATE_PER_MINUTE || list.length >= RATE_PER_HOUR) { hits.set(ip, list); return true; }
  list.push(now);
  hits.set(ip, list);
  return false;
}

function sessionExceeded(id, now) {
  const s = sessions.get(id) || { count: 0, exp: now + 6 * 3_600_000 };
  s.count += 1;
  sessions.set(id, s);
  return s.count > MAX_USER_TURNS_PER_SESSION;
}

function clientIp(request) {
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : 'unknown';
}

/* ---------- Validación del cuerpo ----------
   { sessionId: string, messages: [{ role: "user"|"model", text: string }, ...] } */
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: MSG.invalid };
  const { sessionId, messages } = body;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return { error: MSG.invalid };
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_HISTORY) return { error: MSG.invalid };
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') return { error: MSG.invalid };
    if (m.role !== 'user' && m.role !== 'model') return { error: MSG.invalid };
    if (typeof m.text !== 'string') return { error: MSG.invalid };
    const text = m.text.trim();
    if (!text) return { error: MSG.invalid };
    if (text.length > MAX_MESSAGE_CHARS) return { error: MSG.tooLong, status: 413 };
    clean.push({ role: m.role, parts: [{ text }] });
  }
  while (clean.length && clean[0].role !== 'user') clean.shift();
  if (!clean.length || clean[clean.length - 1].role !== 'user') return { error: MSG.invalid };
  return { sessionId, contents: clean };
}

async function readBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/* ---------- Handlers ---------- */
export function OPTIONS(request) {
  const origin = request.headers.get('origin');
  if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request) {
  const origin = request.headers.get('origin');
  if (!isAllowedOrigin(origin)) return json(403, { error: MSG.forbidden });
  const cors = corsHeaders(origin);

  if (!(request.headers.get('content-type') || '').includes('application/json')) {
    return json(415, { error: MSG.invalid }, cors);
  }

  const now = Date.now();
  prune(now);
  if (rateLimited(clientIp(request), now)) return json(429, { error: MSG.rate }, { ...cors, 'Retry-After': '60' });

  const body = await readBody(request);
  if (body === null) return json(400, { error: MSG.invalid }, cors);
  const v = validate(body);
  if (v.error) return json(v.status || 400, { error: v.error }, cors);
  if (sessionExceeded(v.sessionId, now)) return json(429, { error: MSG.session, code: 'session_limit' }, cors);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('[chat] GEMINI_API_KEY no configurada'); return json(503, { error: MSG.unavailable }, cors); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let stream;
  try {
    const ai = new GoogleGenAI({ apiKey });
    stream = await ai.models.generateContentStream({
      model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      contents: v.contents,
      config: {
        systemInstruction: getSystemPrompt(),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.3,
        thinkingConfig: { thinkingLevel: 'LOW' },
        abortSignal: controller.signal,
        httpOptions: { timeout: TIMEOUT_MS },
      },
    });
  } catch (err) {
    clearTimeout(timer);
    logError(err);
    return json(isQuota(err) ? 503 : 502, { error: isQuota(err) ? MSG.busy : MSG.unavailable }, cors);
  }

  /* Formato NDJSON: {"t":"texto"} … {"done":true}  ó  {"error":"mensaje"} */
  const enc = new TextEncoder();
  const out = new ReadableStream({
    async start(ctrl) {
      const send = obj => ctrl.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
      let sent = false;
      try {
        for await (const chunk of stream) {
          const t = chunk.text;
          if (t) { send({ t }); sent = true; }
        }
        if (!sent) send({ error: MSG.unavailable });
        else send({ done: true });
      } catch (err) {
        logError(err);
        send({ error: isQuota(err) ? MSG.busy : MSG.unavailable });
      } finally {
        clearTimeout(timer);
        ctrl.close();
      }
    },
    cancel() { clearTimeout(timer); controller.abort(); },
  });

  return new Response(out, {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

/* 429 de Gemini: se agotó la cuota por minuto del proyecto de Google. */
function isQuota(err) { return err instanceof ApiError && err.status === 429; }

/* Solo se registra el tipo de fallo y el código HTTP; nunca el contenido. */
function logError(err) {
  if (err instanceof ApiError) console.error(`[chat] error de la API de Gemini · status ${err.status}`);
  else if (err && err.name === 'AbortError') console.error('[chat] tiempo de espera agotado');
  else console.error(`[chat] error inesperado · ${err && err.name ? err.name : 'desconocido'}`);
}
