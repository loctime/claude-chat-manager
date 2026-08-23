const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { CODEX_CMD } = require('./codex-cmd');
const { infraNotice, pathContract } = require('./prompt-fragments');

const IS_WIN = process.platform === 'win32';

class CodexRunner extends EventEmitter {
  // Codex no tiene cupo interno: cada conversación puede ejecutar su turno
  // en paralelo. El servidor sigue bloqueando un segundo turno de la misma
  // conversación para no cruzar su sessionId.
  constructor({ maxConcurrent = Infinity, spawnFn = spawn, command = CODEX_CMD, selfHost, selfPort } = {}) {
    super();
    this.max = maxConcurrent;
    this.spawnFn = spawnFn;
    this.command = command;
    this.selfHost = selfHost;
    this.selfPort = selfPort;
    this.queue = [];
    this.running = new Map(); // convId → child
  }

  send(job) {
    this.queue.push(job);
    this.emit('status', { convId: job.convId, status: 'queued' });
    this._drain();
  }

  isBusy(convId) {
    return this.running.has(convId) || this.queue.some(j => j.convId === convId);
  }

  cancel(convId) {
    const child = this.running.get(convId);
    if (child) {
      if (IS_WIN && child.pid) {
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
        catch { child.kill('SIGTERM'); }
      } else {
        child.kill('SIGTERM');
      }
      return true;
    }
    const idx = this.queue.findIndex(j => j.convId === convId);
    if (idx >= 0) {
      const [job] = this.queue.splice(idx, 1);
      this.emit('status', { convId: job.convId, status: 'idle', code: -1, cancelled: true });
      return true;
    }
    return false;
  }

  _drain() {
    while (this.running.size < this.max && this.queue.length > 0) {
      this._start(this.queue.shift());
    }
  }

  _start(job) {
    const promptParts = [job.text];
    if (this.selfPort) {
      const host = this.selfHost || '127.0.0.1';
      promptParts.push(infraNotice(host, this.selfPort));
      promptParts.push(pathContract());
    }
    const prompt = promptParts.join('\n\n');

    const sub = ['exec'];
    if (job.sessionId) sub.push('resume', job.sessionId);
    const args = [...sub, '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
    // `codex exec` accepts -C, but `codex exec resume <session>` does not.
    // spawn() already uses job.cwd, so resumed turns keep the same directory
    // without passing an unsupported CLI flag.
    if (job.cwd && !job.sessionId) args.push('-C', job.cwd);
    if (job.imagePath) args.push('-i', job.imagePath);
    args.push(prompt);

    // El paquete @openai/codex no vendorea un .exe (ver codex-cmd.js) — siempre
    // se invoca vía node.exe con el script como primer argumento, igual que el
    // caso isNodeScript de runner.js para un CLAUDE_CMD apuntando a un .js.
    const isNodeScript = /\.[cm]?js$/i.test(this.command);
    const spawnCmd = isNodeScript ? process.execPath : this.command;
    const spawnArgs = isNodeScript ? [this.command, ...args] : args;

    const child = this.spawnFn(spawnCmd, spawnArgs, { cwd: job.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.running.set(job.convId, child);
    this.emit('status', { convId: job.convId, status: 'running' });

    let buf = '';
    let stderr = '';
    let done = false;

    child.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        this.emit('event', { convId: job.convId, event: ev });
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      if (done) return;
      done = true;
      this.running.delete(job.convId);
      this.emit('status', { convId: job.convId, status: 'idle', code: -1, stderr: err.message });
      this._drain();
    });
    child.on('close', code => {
      if (done) return;
      done = true;
      this.running.delete(job.convId);
      if (buf.trim()) {
        let ev;
        try { ev = JSON.parse(buf); } catch {}
        if (ev) this.emit('event', { convId: job.convId, event: ev });
      }
      const status = { convId: job.convId, status: 'idle', code };
      if (code !== 0) status.stderr = stderr;
      this.emit('status', status);
      this._drain();
    });
  }
}

module.exports = { CodexRunner };
