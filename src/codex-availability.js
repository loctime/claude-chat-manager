const { spawn } = require('child_process');
const { CODEX_CMD } = require('./codex-cmd');

// No alcanza con encontrar el binario: una instalación nueva puede tener el
// CLI pero no una cuenta iniciada. `codex login status` cubre ambas cosas sin
// iniciar un turno ni consumir uso de Codex.
class CodexAvailability {
  constructor({ command = CODEX_CMD, spawnFn = spawn, cacheMs = 60_000 } = {}) {
    this.command = command;
    this.spawnFn = spawnFn;
    this.cacheMs = cacheMs;
    this.cache = null;
    this.pending = null;
  }

  async get() {
    if (this.cache && Date.now() - this.cache.checkedAt < this.cacheMs) return this.cache;
    if (!this.pending) this.pending = this._check().finally(() => { this.pending = null; });
    return this.pending;
  }

  _check() {
    return new Promise(resolve => {
      const isNodeScript = /\.[cm]?js$/i.test(this.command);
      let child;
      try {
        child = this.spawnFn(
          isNodeScript ? process.execPath : this.command,
          isNodeScript ? [this.command, 'login', 'status'] : ['login', 'status'],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        );
      } catch {
        resolve({ available: false, checkedAt: Date.now() });
        return;
      }

      let settled = false;
      const finish = available => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const data = { available, checkedAt: Date.now() };
        this.cache = data;
        resolve(data);
      };
      // Si el binario está roto o quedó bloqueado, no frenar la carga de toda
      // la PWA: simplemente no se ofrece la pestaña en esta instalación.
      const timeout = setTimeout(() => {
        if (child.kill) child.kill();
        finish(false);
      }, 4_000);
      child.on('error', () => finish(false));
      child.on('close', code => finish(code === 0));
    });
  }
}

module.exports = { CodexAvailability };
