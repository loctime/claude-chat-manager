#!/usr/bin/env node
// Cliente mínimo para que un turno de Claude en Jarvis pueda crear un worker
// durable sin tener acceso a la cookie HTTP de la PWA. Lee el token efímero
// inyectado por runner.js; nunca lo imprime.
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'create') throw new Error('uso: background-job.js create --title <título> --cwd <carpeta> --prompt-file <archivo> [--project <nombre>]');
  const value = name => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : '';
  };
  const title = value('--title');
  const cwd = value('--cwd');
  const promptFile = value('--prompt-file');
  const project = value('--project');
  if (!title || !cwd || !promptFile) throw new Error('faltan --title, --cwd o --prompt-file');
  const prompt = fs.readFileSync(promptFile, 'utf8');
  const baseUrl = process.env.CCM_BACKGROUND_JOBS_URL;
  const token = process.env.CCM_BACKGROUND_JOBS_TOKEN;
  if (!baseUrl || !token) throw new Error('este comando solo puede ejecutarse desde un turno de Jarvis');
  const response = await fetch(baseUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, cwd, project, prompt }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Jarvis respondió ${response.status}`);
  console.log(`Trabajo de fondo encolado: ${body.job.title}. Su conversación ya aparece en la lista de Chats.`);
}
main().catch(err => { console.error('No se pudo crear el trabajo de fondo:', err.message); process.exitCode = 1; });
