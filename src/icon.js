const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Genera los íconos de la PWA (círculo de color sobre el fondo oscuro fijo)
// vía ImageMagick, con el color de identidad elegido en Configuración.
// Separado de server.js para poder testear la lógica pura (validación de
// color, armado de comando) sin depender de tener ImageMagick instalado.

const BG = '#0b141a'; // mismo fondo que el icon-192/512.png original
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isValidColor(color) {
  return HEX_RE.test(color || '');
}

// Círculo centrado, radio ~0.251 del lado — mismo diseño que el ícono
// original, medido con `magick icon-512.png -trim info:` sobre el archivo
// fuente: círculo de 257px de diámetro sobre un lienzo de 512px, centrado.
function circleDrawArgs(size, color) {
  const c = Math.round(size / 2);
  const r = Math.round(size * 0.251);
  return ['-size', `${size}x${size}`, `xc:${BG}`, '-fill', color, '-draw', `circle ${c},${c} ${c},${c - r}`];
}

function iconFileName(size) {
  return `icon-${size}.png`;
}

// Regenera los dos tamaños de ícono con el color dado, en cacheDir. Sync
// porque solo corre al guardar la config (no en el hot path de requests) y
// son comandos rápidos. `exec` es inyectable para poder testear sin invocar
// ImageMagick de verdad.
function regenerateIcons(color, cacheDir, opts = {}) {
  const { magickCmd = 'magick', magickArgs = a => a, sizes = [192, 512], exec = execFileSync } = opts;
  if (!isValidColor(color)) throw new Error('color inválido, esperado formato #rrggbb');
  fs.mkdirSync(cacheDir, { recursive: true });
  const files = [];
  for (const size of sizes) {
    const out = path.join(cacheDir, iconFileName(size));
    exec(magickCmd, magickArgs([...circleDrawArgs(size, color), out]));
    files.push(out);
  }
  return files;
}

module.exports = { isValidColor, circleDrawArgs, iconFileName, regenerateIcons, BG };
