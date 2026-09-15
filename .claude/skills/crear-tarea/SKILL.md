---
name: crear-tarea
description: Use when adding a recurring Task to the "Task" tab of claude-chat-manager (src/agenda.js) — investigates whether it can run as a cheap deterministic script instead of a token-costing chat flow, writes the script, and registers it safely behind a dry-run gate before it can execute anything real.
---

# Crear tarea nueva para la pestaña Task

Usá esta skill al crear una tarea recurrente para `src/agenda.js`. El objetivo es decidir si conviene un script determinístico (cero tokens por corrida) o un chat que razona.

## Paso 1 — Entender la tarea

Pedí título, día fijo del mes (o ninguno), grupo y todos los detalles de negocio: destino, formato, datos de entrada y resultado esperado. Pedí links, capturas o una explicación manual si hacen falta.

## Paso 2 — Investigar antes de decidir

Priorizá: API oficial; después automatización determinística con UI, archivo o mail de formato estable; finalmente chat si requiere juicio variable, captcha o interpretación ambigua. No fuerces un script frágil.

## Paso 3 — Credenciales faltantes

No crees, pidas ni supongas credenciales. Indicá qué falta y dónde guardarlo según `CLAUDE.md` o memoria del proyecto. Para logins sensibles, 2FA, OAuth o certificados, recomendá hacerlo desde otra sesión.

## Paso 4 — Si es script, escribilo

Creá `src/tasks/<nombre_descriptivo>.js` y exportá este contrato:

```js
module.exports = {
  run: async ({ state, input, dryRun, task }) => ({
    state: {},
    ui: { type: 'listo' },
  }),
};
```

`state` persiste entre llamadas; `input` es la respuesta de la persona. Con `dryRun:true` hacé preparación real, pero nunca la acción irreversible final. Devolvé `{ state, ui }`; los tipos permitidos son `texto-editable`, `pedir-dato`, `accion` y `listo`. Diseñá cada paso para que un reintento nunca duplique una acción real. Cada llamada tiene máximo 90 segundos: dividí procesos largos en pasos persistidos.

## Paso 5 — Registrar la tarea

Desde la raíz del repo:

```bash
node -e "require('./src/agenda').addCustomTask({ title: 'Título', group: 'Grupo', day: 1, execution: 'script', scriptModule: 'nombre.js' })"
```

Para chat, omití `execution` y `scriptModule`, y agregá un `autoPrompt` completo siguiendo el catálogo existente. Las tareas-script nacen con `verified:false`.

## Paso 6 — Dry-run

Corré el flujo entero con `dryRun:true` o con el botón “🧪 Probar”. Mostrá exactamente qué leería, escribiría o enviaría en modo real.

## Paso 7 — Activación explícita

Nunca llames al endpoint `/verify` ni actives una tarea por tu cuenta. Cuando la persona valide la prueba, indicále que use “✅ Confirmar y activar” en la tarjeta Task.
