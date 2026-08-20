// Corre UNA vez antes de toda la suite (ver playwright.config.js): siembra el
// HOME de prueba y levanta el server real una sola vez, en vez de un server
// nuevo por archivo de test — más rápido y evita pisarse puertos entre specs.
//
// process.env acá se hereda por los workers que Playwright levanta después
// (son procesos hijos del proceso que corre este setup), así que guardar acá
// la URL/HOME en variables de entorno es cómo cada spec se entera de contra
// qué server pegarle — ver test/e2e/helpers/env.js. globalTeardown puede
// correr en un proceso de Node DISTINTO al de este setup, así que lo que
// necesita para parar el server (pid) y limpiar (carpeta home) queda anotado
// en disco, no solo en memoria.
'use strict';
const fs = require('fs');
const path = require('path');
const { seedTempHome } = require('./helpers/temp-home');
const { startTestServer } = require('./helpers/server');

const STATE_FILE = path.join(__dirname, '.e2e-state.json');

module.exports = async function globalSetup() {
  const home = seedTempHome();
  const server = await startTestServer(home.dir);

  process.env.CCM_E2E_BASE_URL = server.baseURL;
  process.env.CCM_E2E_SESSION_ID = home.sessionId;
  process.env.CCM_E2E_SEARCH_TERM = home.searchTerm;

  fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: server.pid, homeDir: home.dir }));
};
