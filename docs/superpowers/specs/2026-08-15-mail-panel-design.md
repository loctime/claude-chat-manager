# Panel de Mail — diseño y estado actual

**Fecha**: 2026-08-15 (última actualización; el feature arrancó el 2026-08-14)
**Estado**: implementado, **PAUSADO** a pedido de Fernando (no gasta tokens hasta reactivarlo)

## Contexto

Fernando quería un panel tipo bandeja/Kanban dentro de Jarvis que le muestre los mails pendientes
de dos cuentas (Gmail `ferzepsas@gmail.com` y Outlook `hys@maximia.com.ar`), con resumen, para no
tener que abrir Gmail/Outlook aparte, y poder pedir un borrador de respuesta o mandarlo directo
desde ahí.

Es el 4to pane del sidebar (`Chats / Archivado / Notas / Mail`), mismo patrón de navegación que
Notas (ver `2026-08-11-notas-jarvis-design.md`).

## Por qué el escaneo pasa por un job de Claude Code, no por API directa

El server (Express) **no tiene credenciales propias** de Gmail/Outlook. Las únicas herramientas
disponibles son los MCP de Gmail y Microsoft 365, y esos MCP solo existen dentro de una sesión de
Claude Code CLI autenticada (OAuth de claude.ai) — no son una API que el server pueda llamar
directo. Por eso el "escaneo" es, en la práctica, un mensaje más mandado al mismo `runner` que
maneja las conversaciones normales, con un prompt que le pide a Claude que busque los mails y
escriba el resultado en un archivo.

**Intento de acceso directo (evaluado y descartado el 14/08):**
- **Gmail**: funciona por IMAP directo con el App Password — quedó confirmado y funcionando, pero
  **no se llegó a construir el polling directo** sobre esto (quedó en "confirmado", no integrado
  al panel).
- **Outlook**: dos caminos probados, **ambos bloqueados**: (1) el client ID de Azure CLI que ya se
  usa para SharePoint no tiene `Mail.*` preautorizado; (2) IMAP con Basic Auth está desactivado en
  todo Exchange Online de Microsoft. Se registró una app propia (`mail-reader`, client ID
  `afecad7d-5504-4a1c-8bf2-86cc882cf962`) con los permisos correctos, pero **el tenant de Maximia
  bloquea el autoconsentimiento** — hace falta que un Administrador Global lo apruebe a mano, y no
  hay forma de conseguirlo. La app queda registrada en Azure por si en el futuro aparece alguien
  con ese rol dispuesto a aprobarla (link de consentimiento en la memoria del proyecto, no acá por
  seguridad).

**Conclusión: las dos cuentas siguen por el mecanismo de job de Claude Code + MCP**, no por acceso
directo. Es más lento y gasta tokens, pero es lo único que funciona hoy para ambas cuentas por
igual.

## Arquitectura

### Datos (`src/mail.js`)

- `~/.ccm-notes/mail.json` — snapshot completo (no append-only), un objeto:
  ```json
  {
    "updatedAt": "ISO", "scanning": bool,
    "lastScanError": "string|null", "lastScanErrorAt": "ISO|null",
    "items": [ { id, from, subject, summary, body, project, urgent, receivedAt,
                 messageId, threadId, account, state, draft, draftPending,
                 rawBody, rawBodyPending, threadSessionId, sendResult, sentAt } ]
  }
  ```
- `~/.ccm-notes/mail.scan.json` — archivo de **staging**: acá escribe el job de escaneo su
  resultado crudo (con la tool `Write`), sin tocar `mail.json` directo.
- `state` es uno de `pendiente | respondido | archivado`.

### Merge determinístico, no prompt

El escaneo **no** reescribe `mail.json` — el LLM escribe `mail.scan.json`, y `mail.mergeScan()`
(código, no instrucción del prompt) combina eso con lo que ya había:

- Mail que ya estaba (mismo `id`): se refrescan solo los campos que vienen del mail real
  (`SCAN_FIELDS` en `mail.js`) — `state`/`draft`/`draftPending`/etc. quedan intactos.
- Mail nuevo: entra con `state: 'pendiente'`.
- Mail que ya estaba pero no salió en este escaneo (se fue de la ventana de "no leídos + últimos 3
  días" del prompt): **se conserva, no desaparece.** El panel es acumulativo — la ventana de 3 días
  solo decide qué mails nuevos busca cada vez, no purga los viejos.

Esto reemplazó un diseño anterior donde el prompt escribía `mail.json` directo con
`state: siempre "pendiente"` — cada "Actualizar bandeja" volvía todo a Pendiente y borraba
borradores en curso.

### Los 4 endpoints que disparan un job de Claude (gastan tokens)

Todos comparten el patrón: `runner.isBusy(convId)` para no duplicar, seteo de un flag `*Pending`
antes de mandar el job, y lectura del resultado desde el jsonl de la sesión cuando el job termina
(`runner.on('status', ...)` → `status === 'idle'`).

| Endpoint | convId | Modelo | Qué hace |
|---|---|---|---|
| `POST /api/mail/scan` | `__mail-scan__` (fijo, uno para todos los mails) | **`haiku`** | Busca no leídos + últimos 3 días en las 2 cuentas, escribe `mail.scan.json` |
| `POST /api/mail/:id/draft` | `mail-thread-<id>` | default (Sonnet) | Redacta una respuesta; con `--resume` en pedidos siguientes para iterar |
| `POST /api/mail/:id/raw` | `mail-thread-<id>` (mismo hilo que draft/send) | default (Sonnet), **sin `model`** a propósito | Trae el cuerpo del mail **verbatim**, sin resumir — ver más abajo por qué |
| `POST /api/mail/:id/send` | `mail-thread-<id>` | default (Sonnet) | Manda el `draft` guardado tal cual, vía la tool de Gmail/Outlook que corresponda |

**Por qué el escaneo usa Haiku y draft/raw/send no:** el escaneo es clasificación/resumen en bulk
(2 bandejas), no necesita razonamiento fuerte — Haiku es más rápido y barato. Draft/send necesitan
mejor calidad de redacción. `raw` en particular necesita seguir al pie de la letra una instrucción
de "no cambies ni una palabra" — ahí Haiku es más propenso a "limpiar" de más, así que se dejó
explícitamente sin `model:` (usa el default del CLI, hoy Sonnet).

### Por qué existe `/api/mail/:id/raw` — el `body` del escaneo no es confiable al 100%

El campo `body` que guarda el escaneo es una versión que el propio LLM (Haiku) "limpia y hace
legible" (sin HTML, sin firmas largas) — el prompt se lo pide explícitamente. Fernando notó que
eso significa que **no hay garantía de que sea palabra por palabra igual al original** — Haiku
podría parafrasear sin darse cuenta al "limpiar". El botón "Ver texto original (sin resumir)" pide
un fetch aparte, con instrucción explícita de traer el texto tal cual está en el servidor de
correo, usando un modelo más confiable para seguir esa instrucción sin desviarse. Guarda el
resultado en `item.rawBody`, separado de `item.body` — nunca lo pisa.

### Guardarraíl: timeout del escaneo

`runner.js` no tiene timeout propio para ningún job — si el proceso de Claude se cuelga (una tool
MCP que nunca responde), quedaría corriendo para siempre. Para el escaneo específicamente (los
otros tres endpoints son iniciados a mano por Fernando y él mismo puede notar si tardan demasiado)
se agregó un guardarraíl en `server.js`: `MAIL_SCAN_TIMEOUT_MS` (5 min) — si se cumple, se cancela
el job (`runner.cancel`) y se deja un `lastScanError` explicando que fue timeout, no un fallo de
MCP. El timer se limpia tanto si el job termina normal como si lo cancela el timeout.

### UI: detalle en el panel grande, no inline en la lista

v1 expandía el mail completo/borrador **inline dentro de la tarjeta**, en la lista angosta de la
izquierda — quedaba todo muy chico para leer. Se movió a `#mail-detail-view`, un panel nuevo
dentro de `#panel-chat` (el mismo panel grande de la derecha que muestra una conversación normal),
mostrado/ocultado con la clase `.mail-detail-active` en `#panel-chat` (oculta
`#chat-header`/`#messages-wrap`/`#composer` vía CSS mientras está activa). Reusa
`openChat()`/`closeChat()` — el mismo mecanismo de navegación mobile (historial, back button) que
ya usan las conversaciones normales, así no hubo que duplicar esa lógica.

Casos cubiertos: cerrar el detalle al cambiar de pane (`goToPane`), y al hacer back en mobile
(popstate handler) sin dejar `expandedMailId`/clases colgadas.

### Pausa (`MAIL_FEATURE_PAUSED`)

Fernando no está seguro si el feature le va a servir y pidió que no gaste nada mientras lo decide.
`MAIL_FEATURE_PAUSED = true` en `server.js` (arriba de la sección `// ── Mail ──`) corta los 4
endpoints que disparan un job **antes** de llegar a `runner.send` — 403 explícito, no es solo un
botón deshabilitado en el front. `GET /api/mail` devuelve `paused: true` y el front muestra un
banner "⏸️ Mail en pausa" + deshabilita los botones de acción. **Los mails ya escaneados siguen
visibles** (leer del disco no cuesta nada).

**Para reactivar:** `MAIL_FEATURE_PAUSED = false` en `server.js`, reiniciar el server. Nada más —
front y demás ya reaccionan solos al campo `paused` de la respuesta.

## Pendiente / conocido, sin resolver

1. **Threading real en Gmail/Outlook al mandar una respuesta.** Para que la respuesta se enganche
   al hilo original hacen falta los headers `In-Reply-To`/`References` con el **Message-ID RFC822**
   real — hoy el escaneo guarda el id interno de Graph/Gmail (`messageId`/`threadId` de la API), que
   **no es** ese Message-ID. El escaneo tendría que capturar el header real para que `/send` arme
   una respuesta enganchada de verdad y no un mail suelto con el mismo asunto.
2. **Gmail por IMAP directo: confirmado pero no integrado.** Se probó login+search por IMAP con el
   App Password y funcionó — quedó pendiente construir el polling directo sobre eso para sacar
   Gmail del mecanismo de job/MCP (más rápido, no gasta tokens para esa cuenta). Outlook seguiría
   sin acceso directo salvo que alguien con rol de Administrador Global en el tenant de Maximia
   apruebe la app `mail-reader` (ver arriba).
3. **Estado "respondido" automático.** Hoy se marca manual al mandar desde el panel. La idea
   evaluada era derivarlo mirando quién mandó el último mensaje del hilo (posible con IMAP directo
   para Gmail; para Outlook quedaría como parte de la clasificación del escaneo, menos confiable
   por depender del LLM).
4. **No hay tests para `mail.js`/los endpoints de mail** — el resto del proyecto tiene bastante
   cobertura (73 tests a la fecha), esta parte no tiene ninguno.

## Cómo seguir

- Reactivar es una línea (`MAIL_FEATURE_PAUSED = false`), sin tocar nada más.
- Si se retoma, el orden lógico de lo pendiente sería: 1 (threading, rompe la experiencia de
  responder si no está) → 2 (Gmail directo, saca la mitad del costo en tokens) → 3 (nice-to-have).
- Todo el código vive en `src/mail.js` (datos/merge), `src/server.js` (sección `// ── Mail ──`,
  endpoints + jobs), `public/app.js` (funciones `render Mail*`/`*MailDetail`/`*MailDraft`/
  `fetchMailRaw`), `public/index.html` (`#tree-mail`, `#mail-detail-view`),
  `public/style.css` (reglas `.mail-*`).
