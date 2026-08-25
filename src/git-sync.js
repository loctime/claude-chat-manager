const { execFile } = require('child_process');

function runGit(args, cwd, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl('git', args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout || '';
        err.stderr = stderr || '';
        return reject(err);
      }
      resolve((stdout || stderr || '').trim());
    });
  });
}

async function resolveRepo(cwds, run = runGit) {
  const seen = new Set();
  for (const cwd of cwds) {
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    try {
      const repo = await run(['rev-parse', '--show-toplevel'], cwd);
      if (repo) return repo;
    } catch { /* no es un repo (o ya no existe): probar el siguiente cwd */ }
  }
  return null;
}

// La secuencia segura para un árbol con cambios es commit → pull --rebase →
// push. Un pull antes del commit puede rechazar un working tree sucio; nunca
// se fuerza ni se descarta nada para "hacerlo pasar".
async function syncRepo(repo, { message = 'chore: sync changes', run = runGit } = {}) {
  const statusBefore = await run(['status', '--porcelain'], repo);
  let commit = null;
  if (statusBefore) {
    await run(['add', '-A'], repo);
    await run(['commit', '-m', message], repo);
    commit = await run(['rev-parse', '--short', 'HEAD'], repo);
  }
  const pull = await run(['pull', '--rebase'], repo);
  const push = await run(['push'], repo);
  return { repo, committed: !!commit, commit, pull, push };
}

module.exports = { runGit, resolveRepo, syncRepo };
