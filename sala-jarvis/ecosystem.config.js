module.exports = {
  apps: [{
    name: 'sala-jarvis',
    script: 'src/server.js',
    cwd: __dirname,
    autorestart: true,
    env: {
      // 3410 ya estaba ocupado en el VPS por cazador-webhook (2026-09-08) —
      // ver ss -tlnp antes de reusar este puerto si algún día se libera.
      PORT: 3420,
      // SALA_TOKENS se setea en el shell antes de `pm2 start` (no en este
      // archivo, no se commitea) — ver README.md de este mismo folder.
    },
  }],
};
