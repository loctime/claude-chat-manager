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

// entries → mensajes de chat. Solo user_message/agent_message (event_msg) — los
// tool calls (custom_tool_call/custom_tool_call_output en el rollout persistido)
// quedan fuera de v1 a propósito: se ven en vivo durante el turno (vía SSE, ver
// codex-runner.js) pero no se reconstruyen al reabrir una conversación vieja.
function toChatMessages(entries) {
  const items = [];
  for (const e of entries) {
    if (e.type !== 'event_msg' || !e.payload) continue;
    if (e.payload.type === 'user_message' && e.payload.message) {
      items.push({ role: 'user', text: e.payload.message, ts: e.timestamp });
    } else if (e.payload.type === 'agent_message' && e.payload.message) {
      items.push({ role: 'assistant', text: e.payload.message, ts: e.timestamp });
    }
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
  const meta = entries.find(e => e.type === 'session_meta');
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
