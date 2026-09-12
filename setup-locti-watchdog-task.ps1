# OBSOLETO -- 2026-09-12. NO USAR.
#
# Este script intentaba registrar JarvisLocti-Watchdog con LogonType S4U,
# corriendo desde la sesion de locti sin elevar. Se probo en vivo y da
# "Acceso denegado" -- S4U (incluso para uno mismo) parece requerir que el
# proceso que registra este elevado, y locti no es miembro de Administradores,
# asi que nunca puede elevarse el mismo.
#
# Ademas de no funcionar, correr esto ENCIMA de una tarea ya registrada por el
# metodo bueno es activamente daniño: Register-ScheduledTask con -Force borra
# la tarea existente antes de intentar reemplazarla: si el reemplazo falla (como
# siempre va a fallar aca), la tarea buena queda borrada y sin reponer. Esto
# paso de verdad el 2026-09-12 -- ver CLAUDE.local.md.
#
# Usar en su lugar: setup-locti-tasks-with-password.ps1 (se corre UNA vez,
# desde la sesion de User elevada, pidiendo la contrasena de locti).

Write-Output "Este script esta obsoleto y no hace nada -- usar setup-locti-tasks-with-password.ps1 en su lugar."
Write-Output "Ver el comentario de este archivo para la explicacion completa."
Read-Host "Presione Enter para cerrar"
exit 1
