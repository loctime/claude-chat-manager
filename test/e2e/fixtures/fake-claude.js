// Doble de prueba del CLI real `claude` — lo usan los tests e2e (test/e2e/) vía
// CLAUDE_CMD (ver test/e2e/helpers/server.js), así ningún test toca la API real
// de Anthropic: cero red, cero costo, siempre la misma respuesta.
//
// Entiende el subconjunto de flags que arma src/runner.js al mandar un mensaje:
//   -p <texto> --output-format stream-json --verbose --dangerously-skip-permissions
//   [--resume <sessionId>] [--model <modelo>] [--append-system-prompt <...>]
//
// Como el CLI real, escribe la sesión a ~/.claude/projects/<cwd codificado>/<id>.jsonl
// (mismo formato que lee src/scanner.js) y después imprime stream-json por stdout —
// así el flujo completo "mandar mensaje → releer de disco al terminar el turno"
// funciona de punta a punta sin tocar Anthropic.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function encodeProjectDir(p) { return String(p).replace(/[^a-zA-Z0-9]/g, '-'); }

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const text = argValue('-p') || '';
const resume = argValue('--resume');
const model = argValue('--model') || 'sonnet';
const cwd = process.cwd();
const home = process.env.HOME || process.env.USERPROFILE;
// Sin --resume (primer mensaje de una conversación nueva) el CLI real arranca
// una sesión propia — acá alcanza con un id fresco, no hace falta más realismo.
const sessionId = resume || crypto.randomUUID();

const projDir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
fs.mkdirSync(projDir, { recursive: true });
const sessionFile = path.join(projDir, `${sessionId}.jsonl`);

const now = new Date().toISOString();
const replyText = `[fake-claude] respuesta de prueba a: "${text}"`;
const lines = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid: crypto.randomUUID(), timestamp: now, cwd }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: replyText }], model: `claude-${model}` }, timestamp: now, cwd }),
];
fs.appendFileSync(sessionFile, lines.join('\n') + '\n');

// stream-json mínimo por stdout — src/runner.js solo necesita líneas JSON
// válidas separadas por \n; el contenido real que ve el usuario sale de
// releer el .jsonl de arriba tras terminar el turno (ver loadMessages en
// public/app.js), no del streaming en vivo.
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, result: replyText }) + '\n');
// Sin process.exit(): en Windows, escribir a un pipe de stdout es asíncrono —
// forzar la salida acá podría cortar la escritura de arriba a mitad. Dejamos
// que el script termine solo (exit code 0 por default) una vez vaciado el event loop.
