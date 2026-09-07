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
const CATALOG = [
  { id: 'fact_tgd_brucellaria', title: 'Facturar TGD + Brucellaria', group: 'Facturación', day: 5, kind: 'auto' },
  { id: 'fact_maximia', title: 'Facturar Maximia', group: 'Facturación', day: 22, kind: 'auto' },
  { id: 'maximia_siniestralidad', title: 'Siniestralidad Los Toldos + Indicadores AESA', group: 'Maximia — tanda inicio de mes', day: 10, kind: 'auto' },
  { id: 'maximia_psma680', title: 'PSMA680-F03 Casa de Piedra', group: 'Maximia — tanda inicio de mes', day: 10, kind: 'auto' },
  { id: 'maximia_fr116', title: 'FR 116 AST mensual RDA', group: 'Maximia — tanda inicio de mes', day: 10, kind: 'auto' },
  { id: 'fiplasto', title: 'Documentación mensual Fiplasto', group: 'Clientes FERZEP', day: null, kind: 'insumo-propio', insumoNota: 'Necesita que mandes los PDFs del mes (ART, seguros, recibos, SOM).' },
  { id: 'kpi_107_85', title: 'KPI FR 107-85', group: 'Maximia', day: null, kind: 'mantenido', insumoNota: 'En pausa — "hecho" acá significa actualizado localmente, no se envía a nadie hasta que lo pidan.' },
  { id: 'sueldos_ferzep', title: 'Sueldos FERZEP (recibos)', group: 'RRHH FERZEP', day: null, kind: 'insumo-propio', insumoNota: 'Necesita el Excel de empleados del mes.' },
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
  // vuelve todo a pendiente pero conserva el estado de Macarena (el hilo de
  // mail no "resetea" solo, sigue siendo el mismo hasta que se pida de nuevo).
  if (data.period !== currentPeriod()) {
    const fresh = emptyState();
    fresh.macarena = data.macarena || fresh.macarena;
    write(fresh);
    return fresh;
  }
  data.tasks = data.tasks || {};
  data.macarena = data.macarena || emptyState().macarena;
  return data;
}

function write(data) {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.writeFileSync(AGENDA_FILE, JSON.stringify(data, null, 2));
}

// Color del semáforo. 'esperando' (insumo de terceros en curso) es un estado
// aparte, no es lo mismo que "pendiente y vencido" — no es culpa de nadie que
// todavía no llegó.
function colorFor(task, taskState, today = new Date()) {
  if (taskState.state === 'hecho') return 'verde';
  if (taskState.state === 'esperando') return 'esperando';
  if (task.day == null) return 'amarillo';
  const day = today.getDate();
  return day > task.day ? 'rojo' : 'amarillo';
}

function list() {
  const data = read();
  return CATALOG.map(task => {
    const ts = data.tasks[task.id] || { state: 'pendiente', doneAt: null };
    return { ...task, ...ts, color: colorFor(task, ts) };
  });
}

function markDone(id, done = true) {
  const data = read();
  if (!CATALOG.find(t => t.id === id)) return null;
  data.tasks[id] = { state: done ? 'hecho' : 'pendiente', doneAt: done ? Date.now() : null };
  write(data);
  return data.tasks[id];
}

function setWaiting(id) {
  const data = read();
  if (!CATALOG.find(t => t.id === id)) return null;
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

module.exports = { CATALOG, list, markDone, setWaiting, getMacarena, updateMacarena, currentPeriod, AGENDA_FILE };
