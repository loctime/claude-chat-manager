const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { GEMINI_CMD } = require('./gemini-cmd');
const { infraNotice, pathContract } = require('./prompt-fragments');

const IS_WIN = process.platform === 'win32';
const MEMORY_PROTOCOL = 'CONTEXTO JARVIS COMPARTIDO: sos un asistente que trabaja en la PC de Diego Bertosi junto a Claude Code. Antes de cualquier tarea no trivial, leé C:\\Users\\User\\.claude\\CLAUDE.md y C:\\Users\\User\\.claude\\projects\\C--Users-User\\memory\\MEMORY.md. Si trabajás dentro de un proyecto, leé también su CLAUDE.local.md. Esa memoria es fuente de verdad: no la reescribas ni la dupliques. Usá español argentino sin signos de apertura y fechas DD/MM/AAAA.';

class GeminiRunner extends EventEmitter {
  constructor({ spawnFn = spawn, command = GEMINI_CMD, selfHost, selfPort } = {}) {
    super(); this.spawnFn = spawnFn; this.command = command; this.selfHost = selfHost; this.selfPort = selfPort; this.running = new Map();
  }
  isBusy(id) { return this.running.has(id); }
  cancel(id) {
    const child = this.running.get(id); if (!child) return false;
    if (IS_WIN && child.pid) { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { child.kill('SIGTERM'); } }
    else child.kill('SIGTERM');
    return true;
  }
  send(job) {
    const safety = this.selfPort ? `\n\n${infraNotice(this.selfHost || '127.0.0.1', this.selfPort)}\n\n${pathContract()}` : '';
    // --print-timeout: default del CLI es 5m si no se pasa. Un pedido de
    // varias features fácil supera eso — se sube a un valor generoso para
    // pedidos reales de trabajo (no aplica a /usage, que tiene el suyo propio
    // en antigravity-usage.js). Encontrado en vivo el 2026-09-14: un pedido
    // grande quedó sin ninguna respuesta ni rastro de error — ver más abajo.
    const args = ['--prompt', `${job.text}\n\n${MEMORY_PROTOCOL}${safety}`, '--output-format', 'stream-json', '--dangerously-skip-permissions', '--print-timeout', job.printTimeout || '20m'];
    if (job.model) args.push('--model', job.model);
    // El primer resultado devuelve conversation_id; con --conversation los
    // siguientes procesos continúan exactamente el mismo contexto.
    if (job.sessionId) args.push('--conversation', job.sessionId);
    let child;
    try { child = this.spawnFn(this.command, args, { cwd: job.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (err) { this.emit('status', { convId: job.convId, status: 'idle', code: -1, stderr: err.message, incomplete: true }); return; }
    this.running.set(job.convId, child); this.emit('status', { convId: job.convId, status: 'running' });
    let buf = '', stderr = '', response = '', conversationId = null, gotResult = false, resultFailed = false, resultError = null, done = false;
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
      // "Completo" exige DOS cosas: que haya llegado el evento 'result' (si no,
      // el CLI cortó solo — timeout, límite de herramientas, o crasheó antes de
      // mandarlo) Y que ese result no haya venido con status:"ERROR" — visto en
      // vivo el 2026-09-14 (resume de una sesión larga): Antigravity puede
      // devolver "The stream was interrupted" con status:ERROR pero igual
      // arrastrar texto parcial en response, y antes ese caso se trataba como
      // éxito silencioso. Cualquiera de los dos motivos = incomplete, para que
      // el turno SIEMPRE deje un rastro visible en vez de desaparecer sin
      // explicación (que fue exactamente el bug reportado ese día).
      const incomplete = !gotResult || resultFailed;
      const reason = resultFailed
        ? (resultError || 'Antigravity devolvió un error.')
        : incomplete
          ? 'Antigravity terminó sin una respuesta final (probablemente alcanzó el límite de herramientas, el timeout, o se cortó la conexión).'
          : error;
      this.emit('status', { convId: job.convId, status: 'idle', code, stderr: reason, response, conversationId, incomplete });
    };
    const ingest = line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      conversationId = findConversationId(event) || conversationId;
      if (event.event === 'step_update' && typeof event.step_update?.text_delta === 'string') response += event.step_update.text_delta;
      if (event.event === 'result') {
        gotResult = true;
        resultFailed = event.result?.status === 'ERROR';
        resultError = event.result?.error || null;
        if (typeof event.result?.response === 'string') response = event.result.response;
        conversationId = event.result?.conversation_id || conversationId;
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
