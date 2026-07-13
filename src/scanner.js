const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

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

function contentToText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
}

function isChannelSession(entries) {
  for (const e of entries) {
    if (e.type !== 'assistant' || !Array.isArray(e.message && e.message.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'tool_use' && typeof b.name === 'string' && b.name.startsWith('mcp__plugin_')) return true;
    }
  }
  return false;
}

// Cache sessionInfo por mtime: cada JSONL se re-parsea sólo si cambió su mtime en disco.
// Clave = filePath; valor = { mtimeMs, info } donde info puede ser null (para archivos que
// no tienen mensajes útiles — así no re-parseamos jsonl inservibles en cada tick).
const _sessionInfoCache = new Map();

function _computeSessionInfo(filePath) {
  const entries = parseJsonl(filePath);
  if (isChannelSession(entries)) return null;
  const msgs = entries.filter(e => (e.type === 'user' || e.type === 'assistant') && e.message && !e.isMeta);
  if (msgs.length === 0) return null;
  const firstUser = msgs.find(e => e.type === 'user' && contentToText(e.message.content).trim());
  const snippet = firstUser ? contentToText(firstUser.message.content).trim().slice(0, 60) : '(sin mensajes)';
  const last = entries[entries.length - 1];
  let lastActivity = last && last.timestamp;
  if (!lastActivity) { try { lastActivity = fs.statSync(filePath).mtime.toISOString(); } catch { lastActivity = null; } }
  const lastAssistant = [...msgs].reverse().find(e => e.type === 'assistant' && e.message && e.message.model);
  return {
    sessionId: path.basename(filePath, '.jsonl'),
    cwd: (entries.find(e => e.cwd) || {}).cwd || null,
    snippet,
    messageCount: msgs.length,
    lastActivity,
    lastModel: lastAssistant ? lastAssistant.message.model : null,
    usage: sumUsage(entries),
    contextTokens: lastTurnContextTokens(entries),
  };
}

// Tokens del último turno assistant = tamaño de contexto vigente.
// input + cache_read + cache_create es lo que Claude tuvo que "leer" en ese turno,
// que en la práctica equivale al estado del contexto justo antes del próximo mensaje.
function lastTurnContextTokens(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'assistant' || !e.message || !e.message.usage) continue;
    const u = e.message.usage;
    return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  return 0;
}

// Suma usage por modelo. Cada mensaje assistant tiene message.usage con
// { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }.
function sumUsage(entries) {
  const byModel = {};
  const total = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  for (const e of entries) {
    if (e.type !== 'assistant' || !e.message || !e.message.usage) continue;
    const u = e.message.usage;
    const model = e.message.model || 'unknown';
    if (!byModel[model]) byModel[model] = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    byModel[model].input += inp;
    byModel[model].output += out;
    byModel[model].cacheCreate += cw;
    byModel[model].cacheRead += cr;
    total.input += inp;
    total.output += out;
    total.cacheCreate += cw;
    total.cacheRead += cr;
  }
  return { total, byModel };
}

function sessionInfo(filePath) {
  let mtimeMs;
  try { mtimeMs = fs.statSync(filePath).mtimeMs; }
  catch { _sessionInfoCache.delete(filePath); return null; }

  const cached = _sessionInfoCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.info;

  const info = _computeSessionInfo(filePath);
  _sessionInfoCache.set(filePath, { mtimeMs, info });
  return info;
}

// Solo para tests / operaciones excepcionales.
function _clearSessionInfoCache() { _sessionInfoCache.clear(); }

function listSessions(projectsDir = PROJECTS_DIR) {
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch { return []; }
  const sessions = [];
  for (const d of dirs) {
    const dirPath = path.join(projectsDir, d);
    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const info = sessionInfo(path.join(dirPath, f));
      if (info) sessions.push(info);
    }
  }
  return sessions;
}

function findSessionFile(sessionId, projectsDir = PROJECTS_DIR) {
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  for (const d of dirs) {
    const candidate = path.join(projectsDir, d, sessionId + '.jsonl');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Tail incremental del JSONL: mantenemos por filePath el offset (size) leído y las
// entries ya parseadas, así en el /api/conversations/:id/messages siguiente solo
// leemos y parseamos el sufijo nuevo del archivo.
const _tailCache = new Map(); // filePath → { size, mtimeMs, entries }

function _parseChunk(str) {
  const out = [];
  for (const line of str.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* saltear línea corrupta */ }
  }
  return out;
}

function getMessagesIncremental(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); }
  catch { _tailCache.delete(filePath); return []; }

  const cached = _tailCache.get(filePath);

  // Archivo se achicó (fue truncado o reescrito) → invalidar y leer entero
  if (cached && stat.size < cached.size) _tailCache.delete(filePath);

  const current = _tailCache.get(filePath);
  if (current && stat.size === current.size && stat.mtimeMs === current.mtimeMs) {
    // Nada cambió — devolvemos las entries cacheadas transformadas
    return toChatMessages(current.entries);
  }

  // Leer solo desde el offset viejo (o el archivo completo si no hay cache)
  const start = current ? current.size : 0;
  let fd;
  try { fd = fs.openSync(filePath, 'r'); }
  catch { return []; }
  try {
    const len = stat.size - start;
    if (len <= 0) {
      // Solo cambió mtime (raro) — devolver lo que teníamos
      _tailCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, entries: (current && current.entries) || [] });
      return toChatMessages((current && current.entries) || []);
    }
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const chunkStr = buf.toString('utf8');
    const newEntries = _parseChunk(chunkStr);
    const merged = current ? current.entries.concat(newEntries) : newEntries;
    _tailCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, entries: merged });
    return toChatMessages(merged);
  } finally {
    fs.closeSync(fd);
  }
}

function _clearTailCache() { _tailCache.clear(); }

// Búsqueda de texto sobre todos los JSONL. Estrategia: primero grep sobre el raw
// (rápido, evita parsear si no hay match), después parsea y ubica el índice del
// mensaje que contiene el término. Devuelve hasta `limit` matches.
function searchSessions(query, { limit = 50, projectsDir = PROJECTS_DIR } = {}) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch { return []; }
  for (const d of dirs) {
    if (results.length >= limit) break;
    const dirPath = path.join(projectsDir, d);
    let files;
    try { files = fs.readdirSync(dirPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, f);
      let raw;
      try { raw = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      if (!raw.toLowerCase().includes(q)) continue;

      const info = sessionInfo(filePath);
      if (!info) continue; // ej. sesión de canal

      const entries = parseJsonl(filePath);
      const msgs = toChatMessages(entries);
      let firstMatchIdx = -1;
      let snippet = '';
      for (let i = 0; i < msgs.length; i++) {
        const text = (msgs[i].text || '').toLowerCase();
        const pos = text.indexOf(q);
        if (pos >= 0) {
          firstMatchIdx = i;
          const raw = msgs[i].text;
          const start = Math.max(0, pos - 30);
          const end = Math.min(raw.length, pos + q.length + 60);
          snippet = (start > 0 ? '…' : '') + raw.slice(start, end) + (end < raw.length ? '…' : '');
          break;
        }
      }
      if (firstMatchIdx < 0) continue;
      results.push({
        sessionId: info.sessionId,
        cwd: info.cwd,
        name: info.snippet,
        lastActivity: info.lastActivity,
        matchIndex: firstMatchIdx,
        role: msgs[firstMatchIdx].role,
        snippet,
      });
      if (results.length >= limit) break;
    }
  }
  results.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  return results;
}

function toChatMessages(entries) {
  const toolResults = {};
  for (const e of entries) {
    if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type === 'tool_result') toolResults[b.tool_use_id] = contentToText(b.content);
      }
    }
  }
  const items = [];
  for (const e of entries) {
    if (!e.message || e.isMeta) continue;
    if (e.type === 'user') {
      const text = contentToText(e.message.content);
      if (text.trim()) items.push({ role: 'user', text });
    } else if (e.type === 'assistant' && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type === 'text' && b.text.trim()) items.push({ role: 'assistant', text: b.text });
        else if (b.type === 'tool_use') items.push({ role: 'tool', name: b.name, input: b.input, output: toolResults[b.id] || '' });
      }
    }
  }
  return items;
}

module.exports = {
  parseJsonl, sessionInfo, listSessions, findSessionFile, toChatMessages, contentToText,
  getMessagesIncremental, sumUsage, searchSessions, PROJECTS_DIR,
  _clearSessionInfoCache, _clearTailCache,
};
