// src/codex-scanner.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

function parseJsonl(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* línea corrupta: se saltea */ }
  }
  return entries;
}

// Recorre ~/.codex/sessions/AAAA/MM/DD/*.jsonl (3 niveles fijos, no arbitrariamente
// recursivo — así es como Codex CLI los organiza).
function walkRolloutFiles(sessionsDir) {
  const out = [];
  let years;
  try { years = fs.readdirSync(sessionsDir); } catch { return out; }
  for (const y of years) {
    const yDir = path.join(sessionsDir, y);
    let months; try { months = fs.readdirSync(yDir); } catch { continue; }
    for (const m of months) {
      const mDir = path.join(yDir, m);
      let days; try { days = fs.readdirSync(mDir); } catch { continue; }
      for (const d of days) {
        const dDir = path.join(mDir, d);
        let files; try { files = fs.readdirSync(dDir); } catch { continue; }
        for (const f of files) {
          if (f.endsWith('.jsonl')) out.push(path.join(dDir, f));
        }
      }
    }
  }
  return out;
}

// Marcador exacto que codex-runner.js le agrega a CADA mensaje real del
// usuario antes de mandarlo a `codex exec` (ver infraNotice() en
// prompt-fragments.js: "AVISO INFRAESTRUCTURA: ..."). Se corta al reconstruir
// el historial para que coincida con lo que el usuario tipeó de verdad — la
// burbuja optimista que ya se ve en vivo (addMsg en app.js) nunca incluye el
// aviso, así que sin este corte el mismo mensaje se vería distinto en vivo
// que al reabrir la conversación.
const INFRA_NOTICE_MARKER = '\n\nAVISO INFRAESTRUCTURA:';

// El primer turno de cada sesión de Codex CLI inyecta su propio mensaje con
// role:"user" (plugins recomendados / AGENTS.md / contexto de entorno) que no
// es nada que el usuario haya tipeado — verificado en vivo (rollout real):
// aparece como response_item/message/role:user aparte, antes del primer
// mensaje real. Se identifica por estos marcadores fijos del propio texto
// inyectado (siempre trae al menos uno) y se descarta.
const CLI_CONTEXT_MARKERS = ['<recommended_plugins>', '<environment_context>', '# AGENTS.md instructions'];

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && typeof c.text === 'string').map(c => c.text).join('\n\n');
}

// entries → mensajes de chat. El rollout persistido de Codex CLI (verificado
// en vivo, cli_version 0.149.0) NO usa event_msg/user_message como en Claude
// Code — los turnos de texto son response_item con payload.type "message",
// payload.role "user"/"assistant"/"developer" y payload.content como array de
// bloques {type, text}. Solo se toman user/assistant (developer es el prompt
// de sistema completo, no se muestra). Tool calls (custom_tool_call/
// custom_tool_call_output) quedan fuera de v1 a propósito: se ven en vivo
// durante el turno (vía SSE, ver codex-runner.js) pero no se reconstruyen al
// reabrir una conversación vieja.
function toChatMessages(entries) {
  const items = [];
  for (const e of entries) {
    if (e.type !== 'response_item' || !e.payload || e.payload.type !== 'message') continue;
    const { role, content } = e.payload;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = extractText(content);
    if (!text) continue;
    if (role === 'user') {
      if (CLI_CONTEXT_MARKERS.some(m => text.includes(m))) continue;
      const idx = text.indexOf(INFRA_NOTICE_MARKER);
      if (idx !== -1) text = text.slice(0, idx);
      if (!text) continue;
    }
    items.push({ role, text, ts: e.timestamp });
  }
  return items;
}

function getMessages(filePath) {
  return toChatMessages(parseJsonl(filePath));
}

// Cache por mtime, mismo patrón que _sessionInfoCache en scanner.js.
const _infoCache = new Map();

function _computeSessionInfo(filePath) {
  const entries = parseJsonl(filePath);
  const meta = entries.find(e => e.type === 'session_meta' && e.payload);
  const msgs = toChatMessages(entries);
  if (!meta && msgs.length === 0) return null;
  const firstUser = msgs.find(m => m.role === 'user');
  const snippet = firstUser ? firstUser.text.trim().slice(0, 60) : '(sin mensajes)';
  const last = entries[entries.length - 1];
  let lastActivity = last && last.timestamp;
  if (!lastActivity) { try { lastActivity = fs.statSync(filePath).mtime.toISOString(); } catch { lastActivity = null; } }
  return {
    sessionId: meta ? (meta.payload.session_id || meta.payload.id) : path.basename(filePath, '.jsonl').split('-').slice(-5).join('-'),
    cwd: meta ? meta.payload.cwd : null,
    snippet,
    messageCount: msgs.length,
    lastActivity,
  };
}

function sessionInfo(filePath) {
  let mtimeMs;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; }
  catch { _infoCache.delete(filePath); return null; }
  const cached = _infoCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.info;
  const info = _computeSessionInfo(filePath);
  _infoCache.set(filePath, { mtimeMs, info });
  return info;
}

function listSessions(sessionsDir = SESSIONS_DIR) {
  const sessions = [];
  for (const f of walkRolloutFiles(sessionsDir)) {
    const info = sessionInfo(f);
    if (info && info.sessionId) sessions.push(info);
  }
  return sessions;
}

// El nombre de archivo siempre termina en "-<sessionId>.jsonl" (verificado en
// vivo: rollout-2026-08-22T21-48-07-01a02c16-d110-78b2-bb8d-9848fd815cde.jsonl).
// Matchear por sufijo de nombre es mucho más barato que parsear cada archivo
// para leer su session_meta, y alcanza para encontrar el archivo a abrir.
function findSessionFile(sessionId, sessionsDir = SESSIONS_DIR) {
  const suffix = `-${sessionId}.jsonl`;
  for (const f of walkRolloutFiles(sessionsDir)) {
    if (f.endsWith(suffix)) return f;
  }
  return null;
}

function _clearSessionInfoCache() { _infoCache.clear(); }

module.exports = { listSessions, findSessionFile, getMessages, toChatMessages, SESSIONS_DIR, _clearSessionInfoCache };
