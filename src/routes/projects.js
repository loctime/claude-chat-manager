const express = require('express');
const meta = require('../meta');

// Lista de etiquetas de proyecto: unión de `data.projects` (registro
// persistido — existe apenas se crea, aunque todavía no haya ninguna
// conversación con esa etiqueta) + cualquier etiqueta que ya esté en uso en
// una conversación pero no esté en el registro (auto-adopción, cubre datos
// viejos o creados por otro cliente). El conteo sí se calcula al vuelo desde
// las conversaciones — eso no se persiste aparte.
//
// Cada entrada de data.projects puede venir en dos formas: un string pelado
// (formato viejo, de antes del 09/09) o {name, hideFromAll} (formato nuevo —
// ver hideFromAll más abajo). projectEntry() normaliza cualquiera de las dos
// a la forma objeto, así el resto del código no tiene que preguntar el tipo.
function projectEntry(p) {
  return typeof p === 'string' ? { name: p, hideFromAll: false } : p;
}

// Da de alta una etiqueta en el registro si todavía no está (comparación sin
// mayúsculas/minúsculas) — se llama cada vez que una conversación queda
// etiquetada con un proyecto, así el registro nunca queda desincronizado con
// lo que realmente se está usando, aunque el alta explícita por /api/projects
// se haya salteado (ej. un cliente viejo que solo mande `project` en el PATCH).
// hideFromAll solo se pisa si se pasa explícito (ej. el toggle al crear desde
// la UI) — el alta automática por etiquetar una conversación no lo toca, para
// no resetear sin querer un proyecto que alguien ya marcó oculto.
function registerProject(data, name, hideFromAll) {
  if (!name) return;
  if (!Array.isArray(data.projects)) data.projects = [];
  const idx = data.projects.findIndex(p => projectEntry(p).name.toLowerCase() === name.toLowerCase());
  if (idx === -1) {
    data.projects.push({ name, hideFromAll: !!hideFromAll });
  } else if (hideFromAll !== undefined) {
    data.projects[idx] = { name: projectEntry(data.projects[idx]).name, hideFromAll: !!hideFromAll };
  }
}

function projectsWithCounts(data) {
  const counts = new Map();
  for (const c of Object.values(data.conversations || {})) {
    if (c.hidden || !c.project) continue;
    counts.set(c.project, (counts.get(c.project) || 0) + 1);
  }
  const registered = new Map((data.projects || []).map(p => { const e = projectEntry(p); return [e.name, e.hideFromAll]; }));
  const names = new Set([...registered.keys(), ...counts.keys()]);
  return [...names]
    .map(name => ({ name, count: counts.get(name) || 0, hideFromAll: !!registered.get(name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

// Nombres de proyecto marcados hideFromAll=true — /api/tree los salta cuando
// se está mirando "Todos los proyectos" (sin filtro puesto). Filtrando
// específicamente por ESE proyecto sí se ven (ver ?project= más abajo).
function hiddenProjectNames(data) {
  return new Set((data.projects || []).filter(p => projectEntry(p).hideFromAll).map(p => projectEntry(p).name));
}

function createProjectsRouter({ getActiveAccount, accountMetaFile, listProjectFolderNames } = {}) {
  const router = express.Router();

  router.get('/projects', (req, res) => {
    const acc = req.query.account || (typeof getActiveAccount === 'function' ? getActiveAccount() : undefined);
    const data = meta.load(accountMetaFile(acc));
    res.json({ projects: projectsWithCounts(data) });
  });

  // Carpetas reales para el picker de "+ Nuevo proyecto…" (ver listProjectFolderNames).
  router.get('/project-folders', (req, res) => {
    const folders = typeof listProjectFolderNames === 'function' ? listProjectFolderNames() : [];
    res.json({ folders });
  });

  // Crea (o reactiva) una etiqueta de proyecto en el registro persistido, sin
  // necesidad de que ya exista una conversación con ese nombre — así "+ Nuevo
  // proyecto…" no desaparece la próxima vez que se abre el selector si todavía
  // no se etiquetó nada con él. hideFromAll (opcional): si viene true, ese
  // proyecto queda oculto de "Todos los proyectos" desde el arranque — ver
  // hiddenProjectNames()/registerProject() arriba.
  router.post('/projects', (req, res) => {
    const acc = req.body.account || (typeof getActiveAccount === 'function' ? getActiveAccount() : undefined);
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'nombre vacío' });
    const metaFile = accountMetaFile(acc);
    const data = meta.load(metaFile);
    registerProject(data, name, 'hideFromAll' in req.body ? !!req.body.hideFromAll : undefined);
    meta.save(data, metaFile);
    res.status(201).json({ projects: projectsWithCounts(data) });
  });

  // Saca un proyecto del registro (no desetiqueta conversaciones existentes —
  // esas mantienen la etiqueta vieja hasta que se reasignen a mano).
  router.delete('/projects/:name', (req, res) => {
    const acc = req.query.account || (typeof getActiveAccount === 'function' ? getActiveAccount() : undefined);
    const metaFile = accountMetaFile(acc);
    const data = meta.load(metaFile);
    data.projects = (data.projects || []).filter(p => projectEntry(p).name !== req.params.name);
    meta.save(data, metaFile);
    res.json({ projects: projectsWithCounts(data) });
  });

  return router;
}

module.exports = {
  projectEntry,
  registerProject,
  projectsWithCounts,
  hiddenProjectNames,
  createProjectsRouter,
};
