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

    // `codex exec --json` escribe este evento cuando el agente ya terminó su
    // turno. En Windows el proceso puede quedar vivo unos segundos más (o
    // colgado) después de haberlo emitido. Si esperamos únicamente el `close`,
    // Jarvis queda mostrando "procesando" aunque la respuesta ya esté en
    // pantalla. Este es el fin lógico del turno; `close` queda como respaldo
    // para errores y para CLIs que no hayan llegado a completar el turno.
    const finish = ({ code, terminal = false, error } = {}) => {
      if (done) return;
      done = true;
      this.running.delete(job.convId);
      const status = { convId: job.convId, status: 'idle', code };
      if (error) status.stderr = error;
      this.emit('status', status);
      this._drain();

      // El evento final garantiza que ya no hay más contenido útil por leer.
      // Cerramos el árbol del CLI para que un proceso rezagado no siga
      // reteniendo recursos ni compita con el próximo `resume` de la sesión.
      if (terminal && !child.killed) {
        if (IS_WIN && child.pid) {
          try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
          catch { child.kill('SIGTERM'); }
        } else {
          child.kill('SIGTERM');
        }
      }
    };

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
        if (ev.type === 'turn.completed') finish({ code: 0, terminal: true });
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      finish({ code: -1, error: err.message });
    });
    child.on('close', code => {
      if (done) return;
      if (buf.trim()) {
        let ev;
        try { ev = JSON.parse(buf); } catch {}
        if (ev) {
          this.emit('event', { convId: job.convId, event: ev });
          if (ev.type === 'turn.completed') return finish({ code: 0 });
        }
      }
      finish({ code, error: code !== 0 ? stderr : undefined });
    });
  }
}

module.exports = { CodexRunner };
