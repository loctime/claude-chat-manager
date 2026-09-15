const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const notes = require('../notes');

// ── Escáner de documentos (tipo CamScanner) y borrador de PDF multipágina ──
// Detecta el documento en la foto, endereza la perspectiva y limpia el
// contraste (canal rojo + umbral adaptivo — scripts/mejora-imagen/mejorar_imagen.py).
// Ver docs/superpowers/specs/2026-08-17-escaner-documentos-design.md.
function createScansRouter({ homeDir, isWin, syncSearchIndex, getActiveAccount } = {}) {
  const router = express.Router();
  const PYTHON_CMD = isWin ? 'python' : 'python3';
  const SCAN_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'mejora-imagen', 'mejorar_imagen.py');
  const SCANS_DIR = path.join(homeDir, '.ccm-notes', 'scans');
  const PDF_DRAFTS_DIR = path.join(homeDir, '.ccm-notes', 'scan-pdfs');

  const scanUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const id = crypto.randomUUID();
        const dir = path.join(SCANS_DIR, id);
        try {
          fs.mkdirSync(dir, { recursive: true });
          req.scanId = id;
          req.scanDir = dir;
          cb(null, dir);
        } catch (err) { cb(err); }
      },
      filename: (req, file, cb) => {
        const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
        cb(null, 'original' + ext);
      },
    }),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  function findOrCreateScanNotebook() {
    const existing = notes.listNotebooks().find(nb => nb.name === 'Escaneos');
    if (existing) return existing;
    const nb = notes.createNotebook();
    return notes.renameNotebook(nb.id, 'Escaneos') || nb;
  }

  function notifySync() {
    if (typeof syncSearchIndex === 'function') {
      const account = typeof getActiveAccount === 'function' ? getActiveAccount() : undefined;
      syncSearchIndex(account, { reason: 'nota' });
    }
  }

  const SCAN_VARIANT_SUFFIX = { recortada: '_recortada.jpg', limpia: '_limpia.jpg', limpia2x: '_limpia_2x.jpg' };

  router.post('/', scanUpload.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no se recibió foto' });
    execFile(PYTHON_CMD, [SCAN_SCRIPT, req.file.path, req.scanDir, '--json'], { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        console.error('[scan] error procesando', stderr || err.message);
        return res.status(500).json({ error: 'no se pudo procesar la imagen: ' + (stderr || err.message).toString().slice(0, 300) });
      }
      let result;
      try { result = JSON.parse(stdout); } catch { return res.status(500).json({ error: 'respuesta inválida del script de escaneo' }); }
      if (result.error) return res.status(500).json({ error: result.error });
      res.json({
        id: req.scanId,
        detectado: result.detectado,
        recortada: result.recortada,
        limpia: result['1x'],
        limpia2x: result['2x'],
      });
    });
  });

  router.post('/:id/keep', (req, res) => {
    const suffix = SCAN_VARIANT_SUFFIX[req.body && req.body.variant];
    if (!suffix) return res.status(400).json({ error: 'variante inválida' });
    const dir = path.join(SCANS_DIR, req.params.id);
    let files;
    try { files = fs.readdirSync(dir); } catch { return res.status(404).json({ error: 'escaneo no encontrado' }); }
    const fileName = files.find(f => f.endsWith(suffix));
    if (!fileName) return res.status(404).json({ error: 'no se encontró el archivo procesado' });
    const srcPath = path.join(dir, fileName);

    notes.ensureFilesDir();
    const destName = notes.resolveDestName(notes.FILES_DIR, `escaneo-${req.params.id.slice(0, 8)}.jpg`);
    const destPath = path.join(notes.FILES_DIR, destName);
    fs.copyFileSync(srcPath, destPath);

    const notebook = findOrCreateScanNotebook();
    const entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: 'file',
      fileName: destName,
      filePath: destPath,
      mime: 'image/jpeg',
      size: fs.statSync(destPath).size,
    };
    notes.append(entry, notes.notebookNotesFile(notebook.id));
    notifySync();
    res.status(201).json({ entry, notebook });
  });

  router.post('/pdf', async (req, res) => {
    const pages = Array.isArray(req.body && req.body.pages) ? req.body.pages : [];
    if (!pages.length) return res.status(400).json({ error: 'no se recibió ninguna página' });
    if (pages.length > 50) return res.status(400).json({ error: 'máximo 50 páginas por documento' });

    const resolved = [];
    for (const p of pages) {
      const suffix = SCAN_VARIANT_SUFFIX[p && p.variant];
      if (!suffix) return res.status(400).json({ error: `variante inválida en página: ${p && p.variant}` });
      const dir = path.join(SCANS_DIR, String(p.id || ''));
      let files;
      try { files = fs.readdirSync(dir); } catch { return res.status(404).json({ error: `escaneo no encontrado: ${p.id}` }); }
      const fileName = files.find(f => f.endsWith(suffix));
      if (!fileName) return res.status(404).json({ error: `no se encontró el archivo procesado de ${p.id}` });
      resolved.push(path.join(dir, fileName));
    }

    try {
      const pdfDoc = await PDFDocument.create();
      for (const imgPath of resolved) {
        const bytes = fs.readFileSync(imgPath);
        const jpg = await pdfDoc.embedJpg(bytes);
        const page = pdfDoc.addPage([jpg.width, jpg.height]);
        page.drawImage(jpg, { x: 0, y: 0, width: jpg.width, height: jpg.height });
      }
      const pdfBytes = await pdfDoc.save();

      const id = crypto.randomUUID();
      fs.mkdirSync(PDF_DRAFTS_DIR, { recursive: true });
      const pdfPath = path.join(PDF_DRAFTS_DIR, `${id}.pdf`);
      fs.writeFileSync(pdfPath, pdfBytes);

      res.status(201).json({ id, path: pdfPath, pageCount: resolved.length });
    } catch (err) {
      console.error('[scan/pdf] error generando PDF', err.message);
      res.status(500).json({ error: 'no se pudo generar el PDF: ' + err.message.slice(0, 300) });
    }
  });

  router.post('/pdf/:id/keep', (req, res) => {
    const srcPath = path.join(PDF_DRAFTS_DIR, `${req.params.id}.pdf`);
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'PDF no encontrado (¿ya se guardó o se generó de nuevo?)' });

    notes.ensureFilesDir();
    const destName = notes.resolveDestName(notes.FILES_DIR, `documento-${req.params.id.slice(0, 8)}.pdf`);
    const destPath = path.join(notes.FILES_DIR, destName);
    fs.copyFileSync(srcPath, destPath);

    const notebook = findOrCreateScanNotebook();
    const entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: 'file',
      fileName: destName,
      filePath: destPath,
      mime: 'application/pdf',
      size: fs.statSync(destPath).size,
    };
    notes.append(entry, notes.notebookNotesFile(notebook.id));
    notifySync();
    res.status(201).json({ entry, notebook });
  });

  return router;
}

module.exports = { createScansRouter };
