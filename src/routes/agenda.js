const express = require('express');
const agenda = require('../agenda');
const outlookClassic = require('../outlook-classic');
const { runTaskScript } = require('../task-runner');

const router = express.Router();

// ── Agenda (semáforo de tareas recurrentes mensuales) ──
// Ver charla con Fernando 07/09/2026: catálogo fijo en agenda.js, el envío
// real de mails pasa por Outlook clásico vía COM/MAPI (outlook-classic.js,
// portado de maximia-mail-tasks) — sin Graph, sin Azure, sin SMTP. Esta
// sesión NUNCA aprieta "Enviar": arma el texto, lo muestra, y recién cuando
// el usuario confirma abre la ventana de Outlook para que la mande él mismo.
router.get('/', (req, res) => {
  res.json({ tasks: agenda.list(), macarena: agenda.getMacarena() });
});

router.post('/:id/done', (req, res) => {
  const done = req.body.done !== false;
  const result = agenda.markDone(req.params.id, done);
  if (!result) return res.status(404).json({ error: 'tarea no encontrada' });
  res.json(result);
});

// Tilde por ítem del checklist (pedido de Fernando 09/09/2026) — ver
// agenda.markItem. La tarjeta entera pasa a verde sola cuando están todos.
router.post('/:id/items/:index/done', (req, res) => {
  const done = req.body.done !== false;
  const index = Number(req.params.index);
  const result = agenda.markItem(req.params.id, index, done);
  if (!result) return res.status(404).json({ error: 'tarea o ítem no encontrado' });
  res.json(result);
});

// "🎓 Aprender rutina nueva" — Fernando enseña una tarea recurrente sin tocar
// código. Se guarda en agenda.json, no en el catálogo fijo (ver agenda.js).
router.post('/tasks', (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'falta el título' });
  const task = agenda.addCustomTask({
    title,
    group: (req.body.group || '').trim() || undefined,
    day: req.body.day,
    kind: req.body.kind,
    insumoNota: (req.body.insumoNota || '').trim() || undefined,
  });
  res.status(201).json(task);
});

router.delete('/tasks/:id', (req, res) => {
  const ok = agenda.removeCustomTask(req.params.id);
  if (!ok) return res.status(404).json({ error: 'tarea no encontrada' });
  res.json({ ok: true });
});

// Punto de entrada único para toda tarea determinística. El modo prueba se
// decide exclusivamente del lado del servidor: el cliente no puede saltearlo.
router.post('/:id/run', async (req, res) => {
  const task = agenda.list().find(candidate => candidate.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'tarea no encontrada' });
  if (task.execution !== 'script') return res.status(400).json({ error: 'esta tarea no se ejecuta por script' });
  try {
    const result = await runTaskScript(task, {
      state: agenda.getRunState(task.id),
      input: req.body ? req.body.input : undefined,
      dryRun: !task.verified,
    });
    const updated = agenda.saveRunResult(task.id, result);
    res.json({ ui: result.ui, runStatus: updated.run.status });
  } catch (err) {
    console.error(`[api/agenda/${task.id}/run]`, err.message);
    agenda.saveRunError(task.id, err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/verify', (req, res) => {
  const updated = agenda.setTaskVerified(req.params.id, true);
  if (!updated) return res.status(404).json({ error: 'tarea no encontrada o no es de tipo script' });
  res.json({ ok: true, verified: updated.verified });
});

router.post('/:id/reset-run', (req, res) => {
  const updated = agenda.resetRun(req.params.id);
  if (!updated) return res.status(404).json({ error: 'tarea no encontrada' });
  res.json({ ok: true });
});

const MACARENA_EMAIL = 'macarena.schwindt@maximia.com.ar';

function macarenaTemplateText() {
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const now = new Date();
  const mesActual = meses[now.getMonth()];
  return `Hola Maca, ¿cómo estás? Te pido si podés pasarme la nómina de personal actualizada por operación, para armar el estadístico de contratista de ${mesActual}.\n\nMuchas gracias!`;
}

// Busca el último mail de Maca en el hilo de nómina — sirve tanto para armar
// el "Preparar pedido" (reply-to) como para el chequeo de respuesta.
async function findMacarenaThread() {
  return outlookClassic.findLatest('30d', { fromContains: MACARENA_EMAIL, subjectContains: 'nomina' });
}

// Arma el texto propuesto y lo devuelve para que el usuario lo revise/edite
// en el front ANTES de tocar Outlook. No abre nada todavía.
router.post('/macarena/prepare', async (req, res) => {
  try {
    const last = await findMacarenaThread();
    res.json({
      entryId: last ? last.id : null,
      subject: last ? last.subject : null,
      receivedDateTime: last ? last.receivedDateTime : null,
      proposedText: macarenaTemplateText(),
      warning: last ? null : 'No encontré un mail previo de Maca en los últimos 30 días con "nomina" en el asunto — revisar a mano.',
    });
  } catch (err) {
    console.error('[api/agenda/macarena/prepare]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Recién acá se toca Outlook: abre la respuesta con el texto YA confirmado
// por el usuario, mostrada en la ventana de Outlook — no manda nada, el
// "Enviar" lo aprieta Fernando.
router.post('/macarena/send', async (req, res) => {
  const { entryId, text } = req.body;
  if (!entryId || !text) return res.status(400).json({ error: 'falta entryId o text' });
  try {
    await outlookClassic.openReplyDraft(entryId, text);
    const macarena = agenda.updateMacarena({ lastRequestedAt: Date.now(), lastRequestEntryId: entryId, threadEntryId: entryId, lastReplyAt: null });
    agenda.setWaiting('estadistico_contratista');
    res.json({ ok: true, macarena });
  } catch (err) {
    console.error('[api/agenda/macarena/send]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Chequeo liviano — sin LLM, solo lee Outlook por COM. Si hay un mail de
// Maca más nuevo que el último pedido, la tarea deja de estar "esperando".
router.post('/macarena/check', async (req, res) => {
  try {
    const macarena = agenda.getMacarena();
    const last = await findMacarenaThread();
    const replied = !!(last && macarena.lastRequestedAt && new Date(last.receivedDateTime).getTime() > macarena.lastRequestedAt);
    const updated = agenda.updateMacarena({
      lastCheckedAt: Date.now(),
      lastReplyAt: replied ? new Date(last.receivedDateTime).getTime() : macarena.lastReplyAt,
    });
    res.json({ replied, lastEntry: last, macarena: updated });
  } catch (err) {
    console.error('[api/agenda/macarena/check]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
