#!/usr/bin/env node
// Publicación de sitios estáticos de los colaboradores, con aprobación de Diego.
//
//   pedir     (root, vía sudo /usr/local/bin/pedir-publicacion): el agente de una cuenta colab-*
//             pide publicar una carpeta. Se hace una COPIA de root (lo aprobado == lo publicado),
//             se guarda la solicitud y se avisa a Diego por Tron con un link.
//   servir    (usuario ccm-aprobar, 127.0.0.1:3950, detrás de Caddy en aprobar.controlapps.ar):
//             página donde Diego aprueba o rechaza. No ejecuta nada: solo escribe "aprobado".
//   publicar  (root, cron cada minuto): publica lo aprobado en /srv/sites/<nombre>, regenera
//             /etc/caddy/sitios.caddy, recarga Caddy y avisa. También vence solicitudes viejas.
//
// Se instala en /usr/local/lib/ccm-publicar/ (root:root). Copia versionada en el repo:
// si se cambia acá hay que reinstalarla en el VPS (ver instalar.sh).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawnSync } = require('child_process');

const BASE = process.env.CCM_PUB_BASE || '/var/lib/ccm-publicar';
const SOL = path.join(BASE, 'solicitudes');
const SITES = process.env.CCM_PUB_SITES || '/srv/sites';
const CADDY_MAIN = process.env.CCM_PUB_CADDYFILE || '/etc/caddy/Caddyfile';
const CADDY_SITIOS = process.env.CCM_PUB_CADDY || '/etc/caddy/sitios.caddy';
const TRON_ENV = '/etc/ccm/tron.env';
const DOMINIO = 'controlapps.ar';
const APROBAR_URL = `https://aprobar.${DOMINIO}`;
const GRUPO = 'ccm-aprobar';
const PUERTO = Number(process.env.PORT || 3950);

const VENCE_MS = 24 * 3600 * 1000;
const BORRAR_MS = 30 * 24 * 3600 * 1000;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVOS = 2000;
const MAX_PEDIDOS_HORA = 3;
const RESERVADOS = new Set([
  'www', 'aprobar', 'chat', 'test', 'delpo', 'wa', 'ventamat', 'coopermat', 'ferzep', 'ceb',
  'ceb-extractor', 'sala', 'asistente-ia', 'muss', 'clientes', 'mail', 'smtp', 'imap', 'ftp',
  'api', 'admin', 'app', 'jarvis', 'tron', 'elmer', 'cazador', 'games', 'auditoria', 'login',
  'webmail', 'zoho', 'autodiscover', 'status', 'soporte',
]);
const NOMBRE_ARCHIVO_PROHIBIDO = /(^\.env)|(\.pem$)|(\.key$)|(\.p12$)|(\.pfx$)|(^id_(rsa|ed25519|ecdsa))|(service-?account.*\.json$)|(^credentials)|(\.kdbx$)/i;
const PATRONES_CLAVE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{30,}/,
  /service_role/,
];

// ---------- utilidades puras (testeadas) ----------

function validarNombre(n) {
  if (typeof n !== 'string' || !/^[a-z0-9][a-z0-9-]{2,29}$/.test(n) || n.endsWith('-')) {
    return 'El nombre tiene que tener 3 a 30 caracteres: letras minúsculas, números y guiones (sin guión al final).';
  }
  if (RESERVADOS.has(n)) return `El nombre "${n}" está reservado.`;
  return null;
}

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function tokenValido(token, tokenHash) {
  if (typeof token !== 'string' || typeof tokenHash !== 'string') return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(tokenHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function limpiarTexto(s, max) {
  return String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function fmtFecha(ms) {
  return new Date(ms).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const urlSitio = (nombre) => `https://${nombre}.${DOMINIO}`;

// publicados: [{nombre, privado, user, hash}]
function bloquesCaddy(publicados) {
  const partes = ['# Generado por ccm-publicar.js. No editar a mano: se pisa en cada publicación.\n'];
  for (const p of publicados) {
    const lineas = [`${p.nombre}.${DOMINIO} {`, '\tencode gzip', `\troot * ${SITES}/${p.nombre}`];
    if (p.privado) {
      lineas.push('\tbasic_auth {', `\t\t${p.user} ${p.hash}`, '\t}', '\theader X-Robots-Tag "noindex, nofollow"');
    }
    lineas.push('\tfile_server', '}\n');
    partes.push(lineas.join('\n'));
  }
  return partes.join('\n');
}

function paginaHtml(titulo, cuerpo) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(titulo)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#1b1b1f;background:#f6f6f8}
h1{font-size:22px;margin:0 0 4px}.card{background:#fff;border-radius:12px;padding:16px;margin:14px 0;box-shadow:0 1px 3px #0002}
.k{color:#666;font-size:13px}.warn{background:#fff3cd;border:1px solid #e0a800;padding:10px;border-radius:8px;margin:10px 0}
.bad{background:#fde2e2;border:1px solid #c62828;padding:10px;border-radius:8px;margin:10px 0}
button{font-size:17px;padding:14px;border:0;border-radius:10px;width:100%;margin:6px 0;color:#fff}
.ok{background:#1b8a3a}.no{background:#b3261e}code{background:#eee;padding:1px 5px;border-radius:4px;word-break:break-all}
ul{padding-left:20px;margin:6px 0}li{font-size:14px;word-break:break-all}
</style></head><body>${cuerpo}</body></html>`;
}

function paginaSolicitud(meta, estado, accionUrl) {
  const lista = (meta.archivos || []).map((a) => `<li>${escapeHtml(a.ruta)} <span class="k">(${fmtBytes(a.bytes)})</span></li>`).join('');
  const mas = meta.totalArchivos > (meta.archivos || []).length ? `<li class="k">... y ${meta.totalArchivos - meta.archivos.length} más</li>` : '';
  const avisos = (meta.avisos || []).map((a) => `<div class="warn">${escapeHtml(a)}</div>`).join('');
  const acceso = meta.privado
    ? '<p>🔒 <b>Privado</b>: se publica con usuario y clave (la clave queda guardada en la cuenta de quien lo pide).</p>'
    : '<div class="bad"><b>PÚBLICO, SIN CLAVE</b>: cualquiera que tenga la dirección lo puede ver.</div>';
  let acciones;
  if (estado === 'pendiente') {
    acciones = `<form method="post" action="${escapeHtml(accionUrl)}">
<button class="ok" name="accion" value="aprobar">✅ Aprobar y publicar</button>
<button class="no" name="accion" value="rechazar">❌ Rechazar</button></form>`;
  } else {
    acciones = `<div class="warn">Esta solicitud ya está en estado: <b>${escapeHtml(estado)}</b>.</div>`;
  }
  return paginaHtml('Solicitud de publicación', `
<h1>Pedido de publicación</h1>
<div class="k">Pedido el ${fmtFecha(meta.creada)} · vence el ${fmtFecha(meta.creada + VENCE_MS)}</div>
<div class="card">
<p><b>${escapeHtml(meta.cuenta)}</b> quiere publicar:</p>
<p><code>${escapeHtml(urlSitio(meta.nombre))}</code></p>
<p>${escapeHtml(meta.descripcion)}</p>${acceso}${avisos}
<p class="k">${meta.totalArchivos} archivos · ${fmtBytes(meta.totalBytes)}${meta.reemplaza ? ' · <b>reemplaza un sitio ya publicado</b>' : ''}</p>
<ul>${lista}${mas}</ul></div>${acciones}`);
}

// ---------- sistema ----------

const hoyLog = () => new Date().toISOString();
function log(msg) {
  try { fs.appendFileSync('/var/log/ccm-publicar.log', `${hoyLog()} ${msg}\n`); } catch { /* sin log no se corta */ }
}

function leerEnv(file) {
  const out = {};
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function tron(texto) {
  let env;
  try { env = leerEnv(TRON_ENV); } catch { log('tron: no se pudo leer tron.env'); return false; }
  if (!env.TRON_TOKEN || !env.TRON_CHAT_IDS) return false;
  let ok = false;
  for (const chat of env.TRON_CHAT_IDS.split(',').map((s) => s.trim()).filter(Boolean)) {
    const r = spawnSync('curl', ['-sS', '-m', '15', '-K', '-',
      '--data-urlencode', `chat_id=${chat}`, '--data-urlencode', `text=${texto}`,
      '--data-urlencode', 'disable_web_page_preview=true'],
    { input: `url = "https://api.telegram.org/bot${env.TRON_TOKEN}/sendMessage"\n`, encoding: 'utf8' });
    if ((r.stdout || '').includes('"ok":true')) ok = true;
  }
  return ok;
}

function gidGrupo() {
  const r = spawnSync('getent', ['group', GRUPO], { encoding: 'utf8' });
  const g = Number((r.stdout || '').split(':')[2]);
  if (!Number.isInteger(g)) throw new Error(`Falta el grupo ${GRUPO}`);
  return g;
}

function homeDe(usuario) {
  const r = spawnSync('getent', ['passwd', usuario], { encoding: 'utf8' });
  return (r.stdout || '').split(':')[5] || null;
}

function listarSolicitudes() {
  if (!fs.existsSync(SOL)) return [];
  return fs.readdirSync(SOL).filter((id) => /^[0-9a-f]{12}$/.test(id)).map((id) => {
    try {
      const dir = path.join(SOL, id);
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      const estado = fs.readFileSync(path.join(dir, 'estado'), 'utf8').trim();
      return { id, dir, meta, estado };
    } catch { return null; }
  }).filter(Boolean);
}

function setEstado(s, nuevo) {
  fs.writeFileSync(path.join(s.dir, 'estado'), nuevo + '\n');
  s.estado = nuevo;
}

function recorrer(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(p, base, acc);
    else acc.push({ abs: p, ruta: path.relative(base, p), bytes: fs.statSync(p).size, tipo: e.isFile() ? 'f' : 'otro' });
  }
  return acc;
}

// ---------- pedir ----------

function pedir(args) {
  const quien = process.env.SUDO_USER || '';
  if (!/^(colab-[a-z0-9_-]+|claude)$/.test(quien)) fallar('Cuenta no autorizada para pedir publicaciones.');
  if (args[0] === 'estado') return estadoCmd(quien);

  const [nombre, carpeta, modo, ...resto] = args;
  const descripcion = limpiarTexto(resto.join(' '), 300);
  if (!nombre || !carpeta || !modo || !descripcion) {
    fallar('Uso: sudo pedir-publicacion <nombre> <carpeta> <privado|publico> "<qué es, en una frase>"\n     sudo pedir-publicacion estado');
  }
  const errNombre = validarNombre(nombre);
  if (errNombre) fallar(errNombre);
  if (modo !== 'privado' && modo !== 'publico') fallar('El tercer dato tiene que ser "privado" (con clave) o "publico".');

  fs.mkdirSync(SOL, { recursive: true });
  const todas = listarSolicitudes();
  const ahora = Date.now();
  if (todas.filter((s) => s.meta.cuenta === quien && ahora - s.meta.creada < 3600e3).length >= MAX_PEDIDOS_HORA) {
    fallar('Ya hiciste varios pedidos en la última hora. Esperá un rato.');
  }
  if (todas.some((s) => s.meta.nombre === nombre && s.estado === 'pendiente')) {
    fallar(`Ya hay un pedido pendiente para "${nombre}". Esperá a que Diego lo resuelva.`);
  }
  const previo = todas.filter((s) => s.meta.nombre === nombre && s.estado === 'publicado')
    .sort((a, b) => b.meta.creada - a.meta.creada)[0];
  if (previo && previo.meta.cuenta !== quien) fallar(`El nombre "${nombre}" ya lo usa otra cuenta.`);
  if (!previo) {
    let caddy = '';
    for (const f of [CADDY_MAIN, CADDY_SITIOS]) { try { caddy += fs.readFileSync(f, 'utf8'); } catch { /* */ } }
    if (new RegExp(`(^|[\\s,])${nombre}\\.${DOMINIO.replace('.', '\\.')}(\\s|,|\\{|$)`, 'm').test(caddy)) {
      fallar(`El nombre "${nombre}" ya está en uso por otro servicio.`);
    }
  }

  // carpeta: resuelta como el usuario, dentro de su home, nada oculto
  const home = homeDe(quien);
  if (!home) fallar('No se encontró la carpeta personal de la cuenta.');
  const rp = spawnSync('runuser', ['-u', quien, '--', 'realpath', '-e', carpeta], { encoding: 'utf8' });
  const real = (rp.stdout || '').trim();
  if (rp.status !== 0 || !real) fallar(`No existe la carpeta: ${carpeta}`);
  if (!real.startsWith(home + '/')) fallar('La carpeta tiene que estar dentro de tu carpeta personal.');
  if (real.slice(home.length + 1).split('/').some((p) => p.startsWith('.'))) fallar('No se pueden publicar carpetas ocultas.');
  const isDir = spawnSync('runuser', ['-u', quien, '--', 'test', '-d', real]);
  if (isDir.status !== 0) fallar('Eso no es una carpeta.');

  // empaquetar COMO EL USUARIO (solo lee lo que ese usuario puede leer); extraer como root con controles
  const tar = spawnSync('runuser', ['-u', quien, '--', 'tar', '-C', real, '--exclude=.git', '--exclude=node_modules', '-cf', '-', '.'],
    { maxBuffer: MAX_BYTES * 2 + (8 << 20) });
  if (tar.error || tar.status !== 0) fallar('No se pudo leer la carpeta (¿es muy grande o hay archivos sin permiso?).');
  if (tar.stdout.length > MAX_BYTES * 1.2) fallar(`La carpeta pesa demasiado (máximo ${fmtBytes(MAX_BYTES)}).`);

  const id = crypto.randomBytes(6).toString('hex');
  const token = crypto.randomBytes(32).toString('base64url');
  const dir = path.join(SOL, id);
  const tmpTar = path.join(BASE, `.tmp-${id}.tar`);
  fs.writeFileSync(tmpTar, tar.stdout, { mode: 0o600 });
  const limpiar = () => { fs.rmSync(tmpTar, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); };

  try {
    const lst = spawnSync('tar', ['-tvf', tmpTar], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const lineas = (lst.stdout || '').split('\n').filter(Boolean);
    if (lst.status !== 0 || lineas.some((l) => l[0] !== '-' && l[0] !== 'd')) {
      fallar('La carpeta tiene enlaces simbólicos o archivos especiales. Sacalos y volvé a pedir.');
    }
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const ex = spawnSync('tar', ['-xf', tmpTar, '-C', path.join(dir, 'src'), '--no-same-owner', '--no-same-permissions']);
    if (ex.status !== 0) fallar('No se pudo copiar la carpeta.');

    const archivos = recorrer(path.join(dir, 'src'));
    if (archivos.some((a) => a.tipo !== 'f')) fallar('La carpeta tiene archivos especiales.');
    if (archivos.length === 0) fallar('La carpeta está vacía.');
    if (archivos.length > MAX_ARCHIVOS) fallar(`Demasiados archivos (máximo ${MAX_ARCHIVOS}).`);
    const totalBytes = archivos.reduce((n, a) => n + a.bytes, 0);
    if (totalBytes > MAX_BYTES) fallar(`La carpeta pesa demasiado (máximo ${fmtBytes(MAX_BYTES)}).`);
    const prohibidos = archivos.filter((a) => NOMBRE_ARCHIVO_PROHIBIDO.test(path.basename(a.ruta))).map((a) => a.ruta);
    if (prohibidos.length) fallar(`No se puede publicar: hay archivos que parecen claves o secretos: ${prohibidos.slice(0, 5).join(', ')}. Sacalos de la carpeta y volvé a pedir.`);

    const avisos = [];
    if (!archivos.some((a) => a.ruta === 'index.html')) avisos.push('No tiene index.html en la raíz: la página principal va a dar error 404.');
    const sospechosos = [];
    for (const a of archivos) {
      if (a.bytes > 1 << 20 || !/\.(html?|js|mjs|css|json|txt|md|svg|xml|map)$/i.test(a.ruta)) continue;
      const txt = fs.readFileSync(a.abs, 'utf8');
      if (PATRONES_CLAVE.some((re) => re.test(txt))) sospechosos.push(a.ruta);
    }
    if (sospechosos.length) avisos.push(`Estos archivos tienen algo que parece una clave: ${sospechosos.slice(0, 5).join(', ')}. Revisá antes de aprobar.`);

    const meta = {
      id, cuenta: quien, nombre, privado: modo === 'privado', descripcion,
      creada: ahora, tokenHash: hashToken(token), reemplaza: Boolean(previo),
      totalArchivos: archivos.length, totalBytes,
      archivos: archivos.sort((a, b) => b.bytes - a.bytes).slice(0, 40).map((a) => ({ ruta: a.ruta, bytes: a.bytes })),
      avisos,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(dir, 'estado'), 'pendiente\n');
    const gid = gidGrupo();
    fs.chmodSync(dir, 0o750); fs.chownSync(dir, 0, gid);
    fs.chmodSync(path.join(dir, 'meta.json'), 0o640); fs.chownSync(path.join(dir, 'meta.json'), 0, gid);
    fs.chmodSync(path.join(dir, 'estado'), 0o660); fs.chownSync(path.join(dir, 'estado'), 0, gid);
    spawnSync('chown', ['-R', `root:${GRUPO}`, path.join(dir, 'src')]);
    spawnSync('chmod', ['-R', 'u=rwX,g=rX,o=', path.join(dir, 'src')]);

    const aviso = `📤 [${quien}] pide publicar "${nombre}" (${meta.privado ? 'con clave' : 'PÚBLICO sin clave'})\n`
      + `${descripcion}\n${archivos.length} archivos, ${fmtBytes(totalBytes)}${previo ? ' · reemplaza uno ya publicado' : ''}`
      + `${avisos.length ? '\n⚠️ ' + avisos.join('\n⚠️ ') : ''}\n\nRevisar y decidir (vence en 24 h):\n${APROBAR_URL}/a/${id}/${token}`;
    if (!tron(aviso)) fallar('No se pudo avisar a Diego. Probá de nuevo en un rato.');
    fs.rmSync(tmpTar, { force: true });
    log(`pedido ${id} cuenta=${quien} nombre=${nombre} privado=${meta.privado} archivos=${archivos.length}`);
    console.log(`Pedido enviado a Diego (id ${id}). TODAVÍA NO está publicado: hasta que él apruebe, ${urlSitio(nombre)} no existe.`);
    console.log('Para ver cómo va:  sudo pedir-publicacion estado');
  } catch (e) {
    limpiar();
    throw e;
  }
}

function estadoCmd(quien) {
  const mias = listarSolicitudes().filter((s) => s.meta.cuenta === quien).sort((a, b) => b.meta.creada - a.meta.creada).slice(0, 10);
  if (!mias.length) return console.log('No hay pedidos de publicación de esta cuenta.');
  for (const s of mias) {
    console.log(`${s.id}  ${s.meta.nombre}  ${s.estado}  ${fmtFecha(s.meta.creada)}${s.estado === 'publicado' ? '  ' + urlSitio(s.meta.nombre) : ''}`);
    if (s.estado === 'publicado' && s.meta.privado) console.log(`   usuario y clave: ${home2(quien)}/archivos/sitios/${s.meta.nombre}-acceso.txt`);
    if (s.estado.startsWith('error')) console.log(`   ${s.estado}`);
  }
}
const home2 = (u) => homeDe(u) || '~';

// ---------- servir (aprobación) ----------

function servir() {
  const fallos = new Map(); // ip -> [timestamps]
  const mal = (res) => { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(paginaHtml('No encontrado', '<h1>No encontrado</h1><p>El link no es válido o ya venció.</p>')); };
  const srv = http.createServer((req, res) => {
    const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
    const recientes = (fallos.get(ip) || []).filter((t) => Date.now() - t < 600e3);
    if (recientes.length >= 20) { res.writeHead(429); return res.end('Demasiados intentos'); }
    const m = (req.url || '').split('?')[0].match(/^\/a\/([0-9a-f]{12})\/([A-Za-z0-9_-]{43})$/);
    const rechazar = () => { fallos.set(ip, [...recientes, Date.now()]); mal(res); };
    if (!m) return rechazar();
    let s;
    try {
      const dir = path.join(SOL, m[1]);
      s = { dir, meta: JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')), estado: fs.readFileSync(path.join(dir, 'estado'), 'utf8').trim() };
    } catch { return rechazar(); }
    if (!tokenValido(m[2], s.meta.tokenHash)) return rechazar();

    const venció = Date.now() > s.meta.creada + VENCE_MS;
    const estadoVisible = venció && s.estado === 'pendiente' ? 'vencido' : s.estado;
    const cab = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' };

    if (req.method === 'GET') { res.writeHead(200, cab); return res.end(paginaSolicitud(s.meta, estadoVisible, req.url)); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      const accion = new URLSearchParams(body).get('accion');
      if (estadoVisible !== 'pendiente' || (accion !== 'aprobar' && accion !== 'rechazar')) {
        res.writeHead(200, cab); return res.end(paginaSolicitud(s.meta, estadoVisible, req.url));
      }
      const nuevo = accion === 'aprobar' ? 'aprobado' : 'rechazado';
      fs.writeFileSync(path.join(s.dir, 'estado'), nuevo + '\n');
      log(`decision ${m[1]} ${nuevo}`);
      res.writeHead(200, cab);
      res.end(paginaHtml('Listo', nuevo === 'aprobado'
        ? '<h1>✅ Aprobado</h1><p>Se publica en menos de un minuto. Te llega un aviso por Tron cuando esté listo.</p>'
        : '<h1>❌ Rechazado</h1><p>No se publica. Podés avisarle a la persona que lo pidió.</p>'));
    });
  });
  srv.listen(PUERTO, '127.0.0.1', () => console.log(`aprobar escuchando en 127.0.0.1:${PUERTO}`));
}

// ---------- publicar (root, cron) ----------

function regenerarCaddy(todas) {
  const vistos = new Set();
  const publicados = [];
  for (const s of todas.filter((x) => x.estado === 'publicado').sort((a, b) => b.meta.creada - a.meta.creada)) {
    if (vistos.has(s.meta.nombre)) continue;
    vistos.add(s.meta.nombre);
    let auth = null;
    if (s.meta.privado) {
      try { auth = JSON.parse(fs.readFileSync(path.join(s.dir, 'auth.json'), 'utf8')); } catch { continue; } // sin credenciales no se sirve abierto
    }
    publicados.push({ nombre: s.meta.nombre, privado: s.meta.privado, user: auth && auth.user, hash: auth && auth.hash });
  }
  const anterior = fs.existsSync(CADDY_SITIOS) ? fs.readFileSync(CADDY_SITIOS, 'utf8') : '';
  fs.writeFileSync(CADDY_SITIOS, bloquesCaddy(publicados));
  const v = spawnSync('caddy', ['validate', '--config', CADDY_MAIN, '--adapter', 'caddyfile'], { encoding: 'utf8' });
  if (v.status !== 0) {
    fs.writeFileSync(CADDY_SITIOS, anterior);
    throw new Error('Caddy rechazó la configuración: ' + (v.stderr || '').split('\n').slice(-3).join(' ').slice(0, 300));
  }
  const r = spawnSync('systemctl', ['reload', 'caddy'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('No se pudo recargar Caddy.');
}

function publicarUna(s, todas) {
  const { meta } = s;
  const errN = validarNombre(meta.nombre);
  if (errN) throw new Error(errN);
  const src = path.join(s.dir, 'src');
  if (!fs.existsSync(src)) throw new Error('Falta la copia de la carpeta.');
  fs.mkdirSync(SITES, { recursive: true, mode: 0o755 });
  const dest = path.join(SITES, meta.nombre);
  const nuevo = path.join(SITES, `.nuevo-${meta.nombre}`);
  const viejo = path.join(SITES, `.viejo-${meta.nombre}`);
  fs.rmSync(nuevo, { recursive: true, force: true });
  fs.rmSync(viejo, { recursive: true, force: true });
  fs.cpSync(src, nuevo, { recursive: true, verbatimSymlinks: true });
  spawnSync('chown', ['-R', 'root:root', nuevo]);
  spawnSync('chmod', ['-R', 'u=rwX,go=rX', nuevo]);

  let claveNueva = null;
  if (meta.privado) {
    const previo = todas.find((x) => x.estado === 'publicado' && x.meta.nombre === meta.nombre && x.meta.cuenta === meta.cuenta && x.id !== s.id && fs.existsSync(path.join(x.dir, 'auth.json')));
    if (previo) {
      fs.copyFileSync(path.join(previo.dir, 'auth.json'), path.join(s.dir, 'auth.json'));
    } else {
      claveNueva = crypto.randomBytes(12).toString('base64url');
      const h = spawnSync('caddy', ['hash-password', '--plaintext', claveNueva], { encoding: 'utf8' });
      if (h.status !== 0 || !h.stdout.trim().startsWith('$2')) throw new Error('No se pudo generar la clave.');
      fs.writeFileSync(path.join(s.dir, 'auth.json'), JSON.stringify({ user: meta.nombre, hash: h.stdout.trim() }), { mode: 0o600 });
    }
    fs.chmodSync(path.join(s.dir, 'auth.json'), 0o600); fs.chownSync(path.join(s.dir, 'auth.json'), 0, 0);
  }

  if (fs.existsSync(dest)) fs.renameSync(dest, viejo);
  fs.renameSync(nuevo, dest);
  fs.rmSync(viejo, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true }); // la copia ya está publicada
  return claveNueva;
}

function escribirAcceso(meta, clave) {
  const home = homeDe(meta.cuenta);
  if (!home) return null;
  const dir = path.join(home, 'archivos', 'sitios');
  spawnSync('runuser', ['-u', meta.cuenta, '--', 'mkdir', '-p', dir]);
  const f = path.join(dir, `${meta.nombre}-acceso.txt`);
  fs.writeFileSync(f, `Sitio: ${urlSitio(meta.nombre)}\nUsuario: ${meta.nombre}\nClave: ${clave}\n`, { mode: 0o600 });
  spawnSync('chown', [`${meta.cuenta}:`, f]);
  return f;
}

function publicar() {
  const todas = listarSolicitudes();
  const ahora = Date.now();
  let hayCambios = false;
  for (const s of todas) {
    if (s.estado === 'pendiente' && ahora > s.meta.creada + VENCE_MS) {
      setEstado(s, 'vencido'); fs.rmSync(path.join(s.dir, 'src'), { recursive: true, force: true });
      log(`vencio ${s.id} ${s.meta.nombre}`);
    } else if (s.estado === 'rechazado' && fs.existsSync(path.join(s.dir, 'src'))) {
      fs.rmSync(path.join(s.dir, 'src'), { recursive: true, force: true });
      log(`rechazado ${s.id} ${s.meta.nombre}`);
      tron(`❌ Rechazaste "${s.meta.nombre}" (${s.meta.cuenta}). No se publicó nada.`);
    } else if (s.estado === 'aprobado') {
      try {
        const clave = publicarUna(s, todas);
        setEstado(s, 'publicado'); hayCambios = true;
        s.meta.publicada = ahora;
        fs.writeFileSync(path.join(s.dir, 'meta.json'), JSON.stringify(s.meta, null, 2));
        let extra = '';
        if (clave) { const f = escribirAcceso(s.meta, clave); extra = f ? `\nUsuario y clave guardados en la cuenta de ${s.meta.cuenta}: ${f}` : ''; }
        log(`publicado ${s.id} ${s.meta.nombre}`);
        s.aviso = `✅ Publicado "${s.meta.nombre}": ${urlSitio(s.meta.nombre)}${s.meta.privado ? ' (con clave)' : ' (público)'}${extra}`;
      } catch (e) {
        setEstado(s, `error: ${String(e.message).slice(0, 200)}`);
        log(`error ${s.id} ${e.message}`);
        tron(`❌ Falló la publicación de "${s.meta.nombre}" (${s.meta.cuenta}): ${e.message}`);
      }
    } else if (s.estado !== 'publicado' && ahora > s.meta.creada + BORRAR_MS) {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }
  if (hayCambios) {
    try {
      regenerarCaddy(listarSolicitudes());
      for (const s of todas.filter((x) => x.aviso)) tron(s.aviso);
    } catch (e) {
      log(`error caddy ${e.message}`);
      for (const s of todas.filter((x) => x.aviso)) { setEstado(s, `error: ${e.message.slice(0, 150)}`); }
      tron(`❌ Se copiaron los archivos pero Caddy no pudo recargar: ${e.message}`);
    }
  }
}

// ---------- main ----------

function fallar(msg) {
  const e = new Error(msg); e.usuario = true; throw e;
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'pedir') pedir(args);
    else if (cmd === 'servir') servir();
    else if (cmd === 'publicar') publicar();
    else { console.error('Uso: ccm-publicar.js pedir|servir|publicar'); process.exit(2); }
  } catch (e) {
    console.error(e.usuario ? e.message : `Error interno: ${e.message}`);
    if (!e.usuario) log(`excepcion ${e.stack}`);
    process.exit(1);
  }
}

module.exports = { validarNombre, hashToken, tokenValido, limpiarTexto, bloquesCaddy, paginaSolicitud, escapeHtml, NOMBRE_ARCHIVO_PROHIBIDO, PATRONES_CLAVE };
if (require.main === module) main();
