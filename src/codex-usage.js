const { spawn } = require('child_process');
const { CODEX_CMD } = require('./codex-cmd');

const CACHE_MS = 10 * 60 * 1000;

function windowLabel(minutes) {
  if (minutes === 300) return '5h';
  if (minutes === 10_080) return 'Semana';
  if (!minutes) return 'Límite';
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${minutes} min`;
}

function toUsageWindow(window) {
  if (!window || window.usedPercent == null) return null;
  return {
    label: windowLabel(window.windowDurationMins),
    pct: window.usedPercent,
    resetsAt: window.resetsAt ? window.resetsAt * 1000 : null,
  };
}

// Consulta el App Server local de Codex, la misma interfaz que usa la TUI
// oficial para pintar sus límites. No toca la API pública ni expone tokens.
class CodexUsageService {
  constructor({ command = CODEX_CMD, spawnFn = spawn, cacheMs = CACHE_MS } = {}) {
    this.command = command;
    this.spawnFn = spawnFn;
    this.cacheMs = cacheMs;
    this.cache = null;
    this.pending = null;
  }

  async get() {
    if (this.cache && Date.now() - this.cache.fetchedAt < this.cacheMs) return this.cache;
    if (!this.pending) {
      this.pending = this._fetch().finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  _fetch() {
    return new Promise((resolve, reject) => {
      const isNodeScript = /\.[cm]?js$/i.test(this.command);
      const child = this.spawnFn(isNodeScript ? process.execPath : this.command,
        isNodeScript ? [this.command, 'app-server', '--stdio'] : ['app-server', '--stdio'],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let initialized = false;
      let settled = false;
      const finish = (err, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (child.kill) child.kill();
        if (err) reject(err); else resolve(data);
      };
      const send = message => child.stdin.write(JSON.stringify(message) + '\n');
      const timeout = setTimeout(() => finish(new Error('Codex tardó demasiado en informar el uso')), 12_000);

      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        let newline;
        while ((newline = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1 && message.result && !initialized) {
            initialized = true;
            send({ jsonrpc: '2.0', method: 'initialized', params: {} });
            send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
          } else if (message.id === 2 && message.result) {
            const limits = message.result.rateLimits || {};
            const data = {
              provider: 'codex',
              plan: limits.planType || '',
              primary: toUsageWindow(limits.primary),
              secondary: toUsageWindow(limits.secondary),
              fetchedAt: Date.now(),
            };
            this.cache = data;
            finish(null, data);
          } else if (message.id === 2 && message.error) {
            finish(new Error(message.error.message || 'Codex no pudo informar el uso'));
          }
        }
      });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', err => finish(err));
      child.on('close', code => {
        if (!settled) finish(new Error(stderr.trim() || `Codex terminó antes de responder (código ${code})`));
      });
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: 1,
        clientInfo: { name: 'claude-chat-manager', version: '1.0' },
      } });
    });
  }
}

module.exports = { CodexUsageService, windowLabel, toUsageWindow };
