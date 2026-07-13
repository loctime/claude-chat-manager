const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class Runner extends EventEmitter {
  constructor({ maxConcurrent = 2, spawnFn = spawn, command = 'claude' } = {}) {
    super();
    this.max = maxConcurrent;
    this.spawnFn = spawnFn;
    this.command = command;
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

  _drain() {
    while (this.running.size < this.max && this.queue.length > 0) {
      this._start(this.queue.shift());
    }
  }

  _start(job) {
    const args = ['-p', job.text, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (job.sessionId) args.push('--resume', job.sessionId);
    const child = this.spawnFn(this.command, args, { cwd: job.cwd });
    this.running.set(job.convId, child);
    this.emit('status', { convId: job.convId, status: 'running' });

    let buf = '';
    let stderr = '';
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
    child.on('close', code => {
      this.running.delete(job.convId);
      const status = { convId: job.convId, status: 'idle', code };
      if (code !== 0) status.stderr = stderr;
      this.emit('status', status);
      this._drain();
    });
  }
}

module.exports = { Runner };
