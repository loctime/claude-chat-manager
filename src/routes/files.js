const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const multer = require('multer');
const archiver = require('archiver');

const IMAGE_COMPRESS_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // 1.5MB → comprimir
const MAX_ZIP_BYTES = 200 * 1024 * 1024; // 200MB

function folderExceedsLimit(dirPath, limitBytes) {
  let total = 0;
  const stack = [dirPath];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          continue;
        }
        if (total > limitBytes) return true;
      }
    }
  }
  return false;
}

function createFilesRouter({
  uploadDir,
  magickCmd = 'convert',
  magickArgs = (args) => args,
  isWin = false,
  isWsl = false,
  getGroqApiKey = () => process.env.GROQ_API_KEY,
} = {}) {
  const router = express.Router();
  const upload = multer({ dest: uploadDir, limits: { fileSize: 50 * 1024 * 1024 } });

  const gsAvailable = (() => {
    try {
      const cmd = isWin ? 'where' : 'which';
      const gsName = isWin ? 'gswin64c' : 'gs';
      execFileSync(cmd, [gsName], { windowsHide: true });
      return true;
    } catch { return false; }
  })();

  // ── Upload de archivo adjunto (con compresión automática de imágenes) ──
  router.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no se recibió archivo' });
    const ext = (path.extname(req.file.originalname) || '').slice(1).toLowerCase();
    const finalPath = req.file.path + '.' + (ext || 'bin');

    const finish = (compressedPath) => {
      res.json({ path: compressedPath, name: req.file.originalname, size: fs.statSync(compressedPath).size });
    };

    if (IMAGE_COMPRESS_EXTS.has(ext) && req.file.size > MAX_IMAGE_BYTES) {
      // Comprimir: max 2048px ancho, calidad 82
      const outPath = req.file.path + '_c.jpg';
      execFile(magickCmd, magickArgs([
        req.file.path,
        '-resize', '2048x2048>',
        '-quality', '82',
        '-strip',
        outPath,
      ]), { windowsHide: true }, (err) => {
        if (err) {
          // Fallback: usar original renombrado (ej. ImageMagick no instalado)
          fs.renameSync(req.file.path, finalPath);
          return finish(finalPath);
        }
        fs.unlink(req.file.path, () => {});
        finish(outPath);
      });
    } else {
      fs.renameSync(req.file.path, finalPath);
      finish(finalPath);
    }
  });

  // ── Transcripción de audio vía Groq Whisper ──
  router.post('/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no se recibió audio' });
    const apiKey = getGroqApiKey();
    if (!apiKey) {
      fs.unlinkSync(req.file.path);
      return res.status(503).json({ error: 'GROQ_API_KEY no configurada' });
    }
    const audioPath = req.file.path;
    const originalName = req.file.originalname || 'audio.webm';
    execFile('curl', [
      '-s', '-X', 'POST',
      'https://api.groq.com/openai/v1/audio/transcriptions',
      '-H', `Authorization: Bearer ${apiKey}`,
      '-F', 'model=whisper-large-v3',
      '-F', 'language=es',
      '-F', `file=@${audioPath};filename=${originalName}`,
    ], { maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      fs.unlink(audioPath, () => {});
      if (err) return res.status(500).json({ error: 'error de transcripción: ' + (stderr || err.message) });
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { return res.status(500).json({ error: 'respuesta inválida de Groq' }); }
      if (parsed.error) return res.status(500).json({ error: parsed.error.message || 'error Groq' });
      res.json({ text: parsed.text || '' });
    });
  });

  // ── Thumbnail de archivos (imágenes y PDFs) ──
  router.get('/thumbnail', (req, res) => {
    const filePath = (req.query.path || '').trim();
    if (!filePath || !path.isAbsolute(filePath)) return res.status(400).end();
    if (!fs.existsSync(filePath)) return res.status(404).end();

    const ext = path.extname(filePath).slice(1).toLowerCase();
    const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
    const isPdf = ext === 'pdf';
    const isImage = IMAGE_EXTS.includes(ext);

    if (!isImage && !isPdf) return res.status(404).end();
    if (isPdf && !gsAvailable) return res.status(404).end();

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    let args;
    if (isPdf) {
      args = ['-density', '72', `${filePath}[0]`, '-resize', '200x200>', '-background', 'white', '-flatten', 'jpeg:-'];
    } else {
      args = [filePath, '-resize', '200x200>', '-background', '#111b21', '-flatten', 'jpeg:-'];
    }

    execFile(magickCmd, magickArgs(args), { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err || !stdout || stdout.length === 0) return res.status(404).end();
      res.end(stdout);
    });
  });

  // ── Descarga de archivos del filesystem ──
  router.get('/files', (req, res) => {
    const filePath = (req.query.path || '').trim();
    if (!filePath || !path.isAbsolute(filePath)) return res.status(400).json({ error: 'path inválido' });
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return res.status(404).json({ error: 'archivo no encontrado' });
    }
    if (!stat.isFile()) return res.status(400).json({ error: 'no es un archivo (¿es una carpeta?)' });
    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const stream = fs.createReadStream(filePath);
    stream.on('error', err => {
      console.error('[api/files] error leyendo', filePath, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'error leyendo el archivo' });
      else res.end();
    });
    stream.pipe(res);
  });

  // ── "Mostrar en carpeta" — abre el Explorador en la PC donde corre Jarvis ──
  router.get('/reveal', (req, res) => {
    if (!isWin && !isWsl) return res.status(400).json({ error: 'solo disponible en Windows/WSL' });
    const filePath = (req.query.path || '').trim();
    if (!filePath || !path.isAbsolute(filePath)) return res.status(400).json({ error: 'path inválido' });
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return res.status(404).json({ error: 'no encontrado' });
    }
    let explorerPath = filePath;
    if (isWsl) {
      try {
        explorerPath = execFileSync('wslpath', ['-w', filePath], { encoding: 'utf8' }).trim();
      } catch {
        return res.status(500).json({ error: 'no se pudo convertir el path (wslpath)' });
      }
    }
    const explorerBin = isWsl ? '/mnt/c/Windows/explorer.exe' : 'explorer.exe';
    const args = stat.isDirectory() ? [explorerPath] : ['/select,' + explorerPath];
    execFile(explorerBin, args, (err) => {
      if (err && typeof err.code !== 'number') {
        console.error('[api/reveal] no se pudo lanzar', explorerBin, ':', err.message);
        return res.status(500).json({ error: 'no se pudo abrir el explorador: ' + err.message });
      }
      res.json({ ok: true });
    });
  });

  // ── "Descargar carpeta como .zip" ──
  router.get('/folder-zip', (req, res) => {
    const folderPath = (req.query.path || '').trim();
    if (!folderPath || !path.isAbsolute(folderPath)) return res.status(400).json({ error: 'path inválido' });
    let stat;
    try {
      stat = fs.statSync(folderPath);
    } catch {
      return res.status(404).json({ error: 'no encontrado' });
    }
    if (!stat.isDirectory()) return res.status(400).json({ error: 'no es una carpeta' });

    if (folderExceedsLimit(folderPath, MAX_ZIP_BYTES)) {
      return res.status(413).json({ error: 'carpeta muy grande (>200MB) para descargar por acá — abrila desde la PC' });
    }

    const name = path.basename(folderPath) || 'carpeta';
    res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => {
      console.error('[api/folder-zip] error armando zip', folderPath, err.message);
      if (!res.headersSent) res.status(500).json({ error: 'error armando el zip' });
      else res.end();
    });
    archive.pipe(res);
    archive.directory(folderPath, false);
    archive.finalize();
  });

  return router;
}

module.exports = {
  folderExceedsLimit,
  createFilesRouter,
  MAX_ZIP_BYTES,
};
