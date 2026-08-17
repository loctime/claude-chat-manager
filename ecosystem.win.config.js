// PM2 ecosystem config para Jarvis en Windows (server + tunel Cloudflare).
// Reemplaza a start-jarvis.bat / restart-jarvis.ps1 / jarvis-watchdog.ps1 como
// mecanismo de arranque y reinicio. No tiene secretos: ACCESS_PIN y demas env
// vars se heredan del proceso que arranca el daemon de PM2 (setx a nivel usuario).
//
// Uso:
//   pm2 start ecosystem.win.config.js   (primera vez / tras editar este archivo)
//   pm2 save                            (persiste la lista para "pm2 resurrect")
//   pm2 restart jarvis-server           (reinicio manual, sin admin, sin PID hunting)
//   pm2 restart jarvis-tunnel
//   pm2 logs jarvis-server              (en vez de %TEMP%\jarvis-server.log)
//
// Solo tiene sentido en Windows (esta PC). En Linux (loctime) se sigue usando start.sh.
module.exports = {
  apps: [
    {
      name: 'jarvis-server',
      script: 'src/server.js',
      cwd: __dirname,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 30,
      restart_delay: 2000,
      min_uptime: 5000,
      // El botón "Reiniciar server" de Configuración (POST /api/restart, ver
      // doRestart() en server.js) hace self-respawn por default (spawn detached
      // + process.exit) si no hay RESTART_CMD — bajo PM2 eso deja DOS procesos
      // vivos peleando el puerto 3777: el que este proceso relanzó a mano y el
      // que PM2 relanza solo porque autorestart:true ve morir al original.
      // Con RESTART_CMD seteado, doRestart() delega en "pm2 restart" y no hace
      // process.exit() propio — deja que PM2 mate y relance de la forma
      // normal, un solo proceso en todo momento. Ruta completa a pm2.cmd
      // (no "pm2" a secas) por el mismo motivo que jarvis-tunnel de abajo: no
      // hay garantía de que el PATH que ve este proceso hijo de PM2 lo resuelva.
      env: { RESTART_CMD: '"C:\\Users\\User\\AppData\\Roaming\\npm\\pm2.cmd" restart jarvis-server' },
    },
    {
      name: 'jarvis-tunnel',
      // Ruta fija porque cloudflared no siempre resuelve bien como comando bare
      // via spawn de PM2 en Windows. Ajustar si cloudflared se reinstala en otra ruta.
      script: 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
      args: 'tunnel run',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 30,
      restart_delay: 2000,
      min_uptime: 5000,
    },
  ],
};
