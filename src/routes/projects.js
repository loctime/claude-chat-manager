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
  if (typeof p === 'string') return { name: p, hideFromAll: false };
  const entry = {
    name: p.name,
    hideFromAll: !!p.hideFromAll,
  };
  if (Array.isArray(p.folders) && p.folders.length) entry.folders = p.folders;
  return entry;
}

function folderBaseName(p) {
  if (!p) return '';
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

// Da de alta una etiqueta en el registro si todavía no está (comparación sin
// mayúsculas/minúsculas) — se llama cada vez que una conversación queda
// etiquetada con un proyecto, así el registro nunca queda desincronizado con
// lo que realmente se está usando, aunque el alta explícita por /api/projects
// se haya salteado (ej. un cliente viejo que solo mande `project` en el PATCH).
// hideFromAll solo se pisa si se pasa explícito (ej. el toggle al crear desde
// la UI) — el alta automática por etiquetar una conversación no lo toca, para
// no resetear sin querer un proyecto que alguien ya marcó oculto.
function registerProject(data, name, hideFromAll, folders) {
  if (!name) return;
  if (!Array.isArray(data.projects)) data.projects = [];
  const idx = data.projects.findIndex(p => projectEntry(p).name.toLowerCase() === name.toLowerCase());
  const normFolders = Array.isArray(folders) ? folders.map(f => String(f).trim()).filter(Boolean) : undefined;
  if (idx === -1) {
    const entry = { name, hideFromAll: !!hideFromAll };
    if (normFolders && normFolders.length) entry.folders = normFolders;
    data.projects.push(entry);
  } else {
    const current = projectEntry(data.projects[idx]);
    const resolvedHide = hideFromAll !== undefined ? !!hideFromAll : current.hideFromAll;
    const resolvedFolders = normFolders !== undefined ? normFolders : current.folders;
    const entry = { name: current.name, hideFromAll: resolvedHide };
    if (resolvedFolders && resolvedFolders.length) entry.folders = resolvedFolders;
    data.projects[idx] = entry;
  }
}

function projectsWithCounts(data, extraDataList = []) {
  const counts = new Map();
  for (const c of Object.values(data.conversations || {})) {
    if (c.hidden || !c.project) continue;
    counts.set(c.project, (counts.get(c.project) || 0) + 1);
  }
  for (const extra of extraDataList) {
    if (!extra) continue;
    for (const c of Object.values(extra.conversations || {})) {
      if (c.hidden || !c.project) continue;
      counts.set(c.project, (counts.get(c.project) || 0) + 1);
    }
  }
  const registered = new Map((data.projects || []).map(p => {
    const e = projectEntry(p);
    return [e.name, { hideFromAll: e.hideFromAll, folders: e.folders }];
  }));
  const names = new Set([...registered.keys(), ...counts.keys()]);
  return [...names]
    .map(name => {
      const reg = registered.get(name);
      const res = {
        name,
        count: counts.get(name) || 0,
        hideFromAll: reg ? !!reg.hideFromAll : false,
      };
      if (reg && reg.folders && reg.folders.length) res.folders = reg.folders;
      return res;
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

// Nombres de proyecto marcados hideFromAll=true — /api/tree los salta cuando
// se está mirando "Todos los proyectos" (sin filtro puesto). Filtrando
// específicamente por ESE proyecto sí se ven (ver ?project= más abajo).
function hiddenProjectNames(data) {
  return new Set((data.projects || []).filter(p => projectEntry(p).hideFromAll).map(p => projectEntry(p).name));
}

function renameProject(data, extraDataList = [], oldName, newName, hideFromAll) {
  if (!oldName) return false;
  const oldLower = oldName.toLowerCase();
  const targetName = (newName || '').trim();
  if (!targetName) return false;
  const targetLower = targetName.toLowerCase();

  // 1. Actualizar en data.projects
  if (!Array.isArray(data.projects)) data.projects = [];
  const oldIdx = data.projects.findIndex(p => projectEntry(p).name.toLowerCase() === oldLower);
  let resolvedHide = hideFromAll !== undefined ? !!hideFromAll : undefined;

  if (oldIdx !== -1) {
    const oldEntry = projectEntry(data.projects[oldIdx]);
    if (resolvedHide === undefined) resolvedHide = oldEntry.hideFromAll;
    const oldFolders = oldEntry.folders;
    if (oldLower !== targetLower) {
      const newIdx = data.projects.findIndex(p => projectEntry(p).name.toLowerCase() === targetLower);
      if (newIdx !== -1) {
        const targetEntry = projectEntry(data.projects[newIdx]);
        const mergedFolders = [...new Set([...(targetEntry.folders || []), ...(oldFolders || [])])];
        const updated = {
          name: targetEntry.name,
          hideFromAll: resolvedHide || targetEntry.hideFromAll,
        };
        if (mergedFolders.length) updated.folders = mergedFolders;
        data.projects[newIdx] = updated;
        data.projects.splice(oldIdx, 1);
      } else {
        const entry = { name: targetName, hideFromAll: !!resolvedHide };
        if (oldFolders && oldFolders.length) entry.folders = oldFolders;
        data.projects[oldIdx] = entry;
      }
    } else {
      const entry = { name: targetName, hideFromAll: !!resolvedHide };
      if (oldFolders && oldFolders.length) entry.folders = oldFolders;
      data.projects[oldIdx] = entry;
    }
  } else {
    registerProject(data, targetName, resolvedHide);
  }

  // 2. Renombrar en data.conversations si el nombre cambió
  if (oldName !== targetName) {
    for (const c of Object.values(data.conversations || {})) {
      if (c && c.project && c.project.toLowerCase() === oldLower) {
        c.project = targetName;
      }
    }
    // 3. Renombrar en extraDataList (Codex, AgY)
    for (const extra of extraDataList) {
      if (!extra) continue;
      for (const c of Object.values(extra.conversations || {})) {
        if (c && c.project && c.project.toLowerCase() === oldLower) {
          c.project = targetName;
        }
      }
    }
  }
  return true;
}

function deleteProject(data, extraDataList = [], name) {
  if (!name) return false;
  const lower = name.toLowerCase();

  // 1. Quitar de data.projects
  if (Array.isArray(data.projects)) {
    data.projects = data.projects.filter(p => projectEntry(p).name.toLowerCase() !== lower);
  }

  // 2. Desetiquetar en data.conversations
  for (const c of Object.values(data.conversations || {})) {
    if (c && c.project && c.project.toLowerCase() === lower) {
      delete c.project;
    }
  }

  // 3. Desetiquetar en extraDataList (Codex, AgY)
  for (const extra of extraDataList) {
    if (!extra) continue;
    for (const c of Object.values(extra.conversations || {})) {
      if (c && c.project && c.project.toLowerCase() === lower) {
        delete c.project;
      }
    }
  }
  return true;
}

function createProjectsRouter({ getActiveAccount, accountMetaFile, listProjectFolderNames, getExtraMetaFiles } = {}) {
  const router = express.Router();

  function loadExtraDataWithFiles() {
    const extraFiles = typeof getExtraMetaFiles === 'function' ? getExtraMetaFiles() : [];
    return (extraFiles || []).map(f => {
      try { return { file: f, data: meta.load(f) }; } catch { return null; }
    }).filter(Boolean);
  }

  router.get('/projects', (req, res) => {
    const acc = req.query.account || (typeof getActiveAccount === 'function' ? getActiveAccount() : undefined);
    const data = meta.load(accountMetaFile(acc));
    const extraItems = loadExtraDataWithFiles();
    res.json({ projects: projectsWithCounts(data, extraItems.map(e => e.data)) });
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
    const folders = Array.isArray(req.body.folders) ? req.body.folders : [];
    registerProject(data, name, 'hideFromAll' in req.body ? !!req.body.hideFromAll : undefined, folders);

    const extraItems = loadExtraDataWithFiles();

    // Si se especificaron carpetas, auto-etiquetar conversaciones existentes
    // que coincidan con esas carpetas y no tengan proyecto asignado todavía
    if (folders.length > 0) {
      const folderSet = new Set(folders.map(f => folderBaseName(f).toLowerCase()).filter(Boolean));
      if (folderSet.size > 0) {
        for (const c of Object.values(data.conversations || {})) {
          if (!c || c.hidden || c.project) continue;
          const fb = folderBaseName(c.projectDir || c.gitRepo).toLowerCase();
          if (fb && folderSet.has(fb)) {
            c.project = name;
          }
        }
        for (const item of extraItems) {
          let changed = false;
          for (const c of Object.values(item.data.conversations || {})) {
            if (!c || c.hidden || c.project) continue;
            const fb = folderBaseName(c.projectDir || c.gitRepo || c.workspace).toLowerCase();
            if (fb && folderSet.has(fb)) {
              c.project = name;
              changed = true;
            }
          }
          if (changed) {
            try { meta.save(item.data, item.file); } catch {}
          }
        }
      }
    }

    meta.save(data, metaFile);
    res.status(201).json({ projects: projectsWithCounts(data, extraItems.map(e => e.data)) });
  });

  // Renombra un proyecto existente o actualiza su visibilidad (hideFromAll).
  // Actualiza tanto el registro central como las etiquetas de las conversaciones
  // de Claude, Codex y AgY.
  router.patch('/projects/:name', (req, res) => {
    const acc = req.body.account || req.query.account || (typeof getActiveAccount === 'function' ? getActiveAccount() : undefined);
    const oldName = req.params.name;
    const newName = req.body.newName ? req.body.newName.trim() : (req.body.name ? req.body.name.trim() : oldName);
    if (!newName) return res.status(400).json({ error: 'nombre vacío' });

    const metaFile = accountMetaFile(acc);
    const data = meta.load(metaFile);
    const extraItems = loadExtraDataWithFiles();

    renameProject(
      data,
      extraItems.map(e => e.data),
      oldName,
      newName,
      'hideFromAll' in req.body ? !!req.body.hideFromAll : undefined
    );

    meta.save(data, metaFile);
    for (const item of extraItems) {
      try { meta.save(item.data, item.file); } catch {}
    }

    res.json({ ok: true, name: newName, projects: projectsWithCounts(data, extraItems.map(e => e.data)) });
  });

  // Saca un proyecto del registro y desetiqueta todas las conversaciones asociadas
  // (Claude, Codex y AgY) dejándolas "Sin proyecto".
  router.delete('/projects/:name', (req, res) => {
    const acc = req.query.account || (typeof getActiveAccount === 'function' ? getActiveAccount() : undefined);
    const name = req.params.name;
    const metaFile = accountMetaFile(acc);
    const data = meta.load(metaFile);
    const extraItems = loadExtraDataWithFiles();

    deleteProject(data, extraItems.map(e => e.data), name);

    meta.save(data, metaFile);
    for (const item of extraItems) {
      try { meta.save(item.data, item.file); } catch {}
    }

    res.json({ ok: true, projects: projectsWithCounts(data, extraItems.map(e => e.data)) });
  });

  return router;
}

module.exports = {
  projectEntry,
  folderBaseName,
  registerProject,
  projectsWithCounts,
  hiddenProjectNames,
  renameProject,
  deleteProject,
  createProjectsRouter,
};
