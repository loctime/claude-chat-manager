# Claude Chat Manager

Gestor web local de conversaciones de Claude Code. Sidebar por proyecto,
chat con streaming, máximo 2 procesos `claude` concurrentes (cola FIFO).

## Uso

    npm install
    npm start          # http://127.0.0.1:3777

Variables: `PORT` (default 3777), `HOST` (default 127.0.0.1 — cambiar a
0.0.0.0 para acceso desde la red local, bajo tu responsabilidad: las
sesiones corren con --dangerously-skip-permissions).

## Cómo funciona

- Lee los JSONL de `~/.claude/projects/` (solo lectura, nunca los escribe).
- Nombres y estado de conversaciones en `~/.claude/session-manager/meta.json`.
- Cada mensaje spawnea `claude -p --resume <id> --output-format stream-json`.
- Gotcha: `--resume` genera un session-id nuevo por mensaje; meta.json
  trackea la cadena y oculta los ids viejos (`superseded`).

## Tests

    npm test
