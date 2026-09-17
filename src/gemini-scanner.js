// src/gemini-scanner.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fileURLToPath } = require('url');

const BASE_DIR = process.env.GEMINI_CLI_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli');
const BRAIN_DIR = path.join(BASE_DIR, 'brain');
const SUMMARIES_DB_PATH = path.join(BASE_DIR, 'conversation_summaries.db');

function parseJsonl(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* saltear línea corrupta */ }
  }
  return entries;
}

function cleanUserText(text) {
  if (!text || typeof text !== 'string') return '';
  let t = text;
  const m = t.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (m) t = m[1];
  for (const marker of [
    'CONTEXTO JARVIS COMPARTIDO:',
    'AVISO INFRAESTRUCTURA:',
    'CONTRATO DE RUTAS EN ESTE CHAT:',
  ]) {
    const idx = t.indexOf(marker);
    if (idx !== -1) t = t.slice(0, idx);
  }
  return t.trim();
}

function normalizeArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const res = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      try { res[k] = JSON.parse(v); } catch { res[k] = v; }
    } else {
      res[k] = v;
    }
  }
  return res;
}

function toChatMessages(entries) {
  const messages = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'USER_INPUT') {
      const text = cleanUserText(e.content);
      if (text) messages.push({ role: 'user', text, ts: e.created_at });
    } else if (e.type === 'PLANNER_RESPONSE') {
      if (e.tool_calls && Array.isArray(e.tool_calls) && e.tool_calls.length) {
        for (const tc of e.tool_calls) {
          const next = entries[i + 1];
          let output = '';
          if (next && next.type === 'GENERIC') {
            output = next.content || '';
          }
          const input = normalizeArgs(tc.args || {});
          messages.push({
            role: 'tool',
            name: tc.name || tc.function?.name || 'herramienta',
            input,
            output,
            ts: e.created_at,
          });
        }
      }
      if (e.content && typeof e.content === 'string' && e.content.trim()) {
        messages.push({ role: 'assistant', text: e.content, ts: e.created_at });
      }
    }
  }
  return messages;
}

function findSessionTranscript(sessionId, baseDir = BASE_DIR) {
  if (!sessionId) return null;
  const brainDir = path.join(baseDir, 'brain', sessionId, '.system_generated', 'logs');
  const fullPath = path.join(brainDir, 'transcript_full.jsonl');
  if (fs.existsSync(fullPath)) return fullPath;
  const compactPath = path.join(brainDir, 'transcript.jsonl');
  if (fs.existsSync(compactPath)) return compactPath;
  return null;
}

function getMessages(sessionId, baseDir = BASE_DIR) {
  const file = findSessionTranscript(sessionId, baseDir);
  if (!file) return [];
  return toChatMessages(parseJsonl(file));
}

function findSessionWorkspace(sessionId, baseDir = BASE_DIR) {
  if (!sessionId) return null;
  const dbPath = path.join(baseDir, 'conversation_summaries.db');
  if (fs.existsSync(dbPath)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare('SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?').get(sessionId);
      if (row && row.workspace_uris) {
        let uris = [];
        try { uris = JSON.parse(row.workspace_uris); } catch {}
        if (Array.isArray(uris) && uris.length > 0 && uris[0]) {
          try {
            return fileURLToPath(uris[0]);
          } catch {
            return uris[0].replace(/^file:\/\/\/?/, '');
          }
        }
      }
    } catch { /* SQLite opcional */ }
  }

  // Fallback: revisar transcript para ubicar el Cwd de un comando ejecutado
  const file = findSessionTranscript(sessionId, baseDir);
  if (file) {
    const entries = parseJsonl(file);
    for (const e of entries) {
      if (e.tool_calls && Array.isArray(e.tool_calls)) {
        for (const tc of e.tool_calls) {
          const args = normalizeArgs(tc.args);
          if (args.Cwd && typeof args.Cwd === 'string') return args.Cwd;
          if (args.SearchDirectory && typeof args.SearchDirectory === 'string') return args.SearchDirectory;
        }
      }
    }
  }
  return null;
}

const _infoCache = new Map();

function sessionInfo(sessionId, baseDir = BASE_DIR) {
  const file = findSessionTranscript(sessionId, baseDir);
  if (!file) return null;
  let mtimeMs;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { _infoCache.delete(sessionId); return null; }
  const cached = _infoCache.get(sessionId);
  if (cached && cached.mtimeMs === mtimeMs) return cached.info;

  const msgs = getMessages(sessionId, baseDir);
  const firstUser = msgs.find(m => m.role === 'user');
  const last = msgs[msgs.length - 1];
  let approxTokens = 0;
  if (msgs.length > 0) {
    let totalChars = 0;
    for (const m of msgs) {
      totalChars += (m.text || '').length;
      if (m.input) totalChars += typeof m.input === 'string' ? m.input.length : JSON.stringify(m.input).length;
      if (m.output) totalChars += typeof m.output === 'string' ? m.output.length : String(m.output).length;
    }
    approxTokens = 12000 + Math.round(totalChars / 4);
  }
  const info = {
    sessionId,
    snippet: firstUser ? firstUser.text.slice(0, 60) : '',
    messageCount: msgs.length,
    lastActivity: (last && last.ts) || new Date(mtimeMs).toISOString(),
    workspace: findSessionWorkspace(sessionId, baseDir),
    contextTokens: approxTokens,
  };
  _infoCache.set(sessionId, { mtimeMs, info });
  return info;
}

function listSessions(baseDir = BASE_DIR) {
  const sessions = [];
  const brainDir = path.join(baseDir, 'brain');
  let dirs = [];
  try { dirs = fs.readdirSync(brainDir); } catch { return sessions; }
  for (const d of dirs) {
    const info = sessionInfo(d, baseDir);
    if (info) sessions.push(info);
  }
  return sessions;
}

function _clearSessionInfoCache() {
  _infoCache.clear();
}

module.exports = {
  BASE_DIR,
  BRAIN_DIR,
  SUMMARIES_DB_PATH,
  parseJsonl,
  cleanUserText,
  normalizeArgs,
  toChatMessages,
  findSessionTranscript,
  getMessages,
  findSessionWorkspace,
  sessionInfo,
  listSessions,
  _clearSessionInfoCache,
};
