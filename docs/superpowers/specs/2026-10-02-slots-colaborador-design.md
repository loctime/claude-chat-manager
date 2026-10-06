# Slots de colaborador — acceso restringido de terceros a Jarvis

**Fecha:** 2026-10-02
**Estado:** Diseño aprobado, pendiente de plan de implementación

> **SUPERADO (02/10/2026):** este enfoque se implementó, revisó y mergeó entero, pero
> se terminó revirtiendo por completo — depende de un solo proceso de Jarvis
> compartido con una variable global `activeAccount`, que no soporta dos personas
> con contexto distinto a la vez. Se reemplazó por "una instancia completa de
> Jarvis por colaborador" (mismo código, proceso y usuario del sistema propios).
> Ver la sección "Instancias para colaboradores — 02/10/2026" en `CLAUDE.local.md`
> para el diseño real que quedó. Este documento queda solo como historia de la
> decisión descartada, no como referencia vigente.

## 1. Contexto y objetivo

Diego quiere poder prestarle Jarvis (claude-chat-manager) a personas de confianza (ej. Fernando) para que trabajen en un proyecto puntual, sin darles una cuenta completa. La persona debe ver **una sola conversación activa**, sin saber qué motor de IA la responde (Claude Code normal, Codex, o Gemini/"agy"), y Diego debe poder cambiarle el motor cuando quiera desde su propia sesión. Se quiere como mecanismo **general y reutilizable** — no atado a una sola persona ni a un solo proyecto — para poder sumar más colaboradores a futuro.

Se decidió desplegar esto en el VPS (Linux), separado del Jarvis de la PC de Windows, porque el mecanismo real de aislamiento (cuentas del sistema operativo con `sudo -u` + home propio) solo funciona en Linux — en Windows el proyecto corre forzado a cuenta única.

## 2. Alcance

**Incluido en esta spec (v1):**

- Un mecanismo general de "slots": cada slot es un colaborador, con su propio PIN de acceso, su propio usuario de sistema operativo, un proyecto asignado (clon de git propio en su home), y un motor de IA actual (Claude Code / Codex / Gemini).
- Vista restringida para el colaborador: una sola conversación activa, sin árbol de chats, sin selector de cuentas, sin acceso a otros proyectos.
- Panel de administración (solo accesible con el PIN admin de Diego) para crear slots y cambiarles el motor.
- Al cambiar el motor de un slot: la conversación activa pasa a archivada (solo lectura, visible para copiar texto) y arranca una conversación nueva bajo el motor nuevo.
- Corrección del bug preexistente de `activeAccount` como variable global del servidor — la identidad (admin o slot específico) pasa a resolverse por cookie/request, no por estado global compartido.

**Explícitamente fuera de alcance (v2+):**

- Aprovisionamiento automático del usuario de sistema operativo desde la propia app Node (la creación del usuario Linux la corre Diego a mano, una vez por slot, con un script).
- Rate limiting o protección contra fuerza bruta sobre los PIN de slot (gap preexistente del proyecto, no se agrava ni se arregla acá).
- Qué paneles además del chat ve un colaborador (notas, agenda, sala) — v1 asume que ve *solo* el chat; si hace falta más, es una vuelta aparte.
- Convivencia entre dos slots que compartan el mismo proyecto (cada slot tiene su propio clon; compartir un working directory entre slots no está cubierto).

## 3. Arquitectura

- **Despliegue:** instancia nueva de claude-chat-manager en el VPS, gestionada con PM2 (patrón ya usado para el resto de los proyectos del VPS — a diferencia de la PC de Windows, donde se migró a servicios nativos por un bug de PM2 que no aplica en Linux).
- **Aislamiento por slot:** cada slot = un usuario Linux real (`useradd -m <slot>`), con un clon de git del proyecto asignado en `~/<slot>/<proyecto>`. El aislamiento es real a nivel de sistema de archivos, no solo ocultamiento en la interfaz.
- **Enrutamiento de motor:** se reusa el mecanismo ya existente en `runner.js`/`codex-runner.js`/`gemini-runner.js` — al mandar un mensaje, el servidor resuelve `slot → (usuario de sistema, motor actual, conversación activa)` y dispara el runner correspondiente con `account=<usuario del sistema>` y `cwd=<ruta del proyecto del slot>`.
- **Identidad por request, no por proceso:** la cookie de auth pasa a codificar *quién es* (admin, o un `slotId` puntual), y cada endpoint del servidor filtra según esa identidad — no hay más una variable `activeAccount` global compartida entre todas las conexiones.

## 4. Modelo de datos

Nuevo archivo `slots.json` (nivel app, no por cuenta del sistema):

| Campo | Descripción |
|---|---|
| `id` | Identificador del slot |
| `label` | Nombre para mostrar en el panel de admin (ej. "Fernando") |
| `osUser` | Usuario de sistema operativo asociado (ej. `colab-fernando`) |
| `projectPath` | Ruta del proyecto dentro del home de `osUser` |
| `engine` | Motor actual: `claude` \| `codex` \| `gemini` |
| `pin` | PIN de acceso propio del slot (distinto del `ACCESS_PIN` admin) |
| `activeConversationId` | Conversación visible actualmente para el colaborador |
| `archivedConversationIds` | Conversaciones anteriores de este slot, de solo lectura |

## 5. Flujo

1. Diego corre a mano, una vez por slot nuevo, un script de aprovisionamiento: crea el usuario Linux, clona el proyecto asignado en su home.
2. Desde el panel de admin (solo visible con el `ACCESS_PIN` de Diego), registra el slot: nombre, `osUser`, `projectPath`, motor inicial. El servidor genera el PIN del slot.
3. Diego le comparte a la persona la URL + su PIN de slot.
4. La persona entra, autentica con su PIN, y cae directo a su única conversación activa (se crea una vacía la primera vez) — sin árbol, sin selector de cuentas, sin ver otros proyectos.
5. Cada mensaje que manda se enruta al runner del motor actual de su slot, con `account=osUser` y el `cwd` de su proyecto.
6. Cuando Diego cambia el motor del slot desde el panel de admin: la `activeConversationId` actual se mueve a `archivedConversationIds` (queda visible de solo lectura, no se puede seguir escribiendo ahí) y se crea una `activeConversationId` nueva bajo el motor elegido.

## 6. Interfaz del colaborador vs. panel de admin

- **Vista del colaborador:** el cliente ya existente (`app.js`) entra en un modo restringido cuando la cookie resuelve a un `slotId` (no a admin) — oculta el árbol de conversaciones, el selector de cuentas, y cualquier endpoint de navegación a otros proyectos. Muestra solamente la conversación activa del slot + su composer, y las conversaciones archivadas del mismo slot en una lista de solo lectura (para copiar texto).
- **Panel de admin:** nueva pestaña/sección visible solo con el PIN admin — lista los slots existentes (nombre, proyecto, motor actual), con un control para cambiar el motor de cada uno y ver su PIN.

## 7. Manejo de errores y casos borde

- **Mensaje mientras se está cambiando el motor:** si llega un mensaje nuevo del colaborador en el mismo instante en que Diego cambia el motor, se rechaza con un error claro (reintentar) en vez de mezclarse con la conversación vieja o la nueva a medias.
- **Motor sin configurar para ese usuario de sistema** (ej. Codex sin login para `osUser`): error claro devuelto al colaborador, no un crash del proceso.
- **Alta de slot con `osUser` ya usado por otro slot, o `projectPath` inexistente:** el panel de admin devuelve un error explícito al crear el slot, no falla en silencio ni crea un slot a medio configurar.
- **PIN de slot inválido o reusado por otro slot:** rechazado en el login, mismo mecanismo de cookie que ya usa `ACCESS_PIN` hoy.

## 8. Testing

- Tests unitarios (`node --test`, patrón ya usado en el proyecto) para: resolución PIN → slot, que un PIN de slot nunca resuelva a datos de otro slot ni del admin, y la lógica de archivar la conversación activa + crear una nueva al cambiar de motor.
- La creación real del usuario Linux (`useradd`) y el clon de git no se pueden testear en CI — se verifican a mano, una vez, al dar de alta un slot real.
