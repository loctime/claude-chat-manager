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

function sessionInfo(filePath) {
  const entries = parseJsonl(filePath);
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
  };
}

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

module.exports = { parseJsonl, sessionInfo, listSessions, findSessionFile, toChatMessages, contentToText, PROJECTS_DIR };
