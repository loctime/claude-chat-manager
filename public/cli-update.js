// Botón del header: actualiza los CLIs de los motores (Claude, AgY, Codex) vía /api/cli-update.
(() => {
  const btn = document.getElementById('cli-update-btn');
  if (!btn) return;
  btn.onclick = async () => {
    if (btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    toast('Actualizando Claude, AgY y Codex… puede tardar un par de minutos.', 'info', 6000);
    try {
      const res = await fetch('/api/cli-update', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) return toast(data.error || 'No se pudo actualizar.', 'error', 6000);
      const lines = data.results.map(r => {
        if (!r.ok) return `${r.label}: error (${r.detail})`;
        return r.changed ? `${r.label}: ${r.before} → ${r.after}` : `${r.label}: ya estaba al día (${r.after})`;
      });
      toast(lines.join('\n'), data.results.every(r => r.ok) ? 'info' : 'error', 12000);
    } catch {
      toast('No se pudo actualizar.', 'error', 6000);
    } finally {
      btn.classList.remove('busy');
    }
  };
})();
