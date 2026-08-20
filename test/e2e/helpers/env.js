// Datos que global-setup.js deja en process.env para que cada spec sepa
// contra qué server pegarle y qué buscar en el fixture — ver global-setup.js.
'use strict';
function e2eEnv() {
  const baseURL = process.env.CCM_E2E_BASE_URL;
  if (!baseURL) throw new Error('CCM_E2E_BASE_URL no está seteado — ¿corriste esto con `npm run test:e2e` (Playwright), no directo?');
  return {
    baseURL,
    sessionId: process.env.CCM_E2E_SESSION_ID,
    searchTerm: process.env.CCM_E2E_SEARCH_TERM,
  };
}
module.exports = { e2eEnv };
