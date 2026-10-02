#!/usr/bin/env bash
# scripts/provision-slot.sh <osUser> <repoUrl> [projectDirName]
# Crea el usuario de sistema para un slot, clona el proyecto asignado en su
# home, y habilita a `claude` (el usuario que corre el proceso de Jarvis en
# este VPS) a ejecutar los motores de IA como ese usuario nuevo — mismo
# patron acotado por comando ya usado en /etc/sudoers.d para tron/cazador/
# bunn/matt (ver /etc/sudoers.d al inspeccionar el VPS), nunca un ALL
# generico. Correr a mano en el VPS, una vez por slot nuevo, ANTES de crear
# el slot desde el panel de admin (Tarea 6) — el projectPath que le pasas al
# panel tiene que coincidir con la ruta que este script deja clonada.
set -euo pipefail

OS_USER="${1:?uso: provision-slot.sh <osUser> <repoUrl> [projectDirName]}"
REPO_URL="${2:?falta la URL del repo a clonar}"
PROJECT_DIR="${3:-$(basename "$REPO_URL" .git)}"

if id "$OS_USER" &>/dev/null; then
  echo "El usuario $OS_USER ya existe — abortando para no pisar un slot existente." >&2
  exit 1
fi

useradd -m -s /bin/bash "$OS_USER"
sudo -u "$OS_USER" git clone "$REPO_URL" "/home/$OS_USER/$PROJECT_DIR"

# claude (el usuario que corre el proceso de Jarvis) necesita poder entrar
# (chdir) y leer el home de este slot para spawnear el CLI ahi y despues
# leer el historial real (scanner.js lee accountProjectsDir(osUser) de forma
# directa, sin sudo) — el 0750 por default de useradd -m NO le da nada a
# claude, que no esta en el grupo de este usuario nuevo. ACL en vez de
# agregarlo al grupo porque un cambio de grupo no aplica al proceso de
# Jarvis ya corriendo (necesitaria reiniciarlo en cada alta de slot); el ACL
# aplica al toque. El -d (default) hace que TODO lo que el CLI cree despues
# bajo este home (ej. ~/.claude/projects/...) herede el mismo permiso.
setfacl -R -m u:claude:rx "/home/$OS_USER"
setfacl -R -d -m u:claude:rx "/home/$OS_USER"

SUDOERS_FILE="/etc/sudoers.d/ccm-slot-$OS_USER"
cat > "$SUDOERS_FILE" <<EOF
claude ALL=($OS_USER) NOPASSWD: /usr/bin/claude
EOF
chmod 440 "$SUDOERS_FILE"
visudo -c -f "$SUDOERS_FILE" || { rm -f "$SUDOERS_FILE"; echo "sudoers invalido, se elimino el archivo (no se deja un sudoers roto en el VPS). Revisar a mano por que fallo." >&2; exit 1; }

echo "Listo. projectPath para el panel de admin: /home/$OS_USER/$PROJECT_DIR"
echo "Antes de avisarle a la persona: logueate una vez como ese usuario para que el motor tenga credenciales -- sudo -u $OS_USER claude (seguir el login interactivo una sola vez)."
