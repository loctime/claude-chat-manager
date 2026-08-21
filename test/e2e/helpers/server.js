// Levanta el server real (src/server.js) como proceso aparte, apuntando a un
// HOME de prueba y con CLAUDE_CMD apuntando al doble fake-claude.js — nunca al
// binario real. Puerto libre elegido por el SO (nunca 3777/3778, nunca toca la
// instancia real que puede estar corriendo en esta PC).
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'src', 'server.js');
const FAKE_CLAUDE = path.join(__dirname, '..', 'fixtures', 'fake-claude.js');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseURL, timeoutMs = 20_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(baseURL + '/');
      if (res.status < 500) return;
    } catch (err) { lastErr = err; }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`El server de prueba no respondió a tiempo en ${baseURL}: ${lastErr && lastErr.message}`);
}

async function startTestServer(home) {
  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home, // Windows: os.homedir() y HOME_DIR miran esta var
      PORT: String(port),
      HOST: '127.0.0.1',
      SINGLE_ACCOUNT: '1',
      CLAUDE_CMD: FAKE_CLAUDE,
      ACCESS_PIN: '', // sin PIN — nunca el de la instancia real, se pisa explícito
    },
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let log = '';
  child.stdout.on('data', d => { log += d.toString(); });
  child.stderr.on('data', d => { log += d.toString(); });

  await waitForServer(baseURL).catch(err => {
    child.kill();
    throw new Error(`${err.message}\n--- salida del server ---\n${log}`);
  });

  return {
    baseURL,
    pid: child.pid,
    getLog: () => log,
    stop() {
      return new Promise(resolve => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      });
    },
  };
}

module.exports = { startTestServer };
