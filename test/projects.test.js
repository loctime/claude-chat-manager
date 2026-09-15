const test = require('node:test');
const assert = require('node:assert');
const {
  projectEntry,
  registerProject,
  projectsWithCounts,
  hiddenProjectNames,
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
