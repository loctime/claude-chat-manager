// Estado de la pestaña Agenda: catálogo de tareas recurrentes mensuales +
// semáforo. Mismo patrón que notes.js (snapshot completo en ~/.ccm-notes/,
// no jsonl) — acá no hace falta historial, solo el estado del mes actual.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const NOTES_DIR = path.join(HOME_DIR, '.ccm-notes');
const AGENDA_FILE = path.join(NOTES_DIR, 'agenda.json');

// Catálogo fijo de tareas — se edita acá a mano cuando aparece una tarea
// recurrente nueva (ver charla 07/09/2026 con Fernando, botón "+ Tarea
// nueva" queda para más adelante, esto es el catálogo semilla).
//
// kind:
//  - 'auto'            → en teoría no necesita nada de vos, se puede tildar
//                         solo cuando el flujo real esté conectado (hoy: tilde manual)
//  - 'insumo-propio'    → depende de que VOS mandes un dato/archivo primero
//  - 'insumo-terceros'  → depende de un dato que tiene OTRA persona (ej. Macarena)
//  - 'mantenido'        → "hecho" no significa enviado, significa actualizado
//                         y listo por si lo piden (ej. Fiplasto pausado, KPI 107-85)
//
// day: día del mes objetivo (para el semáforo). null = sin día fijo.
// Comando que le pido a la propia sesión disparada que corra al terminar,
// para que la tarea se marque sola en verde — mismo patrón en las dos
// facturas, generado acá para no repetir la ruta absoluta a mano.
const MARK_DONE_CMD = id =>
  `cd /mnt/c/Users/Fernando/Desktop/claude/claude-chat-manager && node -e "require('./src/agenda').markDone('${id}', true)"`;

const CATALOG = [
  {
    id: 'fact_tgd_brucellaria', title: 'Facturar TGD + Brucellaria', group: 'Facturación', day: 5, kind: 'auto',
    checklist: ['Factura A TGD S.A. — $72.600', 'Factura A Brucellaria y Strappa SA — $108.900'],
    autoPrompt: `Facturá TGD S.A. y Brucellaria y Strappa SA este mes — seguí el flujo de factura/CLAUDE.md (AFIP RCEL, ambas con Factura A desde FERZEP RAMALLO, día 5). Cuidado con el modal de "Confirmar Datos..." (puede quedar tapado por el overlay) y con NO reintentar a ciegas si un click "parece" fallar — revisá Consultas por fecha de hoy antes de reintentar, para no duplicar. Guardá los PDFs y avisame por Telegram cuando estén las 2 listas.\n\nRecién cuando confirmes que las 2 facturas se generaron bien, marcá la tarea como hecha corriendo esto en la terminal:\n${MARK_DONE_CMD('fact_tgd_brucellaria')}`,
  },
  {
    id: 'fact_maximia', title: 'Facturar Maximia', group: 'Facturación', day: 22, kind: 'auto',
    checklist: ['Factura A Maximia SA — $2.904.000'],
    autoPrompt: `Facturá Maximia SA este mes — seguí el flujo de factura/CLAUDE.md (AFIP RCEL, Factura A desde FERZEP RAMALLO, período mes en curso, día 22). Cuidado con el modal de "Confirmar Datos..." y con NO reintentar a ciegas — revisá Consultas por fecha de hoy antes de reintentar, para no duplicar. Guardá el PDF en factura/maximia/ y avisame por Telegram.\n\nRecién cuando confirmes que la factura se generó bien, marcá la tarea como hecha corriendo esto en la terminal:\n${MARK_DONE_CMD('fact_maximia')}`,
  },
  {
    // Fusionada 08/09/2026 a pedido de Fernando: las 3 se hacían juntas de
    // todos modos ("en tandem, sin preguntar" — ver reference_maximia_tareas_mensuales),
    // no tenía sentido como 3 tarjetas separadas.
    id: 'maximia_tanda_inicio_mes', title: 'Tanda inicio de mes — Maximia (Siniestralidad + PSMA680 + FR116)', group: 'Maximia — tanda inicio de mes', day: 10, kind: 'auto',
    checklist: [
      'Siniestralidad Los Toldos + maestro SGC (Los Toldos, UBA, Tratayén, Casos 2026) + Indicadores AESA Punta Arena',
      'PSMA680-F03 Casa de Piedra',
      'FR 116 AST mensual RDA',
    ],
    autoPrompt: `Hacé la tanda de Maximia de inicio de mes — las 3 juntas, en tandem, sin preguntar:\n\n1. Siniestralidad Los Toldos: sacá los accidentes del mes de la API de MEOPP, cargá el maestro del SGC por Graph API (incluye las hojas Los Toldos, UBA, Tratayén y Casos 2026 — revisá las 4, no solo Los Toldos), generá el PDF con numeración correlativa (1.XX) y subilo a la carpeta de Cecilia en SharePoint junto con el certificado ART MEOPP y el contrato ART. De paso exportá la hoja "AESA (Punta Arena) 2026" a PDF (Indicadores AESA) y avisame para subirlo.\n2. PSMA680-F03 Casa de Piedra: armá el xlsx+pdf de accidentes del mes y subilo al OneDrive de Cecilia.\n3. FR 116 AST mensual RDA: creá la subcarpeta del mes nuevo en SharePoint (numeración correlativa), cambiá la celda A5 (FECHA: MM/YYYY) en las 5 pestañas de tareas del Excel del mes anterior, y subilo con el nombre correspondiente.\n\nOjo: Siniestralidad y PSMA680 cierran el MES ANTERIOR; FR 116 va con el MES EN CURSO.\n\nRecién cuando termines las 3, marcá la tarea como hecha:\n${MARK_DONE_CMD('maximia_tanda_inicio_mes')}`,
  },
  {
    // Sumada 08/09/2026 — hueco que Fernando notó ("no veo lo que subimos a
    // control doc de ferzep"). Doble carga (ControlDoc + SharePoint carpeta
    // 13), NO reemplazo — corregido el mismo día, ver memoria
    // project_ferzep_migracion_controldoc. Incluye el Estadístico Contratista
    // de FERZEP/Certronic, que es DISTINTO del "Estadístico Contratista
    // CPF-RDA (YPF)" de más abajo (mismo nombre, dos documentos distintos).
    id: 'ferzep_combo_controldoc', title: 'Combo mensual FERZEP (ControlDoc + carpeta 13)', group: 'Clientes FERZEP', day: 10, kind: 'auto',
    checklist: [
      'Seguro Vida Obligatorio MAPFRE',
      'Cláusula de No Repetición ART + Nómina',
      'ATS (Análisis de Trabajo Seguro)',
      'Visita de HyS',
      'Denuncias ante ART / Informe Siniestral ART',
      'Aportes Sindicales',
      'Capacitaciones SACDE (Anexo II) — cantidad variable, no siempre incluye Inducción',
      'Recibo de sueldo',
      'Estadístico Contratista FERZEP/Certronic (solo a SharePoint, no a ControlDoc)',
    ],
    autoPrompt: `Hacé la actualización documental mensual de FERZEP RAMALLO — se sube a LAS DOS partes, ControlDoc (gestion.controldoc.app, credenciales en reference_ferzep_controldoc_acceso) Y la carpeta 13 de SharePoint como siempre (no es reemplazo, es doble carga a propósito). Fijate primero si la carga a ControlDoc se puede hacer con el browser (agent-browser) o si hace falta que la haga yo a mano — no estaba confirmado la última vez que se probó.\n\nDocumentos del combo:\n1. Seguro Vida Obligatorio MAPFRE\n2. Cláusula de No Repetición ART + Nómina\n3. ATS (Análisis de Trabajo Seguro)\n4. Visita de HyS\n5. Denuncias ante ART / Informe Siniestral ART\n6. Aportes Sindicales\n7. Capacitaciones SACDE (Anexo II PRSMS-0005) — la cantidad varía cada mes, no metas "Inducción" si no correspondió\n8. Recibo de sueldo\n9. Estadístico Contratista de FERZEP/Certronic (el de "empresa/Estadistico Contratista/2026/" — ojo, es DISTINTO al Estadístico Contratista CPF-RDA de YPF, no los confundas) — este por ahora solo va a SharePoint, no a ControlDoc.\n\nNo mandes el mail de confirmación a Bárbara (controldocumental@maximia.com.ar) — está en pausa hasta nueva indicación.\n\nRecién cuando confirmes que los 9 quedaron subidos donde corresponde, marcá la tarea como hecha:\n${MARK_DONE_CMD('ferzep_combo_controldoc')}`,
  },
  {
    id: 'fiplasto', title: 'Documentación mensual Fiplasto', group: 'Clientes FERZEP', day: null, kind: 'insumo-propio',
    insumoNota: 'Necesita que mandes los PDFs del mes (ART, seguros, recibos, SOM).',
    autoPrompt: `Te quiero mandar la documentación mensual de Fiplasto (cert. ART + nómina, seguro de vida colectivo MAPFRE, seguro de accidentes personales, y si corresponde el pago sindical SOM). En los próximos mensajes te voy adjuntando lo que tengas — decime si falta algo. Cuando esté todo, subilo a la plataforma de proveedores de Fiplasto y avisá a RRHH por mail (mostrame el mail antes de mandarlo, como siempre).\n\nRecién cuando confirmes que quedó todo subido y el mail mandado, marcá la tarea como hecha:\n${MARK_DONE_CMD('fiplasto')}`,
  },
  { id: 'kpi_107_85', title: 'KPI FR 107-85', group: 'Maximia', day: null, kind: 'mantenido', insumoNota: 'En pausa — "hecho" acá significa actualizado localmente, no se envía a nadie hasta que lo pidan.' },
  {
    id: 'sueldos_ferzep', title: 'Sueldos FERZEP (recibos)', group: 'RRHH FERZEP', day: null, kind: 'insumo-propio',
    insumoNota: 'Necesita el Excel de empleados del mes.',
    autoPrompt: `Te quiero mandar el Excel de sueldos de este mes para generar los recibos. En el próximo mensaje te lo adjunto — fijate si hace falta bajar una escala nueva de som.org.ar antes de procesar. Cuando generes los recibos, mandámelos por Telegram.\n\nRecién cuando confirmes que los recibos quedaron generados y enviados, marcá la tarea como hecha:\n${MARK_DONE_CMD('sueldos_ferzep')}`,
  },
  { id: 'estadistico_contratista', title: 'Estadístico Contratista CPF-RDA (YPF)', group: 'Maximia', day: null, kind: 'insumo-terceros', insumoNota: 'Necesita la nómina de Macarena Schwindt — botón "Pedir nómina" abajo.' },
];

function currentPeriod(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function emptyState() {
  return {
    period: currentPeriod(),
    tasks: {}, // id -> { state: 'pendiente'|'esperando'|'hecho', doneAt, note }
    macarena: { lastRequestedAt: null, lastRequestEntryId: null, lastReplyAt: null, lastCheckedAt: null, threadEntryId: null },
    customTasks: [], // tareas recurrentes agregadas a mano desde "🎓 Aprender rutina nueva"
  };
}

function read() {
  let raw;
  try { raw = fs.readFileSync(AGENDA_FILE, 'utf8'); }
  catch { return emptyState(); }
  let data;
  try { data = JSON.parse(raw); }
  catch { return emptyState(); }
  // Reset automático el día 1: si el período guardado no es el actual,
  // vuelve todo a pendiente pero conserva el estado de Macarena y el catálogo
  // de tareas aprendidas (esas no son del mes, son permanentes hasta que las
  // borren a mano).
  if (data.period !== currentPeriod()) {
    const fresh = emptyState();
    fresh.macarena = data.macarena || fresh.macarena;
    fresh.customTasks = data.customTasks || fresh.customTasks;
    write(fresh);
    return fresh;
  }
  data.tasks = data.tasks || {};
  data.macarena = data.macarena || emptyState().macarena;
  data.customTasks = data.customTasks || [];
  return data;
}

function write(data) {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(AGENDA_FILE, JSON.stringify(data, null, 2));
}

// Catálogo fijo + lo que Fernando fue enseñando desde el botón "Aprender
// rutina nueva". Un solo lugar para buscar una tarea por id, sea de donde sea.
function allTasks(data) {
  return CATALOG.concat(data.customTasks || []);
}

// Agrega una rutina nueva al catálogo permanente. Se guarda en agenda.json
// (no en código) para no depender de un redeploy cada vez que aparece una
// tarea recurrente nueva — ver charla 07/09/2026, botón "🎓 Aprender rutina
// nueva". Solo para recurrentes (con o sin día fijo); puntuales quedan fuera
// de este catálogo, como se acordó.
function addCustomTask({ title, group, day, kind, insumoNota }) {
  const data = read();
  const id = 'custom_' + (title || 'tarea').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca tildes
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 40) + '_' + Date.now().toString(36);
  const task = {
    id,
    title: title || 'Tarea nueva',
    group: group || 'Aprendidas',
    day: (day === '' || day == null) ? null : Number(day),
    kind: kind || 'auto',
    insumoNota: insumoNota || '',
    learned: true, // distingue las aprendidas de las del catálogo semilla, por si hace falta filtrar
  };
  data.customTasks.push(task);
  write(data);
  return task;
}

function removeCustomTask(id) {
  const data = read();
  const before = data.customTasks.length;
  data.customTasks = data.customTasks.filter(t => t.id !== id);
  delete data.tasks[id];
  write(data);
  return data.customTasks.length !== before;
}

// Días de anticipación para el aviso "por vencer" (naranja) antes de que una
// tarea con día fijo pase a rojo — pedido de Fernando 08/09/2026: "debería
// cambiar de color... con días de anticipación así sé que tengo que entrar".
const DUE_SOON_DAYS = 3;

// Color del semáforo. 'esperando' (insumo de terceros en curso) es un estado
// aparte, no es lo mismo que "pendiente y vencido" — no es culpa de nadie que
// todavía no llegó. 'naranja' avisa ANTES de vencer, no reemplaza al rojo.
function colorFor(task, taskState, today = new Date()) {
  if (taskState.state === 'hecho') return 'verde';
  if (taskState.state === 'esperando') return 'esperando';
  if (task.day == null) return 'amarillo';
  const day = today.getDate();
  if (day > task.day) return 'rojo';
  if (task.day - day <= DUE_SOON_DAYS) return 'naranja';
  return 'amarillo';
}

function list() {
  const data = read();
  return allTasks(data).map(task => {
    const ts = data.tasks[task.id] || { state: 'pendiente', doneAt: null };
    return { ...task, ...ts, color: colorFor(task, ts) };
  });
}

function markDone(id, done = true) {
  const data = read();
  if (!allTasks(data).find(t => t.id === id)) return null;
  data.tasks[id] = { state: done ? 'hecho' : 'pendiente', doneAt: done ? Date.now() : null };
  write(data);
  return data.tasks[id];
}

function setWaiting(id) {
  const data = read();
  if (!allTasks(data).find(t => t.id === id)) return null;
  data.tasks[id] = { state: 'esperando', doneAt: null };
  write(data);
  return data.tasks[id];
}

function getMacarena() {
  return read().macarena;
}

function updateMacarena(patch) {
  const data = read();
  data.macarena = { ...data.macarena, ...patch };
  write(data);
  return data.macarena;
}

module.exports = { CATALOG, list, markDone, setWaiting, getMacarena, updateMacarena, addCustomTask, removeCustomTask, currentPeriod, AGENDA_FILE };
