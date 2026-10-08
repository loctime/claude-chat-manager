// Aviso y aplicación de actualizaciones de la app para quien la esté usando.
//
// El cron del VPS (scripts/ccm-update-instances.sh) deja el código nuevo en disco pero
// no reinicia una instancia mientras alguien trabaja. Este módulo cierra ese hueco desde
// la propia página: el cliente consulta /api/version, muestra un aviso flotante y deja que
// la persona decida (actualizar ya, cuando termine, o forzar). Si fuerza con trabajo en
// curso, se anotan las conversaciones cortadas y, al volver la app, el cliente le pide a
// cada motor que continúe (/api/update-resume).
const { Router } = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Si cambia algo de acá, el proceso en marcha quedó viejo. Docs, scripts y catálogo no
// cuentan (mismo criterio que scripts/ccm-update-instances.sh).
const WATCHED = ['src', 'public', 'package.json', 'package-lock.json'];
const CHECK_TTL_MS = 15000;
const FETCH_TTL_MS = 60000;            // cada cuánto se consulta GitHub (solo con canPull)
const RESUME_TTL_MS = 15 * 60 * 1000; // más viejo que esto, "continuar" ya no tiene sentido
const CANCEL_GRACE_MS = 1500;          // margen para que los motores terminen de escribir su sesión

// En el VPS el checkout es de otro usuario (claude) y la instancia corre como colab-*:
// sin safe.directory git se niega a leerlo ("dubious ownership") y todo daría null.
// Por línea de comandos es la forma que git acepta, y es de solo lectura.
function gitArgs(repoRoot, args) {
  return ['-c', `safe.directory=${repoRoot}`, ...args];
}

function runGit(repoRoot, args, timeout = 5000) {
  return new Promise(resolve => {
    execFile('git', gitArgs(repoRoot, args), { cwd: repoRoot, windowsHide: true, timeout }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// pull --ff-only: nunca crea merges ni pisa cambios locales; si no puede, devuelve por qué.
function runPull(repoRoot) {
  return new Promise(resolve => {
    execFile('git', gitArgs(repoRoot, ['pull', '--ff-only', '-q']), { cwd: repoRoot, windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: (stderr || err.message).trim().split(/\r?\n/)[0] } : { ok: true });
    });
  });
}

// engines: { claude, codex, agy } → runners con .running (Map/Set), .queue y .cancel(convId)
function createUpdateRouter({
  repoRoot,
  engines,
  canSelfRestart,
  canPull = false,   // instancia dueña de su checkout: puede traer lo nuevo de GitHub ella misma
  restart,
  resumeFile,
  git = (args, timeout) => runGit(repoRoot, args, timeout),
  pull = () => runPull(repoRoot),
  now = Date.now,
  graceMs = CANCEL_GRACE_MS,
}) {
  const router = Router();
  // Commit con el que arrancó ESTE proceso: lo que realmente está corriendo.
  const runningHead = git(['rev-parse', 'HEAD']);
  let cache = { at: 0, value: null };
  let restarting = false;
  let lastFetch = 0;
  let applying = false; // pull en curso: un segundo pedido no debe duplicarlo

  // Hay commits en GitHub que todavía no están en el disco y tocan código que corre.
  async function pullPending() {
    if (!canPull) return false;
    if (now() - lastFetch > FETCH_TTL_MS) {
      lastFetch = now();
      await git(['fetch', '-q', 'origin'], 30000);
    }
    const behind = await git(['rev-list', '--count', 'HEAD..@{upstream}']);
    if (!behind || behind === '0') return false;
    const changed = await git(['diff', '--name-only', 'HEAD', '@{upstream}', '--', ...WATCHED]);
    return changed === null ? true : changed.length > 0;
  }

  async function check() {
    if (cache.value && now() - cache.at < CHECK_TTL_MS) return cache.value;
    const running = await runningHead;
    const available = await git(['rev-parse', 'HEAD']);
    let updateAvailable = false;
    if (running && available && running !== available) {
      const changed = await git(['diff', '--name-only', running, available, '--', ...WATCHED]);
      // Si no se puede comparar (commit viejo que ya no existe), mejor avisar que quedarse callado.
      updateAvailable = changed === null ? true : changed.length > 0;
    }
    const pullAvailable = await pullPending();
    if (pullAvailable) updateAvailable = true;
    cache = { at: now(), value: { running, available, updateAvailable, pullAvailable } };
    return cache.value;
  }

  function busyList() {
    const out = [];
    for (const [engine, r] of Object.entries(engines)) {
      const ids = new Set();
      if (r.running) for (const id of r.running.keys()) ids.add(id);
      for (const job of r.queue || []) ids.add(job.convId);
      for (const id of ids) out.push({ engine, id });
    }
    return out;
  }

  router.get('/version', async (req, res) => {
    const v = await check();
    res.json({ ...v, canUpdate: !!canSelfRestart, busy: busyList() });
  });

  router.post('/update-now', async (req, res) => {
    if (!canSelfRestart) return res.status(400).json({ error: 'esta instancia no se puede reiniciar sola' });
    if (restarting || applying) return res.json({ ok: true, restarting: true, interrupted: 0 });
    const busy = busyList();
    const force = !!(req.body && req.body.force === true);
    if (busy.length && !force) return res.status(409).json({ error: 'hay trabajo en curso', busy });

    // Primero bajar el código: si falla, no se corta nada de lo que esté trabajando.
    if (canPull && (await check()).pullAvailable) {
      applying = true;
      const r = await pull().finally(() => { applying = false; });
      cache = { at: 0, value: null };
      if (!r.ok) {
        console.error('[update] git pull falló:', r.error);
        return res.status(500).json({ error: `No se pudo bajar la actualización: ${r.error}` });
      }
    }

    if (busy.length) {
      try {
        fs.mkdirSync(path.dirname(resumeFile), { recursive: true });
        fs.writeFileSync(resumeFile, JSON.stringify({ items: busy, ts: now() }));
      } catch (err) {
        // Sin el archivo no se podría retomar nada: mejor no cortar el trabajo en curso.
        console.error('[update] no se pudo guardar la lista para retomar:', err.message);
        return res.status(500).json({ error: 'no se pudo preparar la actualización' });
      }
      for (const { engine, id } of busy) {
        try { engines[engine].cancel(id); } catch (err) { console.error('[update] cancel falló:', engine, id, err.message); }
      }
    }
    restarting = true;
    res.json({ ok: true, restarting: true, interrupted: busy.length });
    res.on('finish', () => setTimeout(restart, busy.length ? graceMs : 300));
  });

  // Read-once: el primer cliente que vuelve tras el reinicio retoma lo que se cortó.
  router.get('/update-resume', (req, res) => {
    try {
      const data = JSON.parse(fs.readFileSync(resumeFile, 'utf8'));
      fs.unlinkSync(resumeFile);
      if (now() - data.ts > RESUME_TTL_MS) return res.json({ items: [] });
      res.json({ items: Array.isArray(data.items) ? data.items : [] });
    } catch {
      res.json({ items: [] });
    }
  });

  return router;
}

module.exports = { createUpdateRouter, gitArgs, WATCHED, RESUME_TTL_MS };
