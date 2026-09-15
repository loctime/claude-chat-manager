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
    // Ítems 9-11 sumados 09/09/2026 — Fernando notó que en la carpeta 13 de
    // SharePoint había subcarpetas propias (931, Estado de ARCA, monotributo)
    // que nunca habían entrado al checklist; se recorrió la carpeta 13
    // completa para no dejar nada más afuera (ver memoria
    // reference_ferzep_combo_items_931). "Alta Temprana ARCA" NO es mensual
    // (un solo alta, ya hecha) y "Estatuto"/"matricula"/"Constancia de
    // Acreditación Bancaria"/"cuenta bancaria"/"Plan de Contingencia"/"epo"/
    // "epp" tampoco — son de una vez o no le corresponden a este combo, se
    // dejaron afuera a propósito.
    // Ampliado 12/09/2026 con el detalle real de ControlDoc (reqIds, modelo
    // de períodos, distinción SVO vs "SVO con nómina") aprendido subiendo
    // todo el ciclo de agosto/septiembre a mano por API — ver
    // reference_ferzep_controldoc_acceso. Login API: POST identitytoolkit
    // accounts:signInWithPassword?key=AIzaSyA_WEH_HNDBV3bJfdDZxtLxQ2yZVFooC5c
    // con email/password de licvidalfernando@gmail.com → idToken. Subida:
    // POST controldoc-holding-backend.onrender.com/api/documentos multipart
    // (file, reqId, entidadTipo=empleado, entidadId=V6wYiM77pWvevDphNua1,
    // periodo=YYYY-MM o YYYY-S1/S2 si el requisito es periódico, fechaEmision
    // obligatoria) con headers Authorization Bearer + x-tenant: gestion. Si
    // ya hay un doc en ese campo da 409 con conflicto.id — reintentar con
    // ultimoIdVisto=<ese id>.
    id: 'ferzep_combo_controldoc', title: 'Combo mensual FERZEP (ControlDoc + carpeta 13)', group: 'Clientes FERZEP', day: 10, kind: 'auto',
    checklist: [
      'Seguro Vida Obligatorio MAPFRE — ControlDoc reqId 9e81dYuEVr3X6fSTvIwv (periódico mensual, NO confundir con el de abajo)',
      'Certificado ART + cláusula no repetición con Nómina — ControlDoc reqId fJ8XYWyFWSjGnA3YCYBu (periódico mensual)',
      'Certificado de cobertura SVO con Nómina — ControlDoc reqId 9u9trOKndA2Jqq6PhXM7 (periódico mensual, documento DISTINTO al SVO solo)',
      'ATS (Análisis de Trabajo Seguro)',
      'Visita de HyS',
      'Denuncias ante ART / Informe Siniestral ART',
      'Aportes Sindicales',
      'Capacitaciones SACDE (Anexo II) — cantidad variable, no siempre incluye Inducción',
      'Recibo de sueldo — ControlDoc reqId XFIkUTfNsiKuBra1M5SI (periódico mensual, del MES ANTERIOR — el de septiembre se sube recién en octubre)',
      'Estadístico Contratista FERZEP/Certronic (solo a SharePoint, no a ControlDoc)',
      'DDJJ F.931 + Nómina del Formulario 931 — SON DOS reqIds separados en ControlDoc (5u4TS4qOO5ksT9HDrLBF la DDJJ, LUkCv6rUqJ94pVuqSbRN la Nómina con apertura por empleado), ambos del mes ANTERIOR',
      'Estado de Cumplimiento ARCA (Aportes y contribuciones SS art. 80) — ControlDoc reqId 2KhQL3jxfhJsLhbsQDgH, NO periódico (documento acumulativo, se resube entero)',
      'Constancia de Inscripción en ARCA — ControlDoc reqId l1GUXgV4mTaoD0kdoTxr, se saca gratis en seti.afip.gob.ar/padron-puc-constancia-internet/ConsultaConstanciaAction.do con el CUIT de Fernando (20259251819) + captcha de texto (resolver con la propia visión, sin login), vence en 30 días — conviene resacarla cada mes junto con el resto del combo',
    ],
    autoPrompt: `Hacé la actualización documental mensual de FERZEP RAMALLO — se sube a LAS DOS partes, ControlDoc (gestion.controldoc.app, credenciales en reference_ferzep_controldoc_acceso) Y la carpeta 13 de SharePoint como siempre (no es reemplazo, es doble carga a propósito). La carga a ControlDoc se hace 100% por API/curl (login Firebase + POST multipart a /api/documentos), no hace falta browser — ver comentario arriba del reqId de cada ítem. Para los requisitos con periodicidad mensual/semestral, pasar el campo "periodo" (YYYY-MM o YYYY-S1/S2) además de fechaEmision (obligatorio) o el POST da 400.\n\nDocumentos del combo (12, con su reqId de ControlDoc donde aplica):\n1. Seguro Vida Obligatorio MAPFRE (reqId 9e81dYuEVr3X6fSTvIwv)\n2. Certificado ART + cláusula no repetición con Nómina (reqId fJ8XYWyFWSjGnA3YCYBu)\n3. Certificado de cobertura SVO con Nómina (reqId 9u9trOKndA2Jqq6PhXM7) — ojo, es un documento y reqId DISTINTO al ítem 1, aunque suene parecido\n4. ATS (Análisis de Trabajo Seguro)\n5. Visita de HyS\n6. Denuncias ante ART / Informe Siniestral ART\n7. Aportes Sindicales\n8. Capacitaciones SACDE (Anexo II PRSMS-0005) — la cantidad varía cada mes, no metas "Inducción" si no correspondió\n9. Recibo de sueldo (reqId XFIkUTfNsiKuBra1M5SI) — es el recibo firmado que Fernando manda por Telegram, del MES ANTERIOR\n10. Estadístico Contratista de FERZEP/Certronic (el de "empresa/Estadistico Contratista/2026/" — ojo, es DISTINTO al Estadístico Contratista CPF-RDA de YPF, no los confundas) — este por ahora solo va a SharePoint, no a ControlDoc.\n11. DDJJ F.931 (reqId 5u4TS4qOO5ksT9HDrLBF) + Nómina del Formulario 931 (reqId LUkCv6rUqJ94pVuqSbRN) — DOS documentos separados, ambos del MES ANTERIOR (ej. en septiembre se sube lo de agosto), carpeta "931/<año>/931 <mes> <año>" en SharePoint. El ACUSE de ARCA (presentación) y el VEP/TICKET PAGO también se guardan en esa carpeta local aunque no tengan reqId propio en ControlDoc.\n12. Estado de Cumplimiento ARCA (reqId 2KhQL3jxfhJsLhbsQDgH) — documento acumulativo, se resube entero cada mes con el rango actualizado, NO es periódico en ControlDoc (un solo campo que se versiona).\n13. Constancia de Inscripción en ARCA (reqId l1GUXgV4mTaoD0kdoTxr) — sacala de nuevo cada mes: entrá a https://seti.afip.gob.ar/padron-puc-constancia-internet/ConsultaConstanciaAction.do, CUIT 20259251819, resolvé el captcha de texto distorsionado con tu propia visión (screenshot del campo + leer), subí el PDF generado con page.pdf() del browser (viewport alto para que entre todo en 1-2 páginas).\n\nNo subir Monotributo ni Póliza/Comprobante de Accidentes Personales a este combo — Fernando confirmó 09/09/2026 que esos NO hace falta subirlos (si aparecen "Faltante" en ControlDoc, no es tarea nuestra resolverlos).\n\nNo mandes el mail de confirmación a Bárbara (controldocumental@maximia.com.ar) — está en pausa hasta nueva indicación.\n\nRecién cuando confirmes que los 13 quedaron subidos donde corresponde (SharePoint Y ControlDoc, salvo las excepciones marcadas), marcá la tarea como hecha:\n${MARK_DONE_CMD('ferzep_combo_controldoc')}`,
  },
  {
    // Card nueva 12/09/2026 — hasta acá esto vivía como un cron de Telegram
    // suelto de un solo disparo (se autoborraba), pero ControlDoc lo pide
    // como periódico MENSUAL desde que activaron el modelo nuevo de
    // requisitos — sin tarjeta fija se iba a volver a perder de vista el mes
    // que viene. ControlDoc reqId 1m1vySKiWagyVXJWyRs6.
    id: 'ferzep_deposito_bancario', title: 'Constancia de depósito bancario (BNA+)', group: 'Clientes FERZEP', day: 15, kind: 'insumo-propio',
    insumoNota: 'BNA+ está bloqueado para browser headless (Biocatch lo detecta) — hay que bajarlo desde el Chrome/BNA+ de Fernando a mano, avisar cuando el banco ya lo tenga disponible (no sale el mismo día del pago).',
    checklist: [
      'Constancia de Acreditación Bancaria del mes — comprobante BNA+ de la transferencia de haberes/retiro de socio',
    ],
    autoPrompt: `Fijate si ya está disponible en BNA+ la Constancia de Acreditación Bancaria del mes (comprobante de la transferencia de haberes de Fernando). Este trámite NO se puede hacer con el agent-browser headless — Biocatch lo bloquea, tiene que ser con el Chrome/sesión real de Fernando (Claude in Chrome) o Fernando lo baja él mismo y te lo manda. Una vez que lo tengas, subilo a ControlDoc con reqId 1m1vySKiWagyVXJWyRs6, entidadTipo empleado, periodo=YYYY-MM del mes que cubre, fechaEmision = fecha del comprobante (ver reference_ferzep_controldoc_acceso para el método de login+upload por API). Guardalo también en "actualizacion de ferzep/" por si hace falta después.\n\nRecién cuando confirmes que quedó subido, marcá la tarea como hecha:\n${MARK_DONE_CMD('ferzep_deposito_bancario')}`,
  },
  {
    // Checklist agregado 12/09/2026 — hasta acá la tarjeta era genérica sin
    // ítems, a diferencia del combo FERZEP. Se subió TODO el ciclo de
    // septiembre en esta misma sesión (login+upload confirmado por curl,
    // ver reference-fiplasto-flujo) y Fernando pidió que quedara listado acá
    // para no repreguntar el mes que viene, igual que el combo de ControlDoc.
    // Portal: fiplasto.com.ar/proveedores — login CUIT sin guiones
    // (30717190889) + contraseña = últimos 4 dígitos (0889). Categorías del
    // desplegable citadas TAL CUAL (el value exacto importa para el curl).
    id: 'fiplasto', title: 'Documentación mensual Fiplasto', group: 'Clientes FERZEP', day: 15, kind: 'insumo-propio',
    insumoNota: 'Necesita que mandes los PDFs del mes. Plazo: antes del día 15 (regla 09/09/2026).',
    checklist: [
      'Certificado de Cobertura ART con cláusula de no repetición a favor de Fiplasto SA (mes en curso)',
      'Seguro de Vida Colectivo MAPFRE (mes en curso)',
      'F.931 con apertura firmado — ACUSE+F931+Nómina en 1 PDF (mes ANTERIOR)',
      'Recibos de haberes — 1 PDF con todos (mes ANTERIOR, SIN el recibo de Fernando Vidal)',
      'Seguro de Accidentes Personales La Segunda — póliza + comprobante de pago',
      'Comprobante de pago Monotributo (mes en curso) — va en "Constancias de alta y bajas en AFIP", no hay categoría propia',
      'Libre de deuda sindical SOM — talón + comprobante Mercado Pago',
    ],
    autoPrompt: `Hacé la documentación mensual de Fiplasto — portal fiplasto.com.ar/proveedores, login por curl: POST php/control.php con cuit=30717190889&password=0889 (guarda cookie PHPSESSID), después POST subirdoc.php?cuit=30717190889 multipart con form=FERZEP RAMALLO, doc=<categoría exacta>, vto=YYYY-MM-DD, archivo=@doc.pdf, sube=Subir archivo. Éxito = la respuesta contiene "mensaje.php?sen=OK". No reintentar si "no se ve" confirmación — se duplica.\n\n7 documentos del mes (categorías exactas entre comillas):\n1. "Certificado de Cobertura de riesgos de Trabajo con cláusula de no repetición a favor de Fiplasto SA." — el mismo PDF certificado+nómina que se genera para ControlDoc/SharePoint, del mes EN CURSO.\n2. "Seguro de vida Colectivo" — MAPFRE del mes en curso.\n3. "Copia firmada de los comprobantes de pagos mensuales al sistema de la seguridad social (Formulario 931) con apertura" — del mes ANTERIOR, combinar ACUSE+F931+NOMINA en 1 solo PDF con pypdf.\n4. "Copias de recibos de haberes de cada trabajador" — del mes ANTERIOR, 1 solo PDF con TODOS los recibos EXCEPTO el de Fernando Vidal (regla fija, nunca se sube el de él).\n5. "Seguro de accidentes personales con cláusula de no repetición (monotributo y/o autónomo)" — póliza + comprobante de pago de La Segunda, fusionados en 1 PDF.\n6. "Constancias de alta y bajas en AFIP (Mi Simplificación)" — para el comprobante de pago de Monotributo del mes en curso (no hay categoría mejor, avisado a Oriana en su momento).\n7. "Constancia de registro y pago de cuotas sindicales u otras obligaciones de esa naturaleza. Libre de deuda sindical" — talón SOM + comprobante Mercado Pago que Fernando manda por Telegram.\n\nCada ítem del checklist se tilda individual con markItem, no todo junto — para que quede el detalle de qué se subió y cuándo.\n\nDespués de subir todo, armá el mail a RRHH (mpelemene@, omarilungo@, mmeza@ — todos @fiplasto.com.ar) avisando la carga y mostraselo a Fernando ANTES de mandarlo, sin excepción.\n\nRecién cuando confirmes que los 7 quedaron subidos y el mail mandado, marcá la tarea como hecha:\n${MARK_DONE_CMD('fiplasto')}`,
  },
  { id: 'kpi_107_85', title: 'KPI FR 107-85', group: 'Maximia', day: null, kind: 'mantenido', insumoNota: 'Regla permanente (09/09/2026): lo mantenemos activo y actualizado en la PC, pero no se manda a nadie hasta que Maximia lo pida — no es una pausa temporal, es la forma normal de trabajar esta tarea.' },
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
    const items = ts.items || {};
    // Checklist por ítem (pedido de Fernando 09/09/2026: "quiero que aparezca
    // en verde y el dia que lo hicimos, recibos de sueldo queda gris" — cada
    // línea del checklist tiene su propio estado/fecha, no solo la tarjeta
    // entera). Si la tarea no tiene checklist, checklistState queda null y el
    // front sigue mostrando el dot único de siempre.
    const checklistState = Array.isArray(task.checklist)
      ? task.checklist.map((text, i) => ({
          text,
          done: items[i] ? items[i].state === 'hecho' : false,
          doneAt: items[i] ? items[i].doneAt : null,
        }))
      : null;
    return { ...task, ...ts, checklistState, color: colorFor(task, ts) };
  });
}

function markDone(id, done = true) {
  const data = read();
  const task = allTasks(data).find(t => t.id === id);
  if (!task) return null;
  const doneAt = done ? Date.now() : null;
  const out = { state: done ? 'hecho' : 'pendiente', doneAt };
  // "Marcar hecho"/"Desmarcar" a mano sigue siendo un toggle en bloque: si la
  // tarea tiene checklist, tilda o destilda todos los ítems parejo con la
  // misma fecha, para que quede consistente con el estado por ítem.
  if (Array.isArray(task.checklist) && task.checklist.length) {
    const items = {};
    task.checklist.forEach((_, i) => { items[i] = { state: done ? 'hecho' : 'pendiente', doneAt }; });
    out.items = items;
  }
  data.tasks[id] = out;
  write(data);
  return data.tasks[id];
}

// Tilda/destilda UN ítem del checklist de una tarea. Si con eso quedan todos
// los ítems hechos, la tarjeta entera pasa a verde sola (con la fecha del
// último ítem cerrado); si falta alguno, la tarjeta vuelve a pendiente aunque
// antes se hubiera tildado a mano — no queda "hecho" a medias.
function markItem(id, itemIndex, done = true) {
  const data = read();
  const task = allTasks(data).find(t => t.id === id);
  if (!task || !Array.isArray(task.checklist) || !task.checklist[itemIndex]) return null;
  const prev = data.tasks[id] || { state: 'pendiente', doneAt: null };
  const items = { ...(prev.items || {}) };
  items[itemIndex] = { state: done ? 'hecho' : 'pendiente', doneAt: done ? Date.now() : null };
  const allDone = task.checklist.every((_, i) => items[i] && items[i].state === 'hecho');
  const doneAt = allDone
    ? Math.max(...task.checklist.map((_, i) => (items[i] && items[i].doneAt) || 0))
    : null;
  data.tasks[id] = { state: allDone ? 'hecho' : 'pendiente', doneAt, items };
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

module.exports = { CATALOG, list, markDone, markItem, setWaiting, getMacarena, updateMacarena, addCustomTask, removeCustomTask, currentPeriod, AGENDA_FILE };
