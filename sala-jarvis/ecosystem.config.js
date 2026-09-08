module.exports = {
  apps: [{
    name: 'sala-jarvis',
    script: 'src/server.js',
    cwd: __dirname,
    autorestart: true,
    env: {
      PORT: 3410,
      // SALA_TOKENS se setea en el shell antes de `pm2 start` (no en este
      // archivo, no se commitea) — ver README.md de este mismo folder.
    },
  }],
};
