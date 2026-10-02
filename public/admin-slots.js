const $ = id => document.getElementById(id);

async function loadSlots() {
  const r = await fetch('/api/slots');
  if (!r.ok) return;
  const { slots } = await r.json();
  $('slots-table').querySelector('tbody').innerHTML = slots.map((s) => `
    <tr>
      <td></td>
      <td></td>
      <td>
        <select data-slot-id="${s.id}" class="engine-select">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="gemini">Gemini</option>
        </select>
      </td>
    </tr>
  `).join('');
  // Nombre/proyecto se arman con textContent (no interpolados en el HTML
  // de arriba) para no repetir el patrón de innerHTML con texto que viene
  // del server (ver nota de Task 5 sobre lo mismo en slot.js) — label y
  // projectPath los pone el admin en el formulario, nunca son datos crudos
  // de un colaborador, pero es gratis ser prolijo con lo que ya se escribe
  // una sola vez acá.
  const rows = $('slots-table').querySelectorAll('tbody tr');
  slots.forEach((s, i) => {
    rows[i].children[0].textContent = s.label;
    rows[i].children[1].textContent = s.projectPath;
    rows[i].querySelector('.engine-select').value = s.engine;
  });
  document.querySelectorAll('.engine-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const r2 = await fetch(`/api/slots/${sel.dataset.slotId}/engine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: sel.value }),
      });
      if (!r2.ok) {
        const data = await r2.json().catch(() => ({}));
        alert(data.error || 'no se pudo cambiar el motor');
      }
      loadSlots();
    });
  });
}

$('new-slot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    label: $('label').value,
    osUser: $('osUser').value,
    projectPath: $('projectPath').value,
    engine: $('engine').value,
  };
  const r = await fetch('/api/slots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { $('new-slot-pin').textContent = 'Error: ' + (data.error || 'desconocido'); return; }
  $('new-slot-pin').textContent = `PIN para compartir con ${body.label}: ${data.slot.pin}`;
  $('new-slot-form').reset();
  loadSlots();
});

loadSlots();
