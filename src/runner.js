const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const os = require('os');
const { CLAUDE_CMD } = require('./claude-cmd');

const CURRENT_USER = os.userInfo().username;
const IS_WIN = process.platform === 'win32';

class Runner extends EventEmitter {
  constructor({ maxConcurrent = 2, spawnFn = spawn, command = CLAUDE_CMD, selfHost, selfPort } = {}) {
    super();
    this.max = maxConcurrent;
    this.spawnFn = spawnFn;
    this.command = command;
    this.selfHost = selfHost;
    this.selfPort = selfPort;
    this.queue = [];
    this.running = new Map(); // convId → child
    this._accounts = new Map(); // convId → account
  }

  send(job) {
    this.queue.push(job);
    if (job.account) this._accounts.set(job.convId, job.account);
    this.emit('status', { convId: job.convId, status: 'queued', account: job.account });
    this._drain();
  }

  accountFor(convId) { return this._accounts.get(convId); }

  isBusy(convId) {
    return this.running.has(convId) || this.queue.some(j => j.convId === convId);
  }

  cancel(convId) {
    const child = this.running.get(convId);
    if (child) {
      if (IS_WIN && child.pid) {
        // En Windows kill() no baja los subprocesos del CLI; taskkill /T mata el árbol
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
    const args = ['-p', job.text, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    const promptFragments = [];
    if (this.selfPort) {
      const host = this.selfHost || '127.0.0.1';
      promptFragments.push(
        `AVISO INFRAESTRUCTURA: te está ejecutando claude-chat-manager (Node/Express) en ${host}:${this.selfPort}. Ese proceso es tu propio transporte hacia el usuario — si lo matás perdés el stream a la mitad y el usuario ve tu respuesta cortada. NO ejecutes comandos que apunten a ese puerto ni a ese proceso: nada de kill/pkill/fuser/lsof -ti:${this.selfPort} -k, ss ... | xargs kill, systemctl stop, etc. Si el usuario te pide reiniciar el chat-manager, explicale que lo tiene que hacer él desde otra terminal (o via PM2/systemd) porque vos no podés matar tu propio host.`
      );
      // Regla mecánica, no de estilo — las de estilo puro ("sé breve") se
      // pierden sepultadas en el system prompt; una regla de sintaxis
      // concreta como esta sí se respeta (verificado con el mismo mecanismo,
      // ver CLAUDE.local.md). Va acá y no en el CLAUDE.md personal de cada
      // usuario porque tiene que valerle a CUALQUIER agente que corra
      // adentro de Jarvis (esta PC, la PC Linux, la cuenta de quien sea).
      promptFragments.push(
        `CONTRATO DE RUTAS EN ESTE CHAT: cuando compartas un archivo o carpeta por su ruta, para que aparezca como tarjeta clickeable (descargar / abrir en la PC / bajar zip de una carpeta) escribí la ruta ABSOLUTA en texto plano dentro del mensaje — NUNCA entre backticks ni dentro de un bloque de código \`\`\`, ahí no se detecta. Ejemplos correctos: C:\\Users\\User\\Desktop\\informe.pdf (Windows) o /home/user/carpeta (Linux) — nunca una ruta relativa. Las carpetas con espacios en el nombre no se detectan solas (limitación conocida del detector) — si el nombre tiene espacios, decilo en prosa en vez de mandar la ruta pelada.`
      );
    }
    if (promptFragments.length > 0) {
      args.push('--append-system-prompt', promptFragments.join('\n\n'));
    }
    if (job.sessionId) args.push('--resume', job.sessionId);
    if (job.model) args.push('--model', job.model);
    const account = job.account || CURRENT_USER;
    // Multi-cuenta via sudo solo existe en Linux/Mac; en Windows siempre corre el usuario actual
    const usesudo = !IS_WIN && account !== CURRENT_USER;
    const spawnCmd = usesudo ? 'sudo' : this.command;
    const spawnArgs = usesudo ? ['-u', account, this.command, ...args] : args;
    const homeDir = usesudo ? `/home/${account}` : os.homedir();
    // windowsHide: Jarvis corre sin consola (lanzado por el .vbs de autostart,
    // sin ventana) — sin esta opción, Windows le abre una consola nueva a
    // cada claude.exe que se spawnea igual, porque el padre no tiene una
    // propia que heredar. No hace nada en Linux/Mac.
    const child = this.spawnFn(spawnCmd, spawnArgs, { cwd: job.cwd, env: { ...process.env, HOME: homeDir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.running.set(job.convId, child);
    this.emit('status', { convId: job.convId, status: 'running', account });

    let buf = '';
    let stderr = '';
    let done = false; // guard para no emitir idle dos veces

    child.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        this.emit('event', { convId: job.convId, event: ev, account });
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      if (done) return;
      done = true;
      this.running.delete(job.convId);
      const status = { convId: job.convId, status: 'idle', code: -1, stderr: err.message, account };
      this.emit('status', status);
      this._drain();
    });
    child.on('close', code => {
      if (done) return;
      done = true;
      this.running.delete(job.convId);
      // flushea buf antes de cerrar
      if (buf.trim()) {
        let ev;
        try { ev = JSON.parse(buf); } catch { }
        if (ev) this.emit('event', { convId: job.convId, event: ev, account });
      }
      const status = { convId: job.convId, status: 'idle', code, account };
      if (code !== 0) status.stderr = stderr;
      this.emit('status', status);
      this._drain();
    });
  }
}

module.exports = { Runner };
