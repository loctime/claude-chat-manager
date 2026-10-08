// ── Guía / Ayuda ──
// Diálogo con la guía de uso de la app y de cómo conversar con los agentes.
// Script clásico (no ES module): comparte el scope global con el resto ($, etc.).
// El contenido está acá (no en index.html) para editarlo sin tocar el layout.
// Cada sección es un <details> nativo; la primera arranca abierta.

const HELP_SECTIONS = [
  {
    title: '👋 Qué es esto',
    html: `
      <p>Es una app para <strong>chatear con agentes de IA</strong> (Claude, Codex, AgY) que trabajan en una computadora: leen archivos, escriben código, corren comandos. Vos les hablás en lenguaje normal desde el celular o la compu.</p>
      <p>Cada conversación es una <strong>sesión</strong> con su propia memoria. El agente recuerda todo lo que se habló <em>dentro</em> de esa conversación, y nada de las otras.</p>
      <p>Las pestañas de arriba son distintos lugares:</p>
      <ul>
        <li><strong>Chats</strong> — tus conversaciones con Claude (la principal).</li>
        <li><strong>Archivado</strong> — conversaciones que guardaste de costado. Se activa en Configuración → Pestañas.</li>
        <li><strong>AgY</strong> y <strong>Codex</strong> — otros agentes, útiles para pedir una segunda opinión o ejecutar planes.</li>
        <li><strong>Notas</strong> — libretas para anotar cosas, sin gastar IA.</li>
        <li><strong>Task</strong> — rutinas programadas.</li>
        <li><strong>Sala</strong> y <strong>Equipo</strong> — charlas compartidas con otras personas.</li>
      </ul>
      <p>Las pestañas que no usás las podés ocultar desde ⚙️ Configuración → Pestañas.</p>`,
  },
  {
    title: '💬 Cómo hablarle bien a la IA',
    html: `
      <p>La calidad de lo que responde depende mucho de cómo se lo pedís. Reglas que funcionan:</p>
      <ol>
        <li><strong>Un tema por conversación.</strong> Si vas a hablar de otra cosa, abrí una conversación nueva (botón de arriba a la derecha). Mezclar temas confunde al agente y gasta contexto de más.</li>
        <li><strong>Si empieza a delirar, empezá de nuevo.</strong> Si repite errores, se contradice, olvida lo que le dijiste o inventa cosas, no insistas: la conversación se "ensució". Abrí una nueva y contale lo importante en un solo mensaje corto.</li>
        <li><strong>Sé concreto.</strong> En vez de "arreglá esto", decí qué esperabas que pasara, qué pasa en realidad y dónde. Cuanto más claro el pedido, menos vueltas.</li>
        <li><strong>Una cosa a la vez.</strong> Pedidos grandes, partilos en pasos y verificá cada uno antes de pasar al siguiente.</li>
        <li><strong>Mostrale, no describas.</strong> Una captura, un archivo o el texto exacto del error valen más que cualquier explicación. Usá el clip 📎 para adjuntar.</li>
        <li><strong>Corregí rápido.</strong> Si entendió mal, aclaralo en el momento. No sigas sobre una base equivocada.</li>
        <li><strong>Pedí que confirme antes de cosas grandes.</strong> Para borrar, publicar o tocar muchas cosas, decile "primero contame qué vas a hacer".</li>
        <li><strong>No lo tomes como verdad absoluta.</strong> Puede equivocarse con total seguridad. Si algo es importante, pedile que lo compruebe o revisalo vos.</li>
      </ol>
      <p class="help-tip">Regla de oro: <strong>conversación larga y mezclada = respuestas peores</strong>. Conversaciones cortas y enfocadas = mejores resultados y menos gasto.</p>`,
  },
  {
    title: '📁 Proyectos: qué son y para qué sirven',
    html: `
      <p>Un <strong>proyecto</strong> es una etiqueta para agrupar conversaciones del mismo tema (por ejemplo "Maximia", "Tienda web", "Facturas"). Si trabajás en varias cosas a la vez, te dice de un vistazo <em>en qué estás parado</em>.</p>
      <p><strong>Cómo se usa:</strong></p>
      <ul>
        <li>Debajo de las pestañas está la barra <strong>📁 Todos los proyectos</strong>. Tocala para elegir un proyecto: la lista muestra solo sus conversaciones. Doble toque vuelve a "Todos".</li>
        <li><strong>+ Nuevo proyecto…</strong> (dentro de ese selector) crea uno: podés elegir una carpeta real de la computadora o poner un nombre libre.</li>
        <li>Con un proyecto elegido, el botón de <strong>nueva conversación</strong> crea la charla ya etiquetada con ese proyecto.</li>
        <li>Para cambiar una conversación de proyecto: mantené apretada (o click derecho) → <strong>🏷️ Asignar / Cambiar proyecto…</strong></li>
        <li>Sobre un proyecto, el botón ⋯ permite renombrarlo, ocultarlo de "Todos los proyectos" o eliminarlo. Eliminarlo <strong>no borra</strong> las conversaciones, solo las deja sin proyecto.</li>
      </ul>
      <p class="help-tip">El proyecto es una etiqueta de organización. No cambia por sí solo dónde trabaja el agente: si querés que actúe sobre una carpeta o app concreta, nombrala en tu primer mensaje (ej: "Vamos a trabajar en la app Facturas").</p>
      <p><strong>Buenas prácticas:</strong> un proyecto por cliente, app o tema grande; dentro de cada uno, varias conversaciones cortas (una por tarea). Es mejor eso que una sola conversación eterna.</p>`,
  },
  {
    title: '🧠 Contexto: el porcentaje de arriba',
    html: `
      <p>El agente solo puede "tener en la cabeza" una cantidad limitada de texto por conversación: el <strong>contexto</strong>. Todo lo que se dijo, los archivos que leyó y los resultados de comandos lo van llenando.</p>
      <p>En el encabezado del chat hay una insignia con un <strong>porcentaje</strong>: cuánto del contexto ya se usó. Tocala para ver el detalle (tokens y costo estimado). Cambia de color a medida que se llena.</p>
      <ul>
        <li><strong>Hasta ~50 %:</strong> todo bien.</li>
        <li><strong>50–80 %:</strong> empieza a pesar. Si vas a seguir mucho rato, pensá en compactar.</li>
        <li><strong>Más de 80 %:</strong> conviene compactar o abrir una conversación nueva ya mismo. Con el contexto lleno el agente se vuelve más lento, olvida cosas y se equivoca más.</li>
      </ul>`,
  },
  {
    title: '🗜️ Compactar: qué es, cuándo y para qué',
    tour: 'compact',
    html: `
      <p><strong>Qué es:</strong> le pide al agente que haga un <strong>resumen de toda la conversación</strong> y lo use como memoria, descartando el detalle. La charla sigue siendo la misma (mismo historial, misma sesión), pero ocupa mucho menos contexto.</p>
      <p><strong>Para qué:</strong> liberar espacio sin perder el hilo. Es como resumir un libro largo en un par de páginas con lo importante.</p>
      <p><strong>Cuándo usarlo:</strong></p>
      <ul>
        <li>El porcentaje de contexto está alto (arriba del 70–80 %) y todavía te falta trabajo en <em>esa misma tarea</em>.</li>
        <li>El agente se puso lento o empezó a olvidar cosas del principio.</li>
        <li>Quedó un resumen largo de decisiones que querés conservar.</li>
      </ul>
      <p><strong>Cuándo NO:</strong> si cambiaste de tema, no compactes — abrí una conversación nueva. Y si ya está confundido o delirando, compactar arrastra la confusión: mejor empezar de cero.</p>
      <p><strong>Cómo:</strong> mantené apretada la conversación en la lista (o click derecho) → <strong>🗜️ Compactar</strong>. Corre en segundo plano y puede tardar en charlas largas. Mientras compacta no se pueden mandar mensajes a esa conversación. Cuando termina, aparece una línea divisoria en el chat con cuántos tokens se liberaron.</p>
      <p class="help-tip">Compactar pierde detalle fino (palabras exactas, código largo ya leído). Lo importante queda; si algo puntual es crítico, repetíselo después.</p>`,
  },
  {
    title: '⏪ Rebobinar: volver atrás en la charla',
    html: `
      <p><strong>Qué es:</strong> borra <strong>uno de tus mensajes y todo lo que vino después</strong>, y el agente lo olvida de verdad, como si nunca hubiera pasado. La conversación sigue desde la respuesta anterior.</p>
      <p><strong>Para qué sirve:</strong></p>
      <ul>
        <li>Hiciste una pregunta mal y el agente se fue por un camino equivocado: rebobiná hasta ahí y volvé a preguntar mejor.</li>
        <li>Probaste algo que no funcionó y no querés que ensucie el resto de la charla.</li>
        <li>Querés explorar otra alternativa desde un punto anterior.</li>
      </ul>
      <p><strong>Cómo:</strong> mantené apretado tu mensaje (o click derecho) → <strong>⏪ Rebobinar hasta acá</strong>. Solo aparece en <em>tus</em> mensajes.</p>
      <p class="help-warn">⚠️ Rebobinar olvida la charla, pero <strong>no deshace lo que se hizo en la computadora</strong>. Si en ese tramo se editaron archivos, se corrieron comandos o se hicieron commits, siguen aplicados. La app te avisa el detalle antes de confirmar.</p>
      <p>Se guarda un backup del archivo de sesión por las dudas.</p>`,
  },
  {
    title: '👆 Menús: tocar y mantener apretado',
    html: `
      <p>Casi todo se hace con <strong>click derecho</strong> (compu) o <strong>mantener apretado</strong> (celular).</p>
      <p><strong>Sobre una conversación en la lista:</strong></p>
      <ul>
        <li>➕ Nueva conversación (dentro del mismo proyecto)</li>
        <li>📋 Copiar conversación</li>
        <li>📌 Fijar — la deja siempre arriba</li>
        <li>📁 Archivar — la saca de la lista sin borrarla</li>
        <li>🏷️ Asignar o cambiar proyecto</li>
        <li>🗜️ Compactar</li>
        <li>⬆️ Git — guarda y sube los cambios del proyecto (commit + pull + push, sin forzar nada)</li>
        <li>🙈 Ocultar</li>
      </ul>
      <p><strong>Sobre un mensaje del chat:</strong></p>
      <ul>
        <li>📋 Copiar · 🔤 Seleccionar texto (para copiar solo una parte)</li>
        <li>☑️ Seleccionar mensajes — elegís varios y copiás la conversación entera o solo los textos</li>
        <li>↩️ Citar — pone ese mensaje en el cuadro de texto para responderlo</li>
        <li>⏪ Rebobinar hasta acá (solo en tus mensajes)</li>
      </ul>
      <p>En el celular, deslizar la lista hacia un costado pasa entre Chats y Archivado.</p>`,
  },
  {
    title: '✍️ Escribir, adjuntar y hablar',
    html: `
      <ul>
        <li><strong>Enviar:</strong> en la compu, Enter envía y Shift+Enter hace salto de línea. En el celular el Enter del teclado hace salto de línea; se envía con el botón ➤.</li>
        <li><strong>📎 Adjuntar:</strong> imágenes, PDFs y cualquier archivo. El agente los lee. Las capturas de error son oro.</li>
        <li><strong>🎤 Micrófono:</strong> grabás tu voz y se transcribe al cuadro de texto, para que lo revises antes de enviar.</li>
        <li><strong>🔊 En cada mensaje:</strong> lee la respuesta en voz alta.</li>
        <li><strong>Cancelar (✕):</strong> corta la respuesta si va por mal camino. Mejor cancelar y aclarar que esperar todo.</li>
        <li><strong>Mensaje en cola:</strong> si escribís mientras el agente todavía responde, tu mensaje queda guardado y se envía solo cuando termina (uno por conversación).</li>
        <li><strong>Tu último mensaje fijo:</strong> arriba del chat queda una barra con lo último que escribiste; tocala para volver a él.</li>
        <li><strong>Copiar código:</strong> cada bloque de código y cada comando tienen un botón ⧉.</li>
      </ul>`,
  },
  {
    title: '🤖 Modelos: cuál elegir',
    html: `
      <p>Arriba del chat hay un selector de modelo. Podés cambiarlo en cualquier momento; aplica desde el próximo mensaje.</p>
      <ul>
        <li><strong>Sonnet</strong> — el equilibrado. Para el día a día.</li>
        <li><strong>Opus</strong> — más potente. Para problemas difíciles, decisiones importantes o código complejo. Gasta más.</li>
        <li><strong>Fable</strong> — otro modelo de la familia, para cuando quieras comparar.</li>
        <li><strong>Haiku</strong> — el más rápido y liviano. Para tareas simples y preguntas cortas.</li>
      </ul>
      <p class="help-tip">Empezá con Sonnet. Si se traba o el tema es delicado, probá Opus. Cambiar de modelo no reinicia la conversación.</p>`,
  },
  {
    title: '🔎 Buscar, archivar y ordenar',
    html: `
      <ul>
        <li><strong>🔍 Buscar</strong> (o Ctrl+K): busca en todas tus conversaciones y notas, ignora tildes, marca el término y te lleva al mensaje exacto. Podés filtrar por Claude, Codex, AgY o Notas.</li>
        <li><strong>Archivar</strong> las conversaciones terminadas mantiene la lista limpia sin perder nada.</li>
        <li><strong>Fijar</strong> las que usás todo el tiempo.</li>
        <li><strong>Renombrar:</strong> ponele a cada conversación un nombre que diga de qué trata — después la encontrás mucho más fácil.</li>
        <li><strong>Notas:</strong> para guardar datos, ideas o texto que no necesitás que responda una IA.</li>
      </ul>`,
  },
  {
    title: '🆘 Problemas comunes',
    html: `
      <ul>
        <li><strong>Responde cosas raras o se contradice</strong> → conversación sucia o con el contexto lleno. Mirá el porcentaje; compactá o empezá una nueva.</li>
        <li><strong>Entendió mal lo que pedí</strong> → rebobiná hasta tu mensaje y reformulalo, en vez de seguir corrigiendo.</li>
        <li><strong>Está tardando demasiado</strong> → cancelá (✕) y pedí algo más acotado, o dividí el pedido.</li>
        <li><strong>No encuentro una conversación</strong> → usá la búsqueda, mirá en Archivado, o revisá si hay un proyecto filtrado en la barra 📁 (volvé a "Todos los proyectos").</li>
        <li><strong>La app no carga o quedó colgada</strong> → deslizá hacia abajo para actualizar o usá ⟳. Si sigue, avisale a quien administra la app.</li>
        <li><strong>Cambié de tema</strong> → conversación nueva. Siempre.</li>
      </ul>`,
  },
];

// El botón "Muéstrame" lanza un recorrido real (tour.js) sobre la app. Se oculta
// si la instancia no tiene la pestaña Chats (ej. colaboradores solo con Codex/AgY).
function tourButtonHtml(name) {
  const chats = document.querySelector('.pane-tab[data-pane="0"]');
  if (!chats || chats.hidden || chats.offsetParent === null) return '';
  return `<p><button type="button" class="help-show-me" data-tour="${name}">▶ Muéstrame cómo se hace</button> <span class="help-show-me-hint">Lo hacemos juntos en una conversación de práctica.</span></p>`;
}

function buildHelpDialog() {
  const body = $('help-body');
  if (!body || body.childElementCount) return;
  body.innerHTML = HELP_SECTIONS.map((s, i) => `
    <details class="help-section"${i === 0 ? ' open' : ''}>
      <summary>${s.title}</summary>
      <div class="help-content">${s.tour ? tourButtonHtml(s.tour) : ''}${s.html}</div>
    </details>
  `).join('');
}

function openHelp() {
  buildHelpDialog();
  const dlg = $('help-dialog');
  if (!dlg.open) dlg.showModal();
}

$('help-btn').onclick = openHelp;
$('help-body').addEventListener('click', e => {
  const b = e.target.closest('.help-show-me');
  if (b && typeof startTour === 'function') startTour(b.dataset.tour);
});
// Click en el backdrop (el propio <dialog>, no un descendiente) cierra.
$('help-dialog').addEventListener('click', e => {
  if (e.target === e.currentTarget) $('help-dialog').close();
});
