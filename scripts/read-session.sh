#!/usr/bin/env bash
# scripts/read-session.sh <projectsDir> <sessionId>
# Corre como el usuario dueno del slot (via sudo -u desde claude) para poder
# leer su propio historial de sesion sin depender de ACLs — el dueno de un
# archivo siempre puede leer lo suyo sin importar el modo (0600/0700) que el
# CLI le haya puesto al crearlo, a diferencia de un ACL que un proceso
# externo intente otorgarle a otro usuario (ver hallazgo I1 de la revision
# final: la mascara de un ACL default se recalcula en cada archivo nuevo
# segun el modo pedido al crearlo, y el CLI crea sus .jsonl en 0600 — eso
# anula cualquier entrada de usuario nombrado del ACL). Hace la misma
# busqueda que scanner.findSessionFile (un .jsonl que matchee el sessionId
# en alguna subcarpeta de projectsDir) pero corriendo con los permisos
# reales del dueno.
set -euo pipefail
PROJECTS_DIR="$1"
SESSION_ID="$2"
[ -d "$PROJECTS_DIR" ] || exit 0
found=$(find "$PROJECTS_DIR" -maxdepth 2 -name "${SESSION_ID}.jsonl" -print -quit 2>/dev/null || true)
[ -n "$found" ] && cat "$found"
exit 0
