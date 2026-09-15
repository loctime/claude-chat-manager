const test = require('node:test');
const assert = require('node:assert');
const {
  projectEntry,
  registerProject,
  projectsWithCounts,
  hiddenProjectNames,
  renameProject,
  deleteProject,
} = require('../src/routes/projects');

test('projectEntry normaliza strings a objetos con hideFromAll false', () => {
  assert.deepEqual(projectEntry('ControlRedes'), { name: 'ControlRedes', hideFromAll: false });
  assert.deepEqual(projectEntry({ name: 'Salas', hideFromAll: true }), { name: 'Salas', hideFromAll: true });
});

test('registerProject da de alta si no existe sin duplicar por mayúsculas', () => {
  const data = { projects: [] };
  registerProject(data, 'ControlRedes');
  assert.equal(data.projects.length, 1);
  assert.equal(data.projects[0].name, 'ControlRedes');
  assert.equal(data.projects[0].hideFromAll, false);

  // Intentar agregar con diferente casing
  registerProject(data, 'controlredes');
  assert.equal(data.projects.length, 1);

  // Actualizar hideFromAll si se especifica
  registerProject(data, 'ControlRedes', true);
  assert.equal(data.projects.length, 1);
  assert.equal(data.projects[0].hideFromAll, true);
});

test('projectsWithCounts calcula correctamente los conteos y respeta registrados', () => {
  const data = {
    projects: [
      { name: 'Alpha', hideFromAll: false },
      { name: 'Beta', hideFromAll: true },
    ],
    conversations: {
      c1: { project: 'Alpha' },
      c2: { project: 'Alpha' },
      c3: { project: 'Gamma' }, // no registrado pero en uso
      c4: { project: 'HiddenConv', hidden: true },
    },
  };
  const list = projectsWithCounts(data);
  assert.deepEqual(list, [
    { name: 'Alpha', count: 2, hideFromAll: false },
    { name: 'Beta', count: 0, hideFromAll: true },
    { name: 'Gamma', count: 1, hideFromAll: false },
  ]);
});

test('hiddenProjectNames devuelve el set de proyectos ocultos', () => {
  const data = {
    projects: [
      'Normal',
      { name: 'Salas', hideFromAll: true },
      { name: 'Visible', hideFromAll: false },
    ],
  };
  const hidden = hiddenProjectNames(data);
  assert.equal(hidden.has('Salas'), true);
  assert.equal(hidden.has('Normal'), false);
  assert.equal(hidden.has('Visible'), false);
});

test('projectsWithCounts agrega conteos de fuentes adicionales (Codex/AgY)', () => {
  const data = {
    projects: [{ name: 'Alpha', hideFromAll: false }],
    conversations: {
      c1: { project: 'Alpha' },
    },
  };
  const codexData = {
    conversations: {
      cx1: { project: 'Alpha' },
      cx2: { project: 'Beta' },
    },
  };
  const geminiData = {
    conversations: {
      g1: { project: 'Alpha' },
      g2: { project: 'Beta', hidden: true },
    },
  };
  const list = projectsWithCounts(data, [codexData, geminiData]);
  assert.deepEqual(list, [
    { name: 'Alpha', count: 3, hideFromAll: false },
    { name: 'Beta', count: 1, hideFromAll: false },
  ]);
});

test('renameProject renombra en data.projects y en conversaciones de Claude, Codex y AgY', () => {
  const data = {
    projects: [{ name: 'Viejo', hideFromAll: true }],
    conversations: {
      c1: { project: 'Viejo' },
      c2: { project: 'Otro' },
    },
  };
  const codexData = {
    conversations: {
      cx1: { project: 'Viejo' },
    },
  };
  const geminiData = {
    conversations: {
      g1: { project: 'viejo' },
    },
  };

  const ok = renameProject(data, [codexData, geminiData], 'Viejo', 'Nuevo');
  assert.equal(ok, true);
  assert.equal(data.projects[0].name, 'Nuevo');
  assert.equal(data.projects[0].hideFromAll, true);
  assert.equal(data.conversations.c1.project, 'Nuevo');
  assert.equal(data.conversations.c2.project, 'Otro');
  assert.equal(codexData.conversations.cx1.project, 'Nuevo');
  assert.equal(geminiData.conversations.g1.project, 'Nuevo');
});

test('renameProject fusiona con proyecto existente si ya había uno con el nuevo nombre', () => {
  const data = {
    projects: [
      { name: 'A', hideFromAll: false },
      { name: 'B', hideFromAll: true },
    ],
    conversations: {
      c1: { project: 'A' },
      c2: { project: 'B' },
    },
  };
  renameProject(data, [], 'A', 'B');
  assert.equal(data.projects.length, 1);
  assert.equal(data.projects[0].name, 'B');
  assert.equal(data.conversations.c1.project, 'B');
  assert.equal(data.conversations.c2.project, 'B');
});

test('deleteProject elimina el proyecto del registro y desetiqueta conversaciones en todas las fuentes', () => {
  const data = {
    projects: [{ name: 'Borrable', hideFromAll: false }],
    conversations: {
      c1: { project: 'Borrable' },
      c2: { project: 'Queda' },
    },
  };
  const codexData = {
    conversations: {
      cx1: { project: 'Borrable' },
    },
  };
  const geminiData = {
    conversations: {
      g1: { project: 'borrable' },
    },
  };

  const ok = deleteProject(data, [codexData, geminiData], 'Borrable');
  assert.equal(ok, true);
  assert.equal(data.projects.length, 0);
  assert.equal(data.conversations.c1.project, undefined);
  assert.equal('project' in data.conversations.c1, false);
  assert.equal(data.conversations.c2.project, 'Queda');
  assert.equal('project' in codexData.conversations.cx1, false);
  assert.equal('project' in geminiData.conversations.g1, false);

  const list = projectsWithCounts(data, [codexData, geminiData]);
  assert.deepEqual(list, [
    { name: 'Queda', count: 1, hideFromAll: false },
  ]);
});

test('registerProject y projectsWithCounts soportan lista de carpetas asociadas', () => {
  const data = { projects: [] };
  registerProject(data, 'MultiRepo', false, ['repo-a', 'repo-b']);
  assert.equal(data.projects.length, 1);
  assert.deepEqual(data.projects[0].folders, ['repo-a', 'repo-b']);

  const list = projectsWithCounts(data);
  assert.deepEqual(list, [
    { name: 'MultiRepo', count: 0, hideFromAll: false, folders: ['repo-a', 'repo-b'] },
  ]);
});


