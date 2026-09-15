# Task: catálogo de tareas con ejecución por script — Design

## Contexto

La pestaña "Agenda" (semáforo de tareas recurrentes mensuales, `src/agenda.js` + `public/agenda.js`) hoy tiene dos formas de ejecutar una tarea desde el botón de la tarjeta:

- **Flujo por chat** (`autoPrompt`, la mayoría del catálogo hoy — ej. las facturas mensuales de TGD/Brucellaria/Maximia vía AFIP RCEL): "▶️ Hacer ahora" abre una conversación real nueva y un agente hace todo el trabajo razonando y usando herramientas. Funciona, pero gasta tokens todos los meses para repetir exactamente el mismo trabajo.
- **Flujo por script, sin LLM** (el caso "Pedir nómina a Macarena"): un módulo Node (`outlook-classic.js`) hace el trabajo determinístico y expone 3 rutas a medida (`/macarena/prepare`, `/macarena/send`, `/macarena/check`) escritas a mano en `routes/agenda.js`. Cero tokens, pero no es reusable — cada tarea nueva de este tipo necesitaría que alguien le escriba rutas nuevas.

Fernando quiere poder crear tareas nuevas (el disparador que motivó esta charla: facturar a un cliente en ARCA) que se ejecuten como script en vez de como chat, sin que cada una requiera tocar el server a mano. Este spec diseña ese mecanismo general — **no** la automatización concreta de la factura ARCA, que queda como sub-proyecto aparte una vez que el mecanismo esté armado.

## Decisiones tomadas en brainstorming

- **Alcance de esta vuelta**: solo el framework general (catálogo + ejecución por script + Skill que las crea). La automatización real de la factura ARCA es un spec/plan aparte.
- **Skill real de Claude Code**, no una ampliación del botón actual — vive en el repo (`.claude/skills/crear-tarea/`), no global, porque el flujo ya arranca con `cwd` en `claude-chat-manager`.
- **Pausas sin proceso vivo**: cuando un script necesita algo humano (esperar una respuesta que puede tardar días, pedir un código), se modela como llamadas HTTP independientes que releen estado persistido — mismo patrón que Macarena ya usa hoy — y no como un proceso que queda bloqueado esperando input. Sobrevive reinicios del server y esperas largas sin costo.
- **Contrato único genérico** (`run(state, input, dryRun)`) en vez de nombres de pasos fijos tipo prepare/confirm/check — el vocabulario de pausas posibles no queda limitado a 3 nombres, y agregar una tarea nueva no requiere tocar `server.js`.
- **Modo prueba obligatorio**: toda tarea-script nace con `verified:false`. El server fuerza `dryRun:true` mientras no esté verificada, sin importar lo que mande el cliente — nadie puede saltarse el modo prueba desde la UI por error.
- **`kind` y `execution` quedan separados**: `kind` sigue describiendo la semántica del semáforo (de qué depende la tarea); `execution` describe cómo se corre (`chat` o `script`). Una tarea puede ser `insumo-terceros` y `execution:'script'` a la vez (como Macarena, conceptualmente).
- **Credenciales nuevas**: la Skill nunca las crea ni las pide directamente. Le dice a Fernando qué falta y dónde conviene guardarlo (siguiendo la convención de `settings.json`/memoria ya existente), y si conseguirla es sensible (login con 2FA, generar un certificado), le recomienda hacerlo él mismo desde otra sesión.
- **Rebranding cosmético**: la pestaña pasa a llamarse "Task" en la UI. Los nombres internos (`agenda.js`, ids `agenda-*`, rutas `/api/agenda/...`) no se tocan — es un cambio de etiqueta visible, no vale la pena el refactor mecánico de renombrar todo el módulo ahora.
- **Macarena no se migra**: la tarjeta de "Estadístico Contratista" sigue con sus 3 rutas a medida tal cual están — ya funciona, migrarla al mecanismo genérico no es necesario para que el resto ande.

## Arquitectura

### 1. Modelo de datos (`agenda.json`)

Cada tarea (catálogo semilla o `customTasks`) suma tres campos opcionales, con default que preserva el comportamiento actual:

- `execution`: `'chat'` (default si no está presente) | `'script'`
- `scriptModule`: nombre de archivo en `src/tasks/`, solo si `execution==='script'` (ej. `'facturar_tgd.js'`) — elegido por la Skill al crear la tarea, desacoplado del `id` autogenerado para que sea legible.
- `verified`: `boolean`, solo aplica a `execution==='script'`, arranca en `false`.

El estado de una corrida en curso se guarda junto al resto del estado mensual de la tarea, en `data.tasks[id]`:

- `runState`: objeto opaco que el script arma y devuelve — el server no lo interpreta, solo lo persiste y se lo vuelve a pasar en la próxima llamada.
- `runStatus`: `'idle' | 'waiting' | 'error' | 'done'`.
- `runUi`: la última directiva de UI que devolvió el script (para redibujar la pausa pendiente si se recarga la página sin volver a llamar a `run`).
- `runError`: mensaje de la última excepción, solo si `runStatus==='error'`.

### 2. Scripts (`src/tasks/`)

Un archivo por tarea-script, contrato único:

```js
module.exports = {
  run: async ({ state, input, dryRun, task }) => {
    // ... hace el trabajo real, o lo simula si dryRun ...
    return { state: nuevoState, ui: { type: 'listo' } };
    // otros tipos de ui: 'texto-editable' ({texto}), 'pedir-dato' ({pregunta}), 'accion' ({boton})
  }
};
```

- `state`: lo último persistido para esa tarea (objeto vacío en la primera llamada).
- `input`: lo que mandó el usuario en la pausa anterior (texto editado, dato pedido, o `undefined` si el paso no pedía nada).
- `dryRun`: `true` mientras `task.verified !== true` (impuesto por el server, ver más abajo) — el script debe simular sin ejecutar la acción irreversible (no manda el mail, no presenta la factura), pero puede igual hacer todo el trabajo de preparación real.
- `ui.type === 'listo'` marca la tarea como terminada — el server llama a `markDone` solo, sin acción aparte del lado de la UI.
- **Regla de idempotencia obligatoria**: si el script puede duplicar una acción real al reintentar (mandar una factura, un mail), tiene que chequear antes de repetir si ya se hizo — misma regla que ya aparece a mano en los `autoPrompt` actuales ("revisá Consultas por fecha de hoy antes de reintentar, para no duplicar").

### 3. Runner + endpoints (`routes/agenda.js`, `src/agenda.js`)

- `POST /api/agenda/:id/run` — body opcional `{ input }`. Carga el módulo de `scriptModule`, llama a `run()` con el `state` persistido + `input` + `dryRun` (forzado a `true` si `!task.verified`, sin importar lo que mande el cliente). Persiste `state`/`ui` devueltos, actualiza `runStatus`, responde `{ ui, runStatus }`.
- `POST /api/agenda/:id/verify` — pasa `verified` de `false` a `true`. Solo tiene efecto para tareas `execution==='script'`.
- `POST /api/agenda/:id/reset-run` — limpia `runState`/`runStatus`/`runError` para arrancar de cero una tarea que quedó en estado de error irrecuperable.
- `GET /api/agenda` (`list()`) suma `execution`, `scriptModule`, `verified`, `runStatus` y `runUi` de cada tarea, para que la UI redibuje la pausa pendiente al cargar sin tener que volver a invocar `run`.
- **Timeout**: cada llamada a `run()` se envuelve con un límite de 2 minutos — un script que dispara Playwright contra un portal externo puede colgarse esperando una respuesta que nunca llega; sin timeout la tarea queda "corriendo" para siempre en la UI.
- **Manejo de errores**: una excepción de `run()` se atrapa, guarda `runStatus:'error'` + `runError`, y responde 500. No tira abajo el proceso del server (mismo criterio que el resto de `server.js`, ver `/api/files` y `/api/folder-zip`, que ya tienen este cuidado con streams).

### 4. UI (`public/agenda.js`, pestaña renombrada a "Task")

Cambio de etiqueta visible únicamente — ids internos y endpoints no cambian.

`agendaCardActions(task)` suma un caso para `execution==='script'`:

- `!verified` → botón único "🧪 Probar" (llama a `/run`, el server fuerza `dryRun`).
- `verified` → "▶️ Hacer ahora" de siempre, ejecuta en serio.
- Debajo de los botones, un renderer genérico según `ui.type` de la última respuesta: texto editable + confirmar (`texto-editable`), pedir un dato con input (`pedir-dato`), o solo un botón de "seguir" (`accion`) — mismo look que el cuadro de Macarena hoy (`.agenda-draft`), generalizado a los 3 tipos.
- Tras una prueba sin errores con `!verified`: banner "🧪 Esto no ejecutó nada real todavía" + botón "✅ Confirmar y activar" (llama a `/verify`).
- `runStatus==='error'`: caja de aviso con `runError` + botones "Reintentar" (vuelve a llamar `/run` sin `input`) y "Reiniciar" (llama a `/reset-run`).

### 5. La Skill (`.claude/skills/crear-tarea/SKILL.md`)

Checklist que sigue al crear una tarea nueva:

1. Charla básica para juntar título, día fijo o no, y grupo — mismo tono conversacional que ya usa el botón "🎓 Aprender rutina nueva" hoy.
2. Investigar ANTES de decidir cómo ejecutarla:
   - ¿Existe una API oficial del sistema destino? (preferir siempre sobre automatizar la UI — ej. ARCA tiene WSFEv1 por SOAP+certificado en vez de scrapear el portal RCEL; ControlDoc ya tiene una vía documentada en memoria del proyecto).
   - Si no hay API, ¿se puede automatizar de forma determinística (selectores estables, sin que haga falta criterio del LLM en cada corrida)?
   - Si la tarea necesita juicio real en cada corrida (leer contenido variable, resolver un captcha visual, decidir algo ambiguo), la conclusión válida es dejarla como `execution:'chat'` con `autoPrompt` — no todo debe forzarse a script.
3. Si falta una credencial nueva: le dice a Fernando exactamente qué falta y dónde conviene guardarla (según la convención de `settings.json`/memoria existente) — nunca la crea ni la pide ella misma. Si conseguirla es sensible (login con 2FA, generar un certificado), recomienda hacerlo desde otra sesión.
4. Escribe el script en `src/tasks/<nombre>.js` con el contrato de la sección 2, aplicando la regla de no duplicar acciones al reintentar.
5. Registra la tarea (extiende `addCustomTask` para aceptar `execution`/`scriptModule`; arranca `verified:false`).
6. Corre un dry-run ahí mismo en el chat y le muestra a Fernando qué haría.
7. Con confirmación explícita de Fernando, la deja lista para que él apriete "✅ Confirmar y activar" desde la tarjeta (la Skill no llama a `/verify` por su cuenta).

### 6. Testing

- El runner genérico (`run` del server, no el de cada script) se testea con `node --test` usando módulos de prueba simulados — función pura, mismo patrón que el resto del repo (sin harness de servidor+SSE real en los tests automáticos).
- El renderer de los 3 tipos de `ui` se verifica en vivo con Playwright contra el server real, mismo criterio que el resto de features de este proyecto.
- Ningún test automático puede cubrir que un script real le pegue de verdad a ARCA/ControlDoc/etc. — esa verificación pasa por el propio paso de dry-run al momento de crear la tarea, no por una suite.

## Fuera de alcance (v1)

- El script real de facturación ARCA (queda como sub-proyecto aparte, con su propio spec).
- Migrar la tarjeta de Macarena al mecanismo genérico.
- Renombrar módulos/rutas internas de "agenda" a "task" (solo cambia la etiqueta visible en la UI).
- Un proceso vivo bloqueado esperando input (Opción B evaluada y descartada en brainstorming).
- Colas de prioridad o ejecución en paralelo entre tareas-script.
- Migrar tareas existentes con `autoPrompt` (como las facturas de TGD/Brucellaria/Maximia) a `execution:'script'` — cada una se evalúa y migra individualmente cuando haga falta, no en bloque.
