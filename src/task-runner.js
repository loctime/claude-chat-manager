const path = require('path');

const TASKS_DIR = path.join(__dirname, 'tasks');
const RUN_TIMEOUT_MS = 90 * 1000;

async function runTaskScript(task, { state, input, dryRun }, tasksDir = TASKS_DIR, timeoutMs = RUN_TIMEOUT_MS) {
  const modPath = path.join(tasksDir, task.scriptModule);
  let mod;
  try {
    mod = require(modPath);
  } catch (err) {
    throw new Error(`No se pudo cargar el script "${task.scriptModule}": ${err.message}`);
  }
  if (typeof mod.run !== 'function') throw new Error(`El script "${task.scriptModule}" no exporta una función run()`);
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`El script "${task.scriptModule}" tardó más de ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([
      mod.run({ state: state || {}, input, dryRun: !!dryRun, task }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
  if (!result || typeof result !== 'object' || !result.ui || typeof result.ui.type !== 'string') {
    throw new Error(`El script "${task.scriptModule}" debe devolver { state, ui: { type } }`);
  }
  return { state: result.state || {}, ui: result.ui };
}

module.exports = { runTaskScript, TASKS_DIR, RUN_TIMEOUT_MS };
