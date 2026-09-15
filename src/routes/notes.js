const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const notes = require('../notes');

// ── Notas (anotador sin IA, sin sesión de Claude) — múltiples libretas ──
// Ver docs/superpowers/specs/2026-08-13-notas-libretas-design.md
function createNotesRouter({ syncSearchIndex, getActiveAccount } = {}) {
  const router = express.Router();

  const notesUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        try {
          notes.ensureFilesDir();
          cb(null, notes.FILES_DIR);
        } catch (err) { cb(err); }
      },
      filename: (req, file, cb) => {
        cb(null, notes.resolveDestName(notes.FILES_DIR, file.originalname));
      },
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  function notifySync() {
    if (typeof syncSearchIndex === 'function') {
      const account = typeof getActiveAccount === 'function' ? getActiveAccount() : undefined;
      syncSearchIndex(account, { reason: 'nota' });
    }
  }

  router.get('/', (req, res) => {
    res.json({ notebooks: notes.listNotebooks() });
  });

  router.post('/', (req, res) => {
    res.status(201).json(notes.createNotebook());
  });

  router.patch('/:id', (req, res) => {
    if (!notes.getNotebook(req.params.id)) return res.status(404).json({ error: 'libreta no encontrada' });
    if ('name' in req.body) {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'nombre vacío' });
      notes.renameNotebook(req.params.id, name);
    }
    // hidden: saca la libreta de la lista sin borrar sus notas — mismo patrón
    // que conv.hidden (ver PATCH /api/conversations/:id).
    if ('hidden' in req.body) notes.hideNotebook(req.params.id, !!req.body.hidden);
    res.json(notes.getNotebook(req.params.id));
  });

  router.get('/:id/notes', (req, res) => {
    const nb = notes.getNotebook(req.params.id);
    if (!nb) return res.status(404).json({ error: 'libreta no encontrada' });
    res.json({ notes: notes.readAll(notes.notebookNotesFile(req.params.id)) });
  });

  router.post('/:id/notes', (req, res) => {
    const nb = notes.getNotebook(req.params.id);
    if (!nb) return res.status(404).json({ error: 'libreta no encontrada' });
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'texto vacío' });
    const file = notes.notebookNotesFile(req.params.id);
    const entry = { id: crypto.randomUUID(), ts: Date.now(), type: 'text', text };
    notes.append(entry, file);
    notifySync();

    // Auto-nombre: si esta es la primera nota de texto y la libreta todavía
    // tiene el nombre default ("Nueva libreta"/"Nueva libreta N"), la renombra
    // usando el principio de esta nota. Si ya se renombró a mano, el nombre
    // deja de matchear el patrón y esto no la vuelve a tocar.
    let notebook = nb;
    if (notes.DEFAULT_NAME_RE.test(nb.name)) {
      const textNotes = notes.readAll(file).filter(e => e.type === 'text');
      if (textNotes.length === 1) {
        const firstLine = text.split('\n')[0].trim();
        const autoName = firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine;
        notebook = notes.renameNotebook(req.params.id, autoName) || nb;
      }
    }
    res.status(201).json({ entry, notebook });
  });

  router.post('/:id/notes/upload', notesUpload.single('file'), (req, res) => {
    const nb = notes.getNotebook(req.params.id);
    if (!nb) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'libreta no encontrada' });
    }
    if (!req.file) return res.status(400).json({ error: 'no se recibió archivo' });
    const entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: 'file',
      fileName: req.file.originalname,
      filePath: path.join(notes.FILES_DIR, req.file.filename),
      mime: req.file.mimetype || '',
      size: req.file.size,
    };
    notes.append(entry, notes.notebookNotesFile(req.params.id));
    notifySync();
    res.status(201).json({ entry, notebook: nb });
  });

  return router;
}

module.exports = { createNotesRouter };
