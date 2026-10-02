# Dar de alta un nuevo slot de colaborador

1. En el VPS, como root: `sudo bash scripts/provision-slot.sh colab-<nombre> <url del repo git>`
2. Copiá el `projectPath` que imprime el script al final.
3. Entrá a `/admin-slots.html` con tu PIN de admin, completá el formulario "Nuevo slot" con ese `osUser`/`projectPath` y el motor inicial que quieras.
4. Copiá el PIN que te muestra la página y compartíselo a la persona junto con la URL `/slot.html`.
5. Para cambiarle el motor más adelante, volvé a `/admin-slots.html` y elegí el motor nuevo en el selector de esa fila — la charla anterior queda archivada, solo lectura, y arranca una nueva.

Si el motor elegido (Codex o Gemini) nunca se logueó para ese usuario del sistema, el primer mensaje de la persona va a fallar con un error claro — loguear ese motor como `sudo -u colab-<nombre> <comando de login del motor>` antes de avisarle que ya puede usarlo.
