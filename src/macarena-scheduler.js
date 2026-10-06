// Automatiza el pedido mensual de nómina a Macarena Schwindt (para el
// Estadístico Contratista CPF-RDA, id 'estadistico_contratista' en
// agenda.js). Pedido explícito de Fernando 16/09/2026: quiere que el envío
// sea automático, sin que él apriete Enviar — excepción puntual y
// documentada a la regla general de "nunca mandar mail sin confirmación"
// (ver memoria project_cron_nomina_macarena y feedback_confirmar_quien_manda_mail).
//
// Reglas de fecha que dio Fernando el mismo día:
//   - Nunca mandar sábado ni domingo.
//   - Pedido mensual: día 30 (o el último día del mes si tiene menos). Si
//     ese día cae sábado o domingo, mandarlo el VIERNES anterior (no el
//     lunes siguiente).
//   - Si para el día 3 del mes siguiente Macarena no contestó, reclamar de
//     nuevo — pero SIEMPRE verificar primero que no haya contestado ya,
//     antes de mandar el reclamo. Mismo criterio de fin de semana.
//
// Reintenta sola si el proceso estuvo apagado el día exacto: en vez de
// comparar "es HOY el día", compara "ya pasó la fecha objetivo y todavía no
// se mandó este ciclo" — así no se pierde el mes si el servidor estaba caído.
const path = require('path');
const os = require('os');
const fs = require('fs');
const agenda = require('./agenda');
const outlookClassic = require('./outlook-classic');

const MACARENA_EMAIL = 'macarena.schwindt@maximia.com.ar';
const MACARENA_SUBJECT_NEW = 'Nómina de personal actualizada';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Estilo pedido por Fernando (16/09/2026): un solo signo de pregunta (sin el
// ¿ de apertura), y en el segundo mail (el de seguimiento) nunca usar la
// palabra "reclamo" — es solo el nombre interno que usamos nosotros para
// distinguirlo, no algo que tenga que leer Macarena.
function macarenaTemplateText({ reminder = false, forDate = new Date() } = {}) {
  const mesActual = MESES[forDate.getMonth()];
  if (reminder) {
    return `Hola Maca, cómo estás? Te molesto de nuevo porque no me llegó la nómina de personal actualizada por operación que te había pedido — me la podés pasar cuando tengas un rato? La necesito para armar el estadístico de contratista de ${mesActual}.\n\nMuchas gracias!`;
  }
  return `Hola Maca, cómo estás? Te pido si podés pasarme la nómina de personal actualizada por operación, para armar el estadístico de contratista de ${mesActual}.\n\nMuchas gracias!`;
}

async function findMacarenaThread() {
  return outlookClassic.findLatest('30d', { fromContains: MACARENA_EMAIL, subjectContains: 'nomina' });
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// Retrocede a viernes si cae sábado (6) o domingo (0) — nunca avanza.
function pullBackToFriday(date) {
  const day = date.getDay();
  if (day === 6) date.setDate(date.getDate() - 1);
  else if (day === 0) date.setDate(date.getDate() - 2);
  return date;
}

function requestTargetDate(year, monthIndex) {
  const day = Math.min(30, daysInMonth(year, monthIndex));
  return pullBackToFriday(new Date(year, monthIndex, day));
}

// El reclamo ("día 3") es del mes SIGUIENTE al del pedido.
function followupTargetDate(requestYear, requestMonthIndex) {
  const followMonthDate = new Date(requestYear, requestMonthIndex + 1, 1);
  const y = followMonthDate.getFullYear();
  const m = followMonthDate.getMonth();
  return pullBackToFriday(new Date(y, m, 3));
}

function cycleKey(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function notifyFernando(text) {
  try {
    const envPath = path.join(os.homedir(), '.claude', 'channels', 'telegram', '.env');
    const raw = await fs.promises.readFile(envPath, 'utf8');
    const match = raw.match(/TELEGRAM_BOT_TOKEN=(.+)/);
    const token = match && match[1].trim();
    if (!token) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: '5027660294', text }),
    });
  } catch (err) {
    console.error('[macarena-scheduler] no pude avisar por Telegram:', err.message);
  }
}

async function sendMonthlyRequest(cycle, forDate) {
  const last = await findMacarenaThread();
  const bodyText = macarenaTemplateText({ forDate });
  await outlookClassic.sendReply({
    entryId: last ? last.id : null,
    to: last ? null : MACARENA_EMAIL,
    subject: last ? null : MACARENA_SUBJECT_NEW,
    bodyText,
  });
  agenda.updateMacarena({
    lastRequestedAt: Date.now(),
    lastRequestEntryId: last ? last.id : null,
    threadEntryId: last ? last.id : null,
    lastReplyAt: null,
    requestedForCycle: cycle,
    followupForCycle: null,
  });
  agenda.setWaiting('estadistico_contratista');
  await notifyFernando(`📋 Le pedí a Macarena la nómina de personal (ciclo ${cycle}) — mail automático enviado.`);
}

async function checkAndFollowUp(cycle) {
  const macarena = agenda.getMacarena();
  const last = await findMacarenaThread();
  const replied = !!(last && macarena.lastRequestedAt && new Date(last.receivedDateTime).getTime() > macarena.lastRequestedAt);
  if (replied) {
    agenda.updateMacarena({ lastReplyAt: new Date(last.receivedDateTime).getTime(), followupForCycle: cycle });
    await notifyFernando(`✅ Macarena ya había contestado la nómina de ${cycle} — no hizo falta reclamar.`);
    return;
  }
  const entryId = macarena.threadEntryId || (last ? last.id : null);
  const bodyText = macarenaTemplateText({ reminder: true });
  await outlookClassic.sendReply({
    entryId,
    to: entryId ? null : MACARENA_EMAIL,
    subject: entryId ? null : MACARENA_SUBJECT_NEW,
    bodyText,
  });
  agenda.updateMacarena({ lastRequestedAt: Date.now(), followupForCycle: cycle });
  await notifyFernando(`📋 Macarena no había contestado la nómina de ${cycle} — le reenvié el pedido.`);
}

// Pausa manual pedida por Fernando (03/10/2026, ya había escrito él mismo a
// Macarena y no quiere que la automatización también le mande/reclame). Crear
// PAUSE_FLAG_FILE desactiva el poll entero hasta que se borre el archivo.
const PAUSE_FLAG_FILE = path.join(__dirname, '..', '.macarena-paused');
function isPaused() {
  return fs.existsSync(PAUSE_FLAG_FILE);
}

// Poll idempotente: seguro de llamar cada tanto, solo actúa una vez por
// ciclo gracias a requestedForCycle/followupForCycle guardados en agenda.json.
async function checkMacarenaSchedule(now = new Date()) {
  if (isPaused()) return;
  const today = startOfDay(now);
  const y = now.getFullYear();
  const m = now.getMonth();

  try {
    const thisCycle = cycleKey(y, m);
    const reqTarget = startOfDay(requestTargetDate(y, m));
    const macarena = agenda.getMacarena();
    if (today >= reqTarget && macarena.requestedForCycle !== thisCycle) {
      await sendMonthlyRequest(thisCycle, now);
    }
  } catch (err) {
    console.error('[macarena-scheduler] error mandando el pedido mensual:', err.message);
    await notifyFernando(`⚠️ Fallé mandando el pedido automático de nómina a Macarena: ${err.message}`);
  }

  try {
    const prevMonthDate = new Date(y, m - 1, 1);
    const py = prevMonthDate.getFullYear();
    const pm = prevMonthDate.getMonth();
    const prevCycle = cycleKey(py, pm);
    const followTarget = startOfDay(followupTargetDate(py, pm));
    const macarena = agenda.getMacarena();
    if (today >= followTarget && macarena.requestedForCycle === prevCycle && macarena.followupForCycle !== prevCycle) {
      await checkAndFollowUp(prevCycle);
    }
  } catch (err) {
    console.error('[macarena-scheduler] error en el reclamo de seguimiento:', err.message);
    await notifyFernando(`⚠️ Fallé chequeando/reclamando la nómina a Macarena: ${err.message}`);
  }
}

module.exports = {
  MACARENA_EMAIL,
  macarenaTemplateText,
  findMacarenaThread,
  checkMacarenaSchedule,
};
