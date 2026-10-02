const { resolveByPin } = require('./slots');

function resolveIdentity(cookieValue, accessPin, slotsFile) {
  if (!cookieValue) return { kind: 'none' };
  if (accessPin && cookieValue === accessPin) return { kind: 'admin' };
  const slot = resolveByPin(cookieValue, slotsFile);
  if (slot) return { kind: 'slot', slot };
  return { kind: 'none' };
}

module.exports = { resolveIdentity };
