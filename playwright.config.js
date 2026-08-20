// Config de los tests e2e (test/e2e/) — separados de los unitarios rápidos de
// `npm test` (node --test, sin browser). Correr con `npm run test:e2e`.
'use strict';
const path = require('path');

module.exports = {
  testDir: path.join(__dirname, 'test', 'e2e'),
  testMatch: '*.spec.js',
  timeout: 30_000,
  // Un solo worker: todos los specs pegan al mismo server de prueba levantado
  // por global-setup.js (una sola instancia para toda la corrida) — correr en
  // paralelo pisaría estado entre tests (misma conversación fixture).
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  globalSetup: path.join(__dirname, 'test', 'e2e', 'global-setup.js'),
  globalTeardown: path.join(__dirname, 'test', 'e2e', 'global-teardown.js'),
  use: {
    headless: true,
    viewport: { width: 390, height: 844 }, // mobile (iPhone-ish): layout real que usa Diego
  },
};
