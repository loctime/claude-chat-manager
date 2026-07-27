// Hub SSE global: un solo canal por cliente conectado, broadcast a todos.
// El heartbeat (un único interval compartido) existe solo mientras haya
// clientes — así el proceso puede salir limpio y los tests no cuelgan.
class SseHub {
  constructor({ heartbeatMs = 20000 } = {}) {
    this.clients = new Set();
    this.heartbeatMs = heartbeatMs;
    this._timer = null;
  }

  handle(req, res, hello) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    if (hello) res.write(`data: ${JSON.stringify(hello)}\n\n`);
    this.clients.add(res);
    if (!this._timer) {
      // Cloudflare Tunnel corta conexiones SSE inactivas (~100s de idle).
      this._timer = setInterval(() => {
        this._fanout(':heartbeat\n\n');
      }, this.heartbeatMs);
    }
    req.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0 && this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    });
  }

  broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    this._fanout(data);
  }

  _fanout(data) {
    const deadClients = [];
    for (const c of this.clients) {
      try {
        c.write(data);
      } catch (err) {
        deadClients.push(c);
      }
    }
    // Remover clientes muertos y limpiar heartbeat si no queda ninguno.
    for (const c of deadClients) {
      this.clients.delete(c);
    }
    if (this.clients.size === 0 && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  get size() { return this.clients.size; }
}

module.exports = { SseHub };
