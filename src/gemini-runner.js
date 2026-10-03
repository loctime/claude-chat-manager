const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const { GEMINI_CMD } = require('./gemini-cmd');
const { infraNotice, pathContract } = require('./prompt-fragments');

const IS_WIN = process.platform === 'win32';

// Antigravity, a diferencia de Claude Code, no descubre CLAUDE.md solo --
// hay que decirle explícitamente que lo vaya a leer. La ruta se arma en
// base al HOME real del proceso (no hardcodeada a la cuenta de Diego): esta
// misma clase la usa cualquier cuenta de sistema que corra una instancia de
// Jarvis (ver claude-chat-manager, slots/instancias por colaborador), y
// cada una tiene su propio CLAUDE.md bajo su propio HOME.
function buildMemoryProtocol(userName) {
  const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  return `CONTEXTO JARVIS COMPARTIDO: sos un asistente que trabaja junto a Claude Code para ${userName}. Antes de cualquier tarea no trivial, leé ${claudeMdPath} (ahí están tus instrucciones y dónde vive tu memoria persistente). Si trabajás dentro de un proyecto, leé también su CLAUDE.local.md si existe. Esa memoria es fuente de verdad: no la reescribas ni la dupliques. Usá español argentino sin signos de apertura y fechas DD/MM/AAAA.`;
}

class GeminiRunner extends EventEmitter {
  constructor({ spawnFn = spawn, command = GEMINI_CMD, selfHost, selfPort, getUserName } = {}) {
    super(); this.spawnFn = spawnFn; this.command = command; this.selfHost = selfHost; this.selfPort = selfPort; this.getUserName = getUserName || (() => 'Vos'); this.running = new Map(); this.activeSessions = new Map(); this.queue = [];
  }
  isBusy(id) { return this.running.has(id) || this.queue.some(job => job.convId === id); }
  getActiveSessionIds() { return new Set([...this.activeSessions.values()].filter(Boolean)); }
  cancel(id) {
    const child = this.running.get(id);
    if (!child) {
      const idx = this.queue.findIndex(job => job.convId === id);
      if (idx < 0) return false;
      this.queue.splice(idx, 1);
      this.emit('status', { convId: id, status: 'idle', code: -1, cancelled: true });
      return true;
    }
    child._cancelled = true;
    if (IS_WIN && child.pid) { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { child.kill('SIGTERM'); } }
    else child.kill('SIGTERM');
    return true;
  }
  send(job) {
    this.queue.push(job);
    this.emit('status', { convId: job.convId, status: 'queued' });
    this._drain();
  }
  _drain() {
    // Antigravity no expone una API de queue en modo headless. Esta cola del
    // runner conserva los mensajes en el servidor y los despacha al cerrar el
    // turno actual, sin matar ni relanzar una sesión competidora.
    while (this.queue.length > 0) {
      const next = this.queue.findIndex(job => !this.running.has(job.convId));
      if (next < 0) return;
      this._start(this.queue.splice(next, 1)[0]);
    }
  }
  _start(job) {
    const safety = this.selfPort ? `\n\n${infraNotice(this.selfHost || '127.0.0.1', this.selfPort)}\n\n${pathContract()}` : '';
    // --print-timeout: default del CLI es 5m si no se pasa. Un pedido de
    // varias features fácil supera eso — se sube a un valor generoso para
    // pedidos reales de trabajo (no aplica a /usage, que tiene el suyo propio
    // en antigravity-usage.js). Encontrado en vivo el 2026-09-14: un pedido
    // grande quedó sin ninguna respuesta ni rastro de error — ver más abajo.
    const memoryProtocol = buildMemoryProtocol(this.getUserName());
    const args = ['--prompt', `${job.text}\n\n${memoryProtocol}${safety}`, '--output-format', 'stream-json', '--dangerously-skip-permissions', '--print-timeout', job.printTimeout || '20m'];
    if (job.model) args.push('--model', job.model);
    // El primer resultado devuelve conversation_id; con --conversation los
    // siguientes procesos continúan exactamente el mismo contexto.
    const sessionId = job.sessionId || job.resolveSessionId?.();
    if (sessionId) args.push('--conversation', sessionId);
    let child;
    try { child = this.spawnFn(this.command, args, { cwd: job.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (err) { this.emit('status', { convId: job.convId, status: 'idle', code: -1, stderr: err.message, incomplete: true }); this._drain(); return; }
    this.running.set(job.convId, child);
    this.activeSessions.set(job.convId, sessionId || null);
    this.emit('status', { convId: job.convId, status: 'running' });
    let buf = '', stderr = '', response = '', conversationId = null, gotResult = false, resultFailed = false, resultError = null, done = false, lastUsage = null;
    // El id puede aparecer antes del evento final. Guardarlo permite continuar
    // una conversación que Antigravity corte por límite de herramientas.
    const findConversationId = value => {
      if (!value || typeof value !== 'object') return null;
      if (typeof value.conversation_id === 'string') return value.conversation_id;
      for (const child of Object.values(value)) {
        const found = findConversationId(child);
        if (found) return found;
      }
      return null;
    };
    const finish = (code, error) => {
      if (done) return;
      done = true;
      this.running.delete(job.convId);
      this.activeSessions.delete(job.convId);
      const wasCancelled = !!child?._cancelled;
      const incomplete = !wasCancelled && (!gotResult || resultFailed);
      const reason = wasCancelled
        ? 'Cancelado por el usuario.'
        : resultFailed
          ? (resultError || 'Antigravity devolvió un error.')
          : incomplete
            ? 'Antigravity terminó sin una respuesta final (probablemente alcanzó el límite de herramientas, el timeout, o se cortó la conexión).'
            : error;
      this.emit('status', { convId: job.convId, status: 'idle', code, stderr: reason, response, conversationId, incomplete, cancelled: wasCancelled, usage: lastUsage });
      this._drain();
    };
    const ingest = line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      const foundId = findConversationId(event);
      if (foundId && !conversationId) {
        conversationId = foundId;
        this.activeSessions.set(job.convId, conversationId);
        this.emit('session', { convId: job.convId, sessionId: conversationId });
      } else if (foundId) {
        conversationId = foundId;
      }
      if (event.event === 'step_update') {
        if (typeof event.step_update?.text_delta === 'string') response += event.step_update.text_delta;
        if (event.step_update?.usage) lastUsage = event.step_update.usage;
      }
      if (event.event === 'result') {
        gotResult = true;
        resultFailed = event.result?.status === 'ERROR';
        resultError = event.result?.error || null;
        if (typeof event.result?.response === 'string') response = event.result.response;
        conversationId = event.result?.conversation_id || conversationId;
        if (event.result?.usage) lastUsage = event.result.usage;
      }
      this.emit('event', { convId: job.convId, event });
    };
    child.stdout.on('data', d => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { ingest(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => finish(-1, e.message));
    child.on('close', code => { if (buf.trim()) ingest(buf); finish(code, code === 0 ? undefined : stderr); });
  }
}
module.exports = { GeminiRunner };
