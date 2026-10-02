const { resolveByPin } = require('./slots');

function resolveIdentity(cookieValue, accessPin, slotsFile) {
  if (!cookieValue) return { kind: 'none' };
  if (accessPin && cookieValue === accessPin) return { kind: 'admin' };
  const slot = resolveByPin(cookieValue, slotsFile);
  if (slot) return { kind: 'slot', slot };
  return { kind: 'none' };
}

// Deny-by-default para una identidad de slot: una lista EXPLICITA de rutas
// permitidas, no una lista de bloqueadas. Sin esto, un PIN de colaborador
// (un solo factor, sin OTP) pasaba el portón general y quedaba con acceso a
// TODO Jarvis — cambiar de cuenta, leer cualquier conversacion admin,
// /api/restart, /api/cleanup, etc. (hallazgo de la revision final del plan
// docs/superpowers/plans/2026-10-02-slots-colaborador.md). Una ruta nueva
// que se agregue despues queda afuera de un slot por default, no al revez.
function isSlotAllowedPath(rawPath) {
  // El re-review de la tanda de fixes encontro que un path con ".." (crudo
  // o codificado como %2e%2e) matchea textualmente el startsWith de abajo
  // (la comparacion es sobre el string, no sobre el path ya resuelto), pero
  // express.static SI resuelve ".." antes de servir el archivo — asi que
  // /api/slot/%2e%2e/%2e%2e/app.js pasaba este chequeo y terminaba sirviendo
  // un archivo estatico fuera de lo permitido. Decodificar y rechazar
  // cualquier ".." de entrada cierra esto sin depender de como resuelva
  // cada capa mas abajo.
  let path;
  try { path = decodeURIComponent(rawPath); } catch { return false; }
  if (path.includes('..')) return false;
  if (path === '/slot.html' || path === '/slot.js') return true;
  // Con barra al final a proposito: distingue el singular /api/slot/* (lo
  // suyo) del plural /api/slots* (gestion de slots, exclusivo de admin) —
  // '/api/slots'.startsWith('/api/slot/') es false, '/api/slot/mensaje' es true.
  return path.startsWith('/api/slot/');
}

module.exports = { resolveIdentity, isSlotAllowedPath };
