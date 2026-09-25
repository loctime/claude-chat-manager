# Mascota animada compañera (UI Chat)

**Fecha:** 25/09/2026  
**Estado:** propuesto / en especificación  
**Autor:** Antigravity & Diego Bertosi  

---

## 1. Objetivo

Agregar una mascota compañera animada en la interfaz de chat de `claude-chat-manager` (ubicada en la esquina inferior derecha del área de mensajes, a la izquierda del botón de ir al final `#jump-bottom`).

La mascota tendrá un estilo visual 3D (tipo muñeco de colección / Pixar / Clash Royale), pero implementada como **WebP animado transparente** precalculado. De esta forma, ofrece una experiencia visual viva y moderna con impacto prácticamente nulo en CPU, memoria y batería tanto en escritorio como en la PWA móvil.

---

## 2. Fuera de alcance (decidido explícitamente)

- **Motores 3D en tiempo real (Three.js / WebGL / .glb):** descartados por consumo de batería, peso de librerías (~1 MB JS) y riesgo de jank en móviles al scrollear.
- **Sonidos o ruidos:** la mascota es 100% visual y silenciosa.
- **Interferir con el scroll o el input:** la mascota vive en una capa flotante (`pointer-events: none` en su contenedor con `pointer-events: auto` solo en el sprite) para nunca bloquear la lectura ni los clics en mensajes o botones.

---

## 3. Estados y ciclo de vida

La mascota opera con una máquina de estados sencilla de 4 fases principales más 1 interacción:

| Estado | Cuándo se activa | Comportamiento visual |
|---|---|---|
| `idle` | Estado por defecto (chat abierto, sin proceso activo). | Respiración sutil, pestañeo cada tanto, mirada tranquila. |
| `thinking` | Se envió un mensaje; esperando primer chunk o inicio de ejecución. | Mirando hacia arriba, rascándose la cabeza o con una lamparita. |
| `working` | Ejecutando herramientas (bash, lecturas, escrituras) o streameando texto. | Bailando con energía, tipeando en una mini laptop o martillando. |
| `done` | El turno finalizó con éxito (`status: 'idle'`). | Festejo breve (1 a 1.5 seg con brazos arriba o guiño) y vuelve automáticamente a `idle`. |
| `tap` *(interactivo)* | El usuario hace clic o tap sobre la mascota. | Salto o pirueta rápida de 0.8s con vuelta inmediata al estado previo. |

---

## 4. Diseño técnico y rendimiento

### 4.1 Formato de los assets
- **Tipo de archivo:** WebP animado con canal alfa transparente (lossy o lossless según peso).
- **Dimensiones:** Canvas cuadrado de 128x128 px (renderizado en pantalla a 64x64 px en desktop y 52x52 px en móviles, garantizando nitidez en pantallas de alta densidad).
- **Peso objetivo:** Entre 25 KB y 50 KB por estado (total del conjunto < 180 KB).
- **Ubicación:** `public/assets/mascot/` (`idle.webp`, `thinking.webp`, `working.webp`, `done.webp`).

### 4.2 Precarga en memoria (Zero-Flicker)
Al cargar la aplicación, `mascot.js` instancia:
```javascript
['idle', 'thinking', 'working', 'done'].forEach(state => {
  const img = new Image();
  img.src = `/assets/mascot/${state}.webp`;
});
```
Esto asegura que las transiciones de estado sean instantáneas y no se produzca ningún parpadeo en blanco.

### 4.3 Integración en el DOM
El widget se inserta dentro de `#messages-wrap` (que ya cuenta con `position: relative` para el botón `#jump-bottom`):

```html
<div id="mascot-widget" class="mascot-widget" aria-hidden="true" title="Compañero J.A.R.V.I.S">
  <img id="mascot-img" class="mascot-img" alt="Mascota animada" />
</div>
```

### 4.4 Posicionamiento CSS
- Anclado en `position: absolute; right: 58px; bottom: 12px; z-index: 4;`.
- El botón `#jump-bottom` permanece en `right: 14px; bottom: 14px; z-index: 5;`, conviviendo en armonía sin superponerse.
- En móvil (`@media (max-width: 768px)`): escala a 52x52 px y posición `right: 54px; bottom: 10px;`.

---

## 5. Integración con el flujo de la aplicación

Se expone un módulo global `window.Mascot`:
- `Mascot.init()`: monta el elemento, precarga imágenes y lee la preferencia del usuario.
- `Mascot.setState(state)`: realiza la transición de estado controlando timers (ej. retorno de `done` a `idle`).
- `Mascot.setEnabled(bool)`: activa o desactiva la visibilidad.

Puntos de enganche (hooks) existentes:
1. **Claude Code (`app.js`):**
   - En `setBusy(true)` → `Mascot.setState('thinking')` o `'working'`.
   - Al recibir chunks de texto / tool calls → `Mascot.setState('working')`.
   - En `setBusy(false)` (cuando llega evento `status: 'idle'`) → `Mascot.setState('done')`.
2. **Antigravity / Gemini (`gemini.js`):**
   - En `setGeminiBusy(true)` → `'working'`.
   - En `setGeminiBusy(false)` → `'done'`.
3. **Codex (`codex.js`):**
   - En `setCodexMainBusy(true)` → `'working'`.
   - En `setCodexMainBusy(false)` → `'done'`.

---

## 6. Configuración de usuario

Se agrega una opción en `settings-dialog.js`:
- Checkbox / Switch: **"Mascota animada"** (por defecto: activada).
- Guardado en `localStorage.getItem('jarvis_mascot_enabled')`.
- Si se desactiva, el widget se oculta con `hidden` y no ejecuta animaciones ni precargas.

---

## 7. Plan de implementación

### Tarea 1: Estructura de assets y placeholders
- Crear carpeta `public/assets/mascot/`.
- Incorporar assets iniciales o placeholders WebP/SVG limpios para los 4 estados (`idle`, `thinking`, `working`, `done`) para permitir desarrollo y testing inmediato.

### Tarea 2: Módulo `public/mascot.js`
- Implementar la lógica de precarga de imágenes.
- Implementar la máquina de estados con auto-reset para `done` y manejo de interacción `tap`.
- Cargar `mascot.js` en `public/index.html`.

### Tarea 3: Estilos CSS y posicionamiento
- Agregar reglas en `public/style.css` para `#mascot-widget` y `.mascot-img`.
- Ajustar márgenes para convivencia con `#jump-bottom` y el composer.
- Reglas responsive para viewport móvil.

### Tarea 4: Cableado de estados en el ciclo de vida
- Enganchar `Mascot.setState` en `app.js` (`setBusy`, inicio de stream, fin de stream).
- Enganchar `Mascot.setState` en `gemini.js` y `codex.js`.

### Tarea 5: Ajuste en diálogo de configuración
- Agregar control on/off en el diálogo de configuración (`settings-dialog.js`).
- Persistir preferencia en `localStorage`.

### Tarea 6: Verificación
- Validar transiciones de estado en escritorio y en el celular (PWA).
- Confirmar que no exista parpadeo entre cambios de estado.
- Comprobar que el scroll suave y los botones no se vean interferidos.
