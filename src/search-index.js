// Índice de búsqueda full-text sobre chats y notas.
//
// Antes esto era un scan lineal: cada búsqueda leía TODOS los .jsonl enteros y
// sincrónicos (en la cuenta principal son varios GB) y recién después filtraba.
// Además cortaba en `limit` mientras recorría carpetas en orden de filesystem,
// así que un match en una carpeta tardía podía no aparecer nunca aunque fuera
// el mejor resultado.
//
// Ahora usamos SQLite FTS5 vía `node:sqlite` — que viene con Node, así que no
// suma dependencias al proyecto. El tokenizer `unicode61 remove_diacritics 2`
// resuelve de fábrica el otro problema viejo: "facil" ahora encuentra "fácil".
const fs = require('fs');
const path = require('path');
const scanner = require('./scanner');

// Node 22 tiene node:sqlite detrás de un flag de "experimental" y las máquinas
// donde corre esto no están todas en la misma versión. Si falta, el server cae
// al scan viejo en vez de no arrancar.
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* sin sqlite: el caller usa el fallback */ }

function sqliteAvailable() { return !!DatabaseSync; }

// Cuánto pesa la antigüedad al ordenar. bm25 devuelve negativo (más negativo =
// mejor match) y le sumamos una penalidad que crece con el log de los días, así
// lo reciente sube sin que un match fuerte y viejo quede sepultado.
const AGE_WEIGHT = 0.35;

// Candidatos que traemos de SQL antes de re-rankear por antigüedad en JS.
// Sin este colchón el ajuste por fecha solo podría reordenar la página pedida.
const CANDIDATE_FACTOR = 6;
const MAX_CANDIDATES = 500;

// Delimitadores del término encontrado dentro del snippet. Los pone FTS5, que
// es el único que sabe qué matcheó realmente: el cliente no puede deducirlo
// buscando la query cruda, porque "facil" matchea "fácil" y "deplo" matchea
// "deploy". Van caracteres de control (no imprimibles, imposibles en un chat)
// para no chocar nunca con el texto del mensaje.
const HL_START = '\u0001';
const HL_END = '\u0002';

// Cada cuántos archivos le devolvemos el control al event loop durante un sync.
// El backfill inicial recorre miles de archivos: sin esto el server queda mudo
// mientras indexa.
const YIELD_EVERY = 20;

// Subir esto descarta el índice y lo reconstruye: es un cache derivado de los
// .jsonl, así que regenerarlo siempre es más barato que migrarlo.
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  path          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  account       TEXT NOT NULL,
  ref_id        TEXT NOT NULL,
  name          TEXT,
  cwd           TEXT,
  last_activity TEXT,
  mtime_ms      REAL NOT NULL,
  size          INTEGER NOT NULL,
  row_lo        INTEGER,
  row_hi        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sources_scope ON sources(kind, account);

-- kind y account están duplicados acá a propósito (la fuente de verdad es la
-- tabla sources). Ordenar por relevancia obliga a SQLite a mirar TODAS las filas
-- que matchean antes de aplicar el LIMIT, así que el filtro de scope se paga una
-- vez por fila matcheada: teniéndolo acá se evita además un lookup a sources en
-- cada una. Medido sobre 100 MB con un término que matchea el 36% del índice:
-- 183ms acá contra 200ms con join (y 73ms sería el piso sin filtrar nada). La
-- diferencia es chica porque el costo real es recorrer los matches, no el filtro;
-- una búsqueda normal (término específico) da menos de 1ms por cualquiera de las dos.
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
  body,
  tools,
  path      UNINDEXED,
  kind      UNINDEXED,
  account   UNINDEXED,
  msg_index UNINDEXED,
  role      UNINDEXED,
  ts_ms     UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

// Lo que el usuario tipea NO es sintaxis FTS: comillas, paréntesis, guiones y
// OR/NEAR son operadores del MATCH y romperían la consulta. Partimos en
// palabras (mismo criterio que el tokenizer) y las re-citamos nosotros.
// Al último término le ponemos prefijo para que la búsqueda sirva mientras se
// tipea: "deplo" ya encuentra "deploy".
function buildMatchExpr(query, includeTools) {
  const terms = String(query || '').split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  if (!terms.length) return null;
  const cols = includeTools ? '{body tools}' : '{body}';
  const parts = terms.map((t, i) => {
    const quoted = '"' + t.replace(/"/g, '""') + '"';
    return i === terms.length - 1 ? quoted + '*' : quoted;
  });
  return `${cols} : (${parts.join(' AND ')})`;
}

// Un chat aporta una fila por mensaje: es lo que permite dar snippet exacto y
// saltar directo a la coincidencia (matchIndex es la posición en la lista que
// arma toChatMessages, o sea lo mismo que renderiza la UI).
function chatDocs(filePath) {
  const info = scanner.sessionInfo(filePath);
  if (!info) return null; // sesión de canal o sin mensajes útiles
  const msgs = scanner.toChatMessages(scanner.parseJsonl(filePath));
  const docs = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const ts = m.ts ? Date.parse(m.ts) : NaN;
    const doc = {
      msgIndex: i,
      role: m.role,
      tsMs: Number.isNaN(ts) ? Date.parse(info.lastActivity) || 0 : ts,
      body: '',
      tools: '',
    };
    if (m.role === 'tool') {
      // El nombre y los argumentos son lo que uno recuerda ("dónde corrí ese
      // comando"); el output completo inflaría el índice con logs enteros.
      doc.tools = [m.name, stringifyInput(m.input)].filter(Boolean).join(' ');
    } else {
      doc.body = m.text || '';
    }
    if (doc.body || doc.tools) docs.push(doc);
  }
  if (!docs.length) return null;
  return {
    source: {
      kind: 'chat',
      refId: info.sessionId,
      name: info.snippet,
      cwd: info.cwd,
      lastActivity: info.lastActivity,
    },
    docs,
  };
}

function stringifyInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  try { return Object.values(input).filter(v => typeof v === 'string').join(' '); }
  catch { return ''; }
}

function noteDocs(notebook) {
  const entries = scanner.parseJsonl(notebook.file);
  const docs = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    // Los adjuntos se buscan por nombre de archivo — es lo único textual que tienen.
    const body = e.type === 'file' ? (e.fileName || '') : (e.text || '');
    if (!body.trim()) continue;
    docs.push({ msgIndex: i, role: 'note', tsMs: e.ts || 0, body, tools: '' });
  }
  if (!docs.length) return null;
  const last = entries[entries.length - 1];
  return {
    source: {
      kind: 'note',
      refId: notebook.id,
      name: notebook.name,
      cwd: null,
      lastActivity: last && last.ts ? new Date(last.ts).toISOString() : null,
    },
    docs,
  };
}

function openIndex(dbPath) {
  if (!DatabaseSync) throw new Error('node:sqlite no disponible en este Node');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS sources;');
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  db.exec(SCHEMA);

  const stmt = {
    getSource: db.prepare('SELECT mtime_ms, size, row_lo, row_hi FROM sources WHERE path = ?'),
    pathsFor: db.prepare('SELECT path FROM sources WHERE kind = ? AND account = ?'),
    delSource: db.prepare('DELETE FROM sources WHERE path = ?'),
    // Por rowid, NO por path: `path` es una columna UNINDEXED de FTS5, así que
    // filtrar por ella recorre la tabla entera. Con miles de archivos eso vuelve
    // el indexado cuadrático (medido: 26s para 100 MB, contra ~1s por rango).
    delDocsRange: db.prepare('DELETE FROM docs WHERE rowid BETWEEN ? AND ?'),
    insSource: db.prepare(`INSERT INTO sources (path, kind, account, ref_id, name, cwd, last_activity, mtime_ms, size, row_lo, row_hi)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insDoc: db.prepare('INSERT INTO docs (body, tools, path, kind, account, msg_index, role, ts_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    getMeta: db.prepare('SELECT ref_id, name, cwd, last_activity FROM sources WHERE path = ?'),
  };

  // Las filas de un archivo se insertan todas juntas y sin intercalar (esto es
  // single-thread, un indexSource a la vez), así que ocupan un rango contiguo de
  // rowids y alcanza con guardar los extremos para poder borrarlas después.
  function forget(filePath, prev) {
    const row = prev === undefined ? stmt.getSource.get(filePath) : prev;
    if (!row) return;
    if (row.row_lo != null) stmt.delDocsRange.run(row.row_lo, row.row_hi);
    stmt.delSource.run(filePath);
  }

  // Reemplaza en bloque lo indexado de un archivo. Se llama tanto en el backfill
  // como cuando cambió el mtime, así que primero borra: sin eso, reindexar
  // duplicaría cada mensaje viejo.
  // Todo va dentro de UNA transacción, y no es un detalle de estilo: una
  // conversación larga son miles de INSERT y sin esto SQLite abre y cierra una
  // transacción implícita por cada fila. Medido sobre un corpus de 100 MB,
  // indexar pasa de 32s a ~1s sólo por agrupar. De paso da atomicidad: si el
  // parseo explota a mitad de camino, el archivo no queda indexado por la mitad.
  function indexSource(filePath, account, built, stat, prev) {
    db.exec('BEGIN');
    try {
      forget(filePath, prev);
      if (built) {
        let lo = null, hi = null;
        for (const d of built.docs) {
          const { lastInsertRowid } = stmt.insDoc.run(d.body, d.tools, filePath, built.source.kind, account, d.msgIndex, d.role, d.tsMs);
          if (lo === null) lo = lastInsertRowid;
          hi = lastInsertRowid;
        }
        const s = built.source;
        stmt.insSource.run(filePath, s.kind, account, s.refId, s.name, s.cwd, s.lastActivity, stat.mtimeMs, stat.size, lo, hi);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return !!built;
  }

  // Recorre las fuentes de un scope, reindexa solo lo que cambió de mtime/tamaño
  // y borra del índice lo que ya no está en disco.
  async function syncSources(kind, account, items, onProgress) {
    const known = new Set(stmt.pathsFor.all(kind, account).map(r => r.path));
    let indexed = 0, skipped = 0, n = 0;

    for (const item of items) {
      known.delete(item.file);
      let stat;
      try { stat = fs.statSync(item.file); } catch { continue; }

      const prev = stmt.getSource.get(item.file);
      if (prev && prev.mtime_ms === stat.mtimeMs && prev.size === stat.size) { skipped++; continue; }

      let built = null;
      try { built = item.build(); }
      catch (e) { console.error('[search-index] no se pudo indexar', item.file, e.message); }
      indexSource(item.file, account, built, stat, prev || null);
      indexed++;

      if (onProgress) onProgress({ indexed, skipped, file: item.file });
      if (++n % YIELD_EVERY === 0) await new Promise(r => setImmediate(r));
    }

    // Lo que quedó en `known` ya no existe en disco (sesión borrada o archivada).
    for (const gone of known) forget(gone);

    return { indexed, skipped, removed: known.size };
  }

  function chatItems(projectsDir) {
    const items = [];
    let dirs;
    try { dirs = fs.readdirSync(projectsDir); } catch { return items; }
    for (const d of dirs) {
      const dirPath = path.join(projectsDir, d);
      let files;
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(dirPath, f);
        items.push({ file, build: () => chatDocs(file) });
      }
    }
    return items;
  }

  return {
    db,

    syncChats(projectsDir, account, { onProgress } = {}) {
      return syncSources('chat', account, chatItems(projectsDir), onProgress);
    },

    // `notebooks` = [{ id, name, file }] — lo arma el caller desde el módulo de
    // notas, así este módulo no depende de dónde viven las libretas.
    syncNotes(notebooks, account, { onProgress } = {}) {
      const items = (notebooks || []).map(nb => ({ file: nb.file, build: () => noteDocs(nb) }));
      return syncSources('note', account, items, onProgress);
    },

    search(query, { kind = 'chat', account, limit = 50, includeTools = false } = {}) {
      const match = buildMatchExpr(query, includeTools);
      if (!match) return [];
      const pool = Math.min(MAX_CANDIDATES, Math.max(limit, limit * CANDIDATE_FACTOR));

      let rows;
      try {
        rows = db.prepare(`
          SELECT path, msg_index, role, ts_ms,
                 snippet(docs, -1, '${HL_START}', '${HL_END}', '…', 12) AS snippet,
                 bm25(docs) AS rank
          FROM docs
          WHERE docs MATCH ? AND kind = ? AND account = ?
          ORDER BY rank
          LIMIT ?
        `).all(match, kind, account, pool);
      } catch (e) {
        console.error('[search-index] consulta inválida:', e.message);
        return [];
      }

      const now = Date.now();
      // Varios resultados suelen venir del mismo archivo: cacheamos su metadata
      // para no repetir el lookup.
      const metaCache = new Map();
      const metaDe = p => {
        if (!metaCache.has(p)) metaCache.set(p, stmt.getMeta.get(p) || null);
        return metaCache.get(p);
      };

      return rows
        .map(r => {
          const ageDays = Math.max(0, (now - (r.ts_ms || 0)) / 86_400_000);
          return { row: r, score: r.rank + AGE_WEIGHT * Math.log1p(ageDays) };
        })
        .sort((a, b) => a.score - b.score)
        .slice(0, limit)
        .map(({ row: r }) => {
          const m = metaDe(r.path) || {};
          return {
            kind,
            refId: m.ref_id || null,
            sessionId: kind === 'chat' ? (m.ref_id || null) : null,
            notebookId: kind === 'note' ? (m.ref_id || null) : null,
            name: m.name || null,
            cwd: m.cwd || null,
            lastActivity: m.last_activity || null,
            matchIndex: r.msg_index,
            role: r.role,
            snippet: r.snippet,
          };
        });
    },

    stats(account) {
      const q = db.prepare('SELECT kind, count(*) AS n FROM sources WHERE account = ? GROUP BY kind').all(account);
      return Object.fromEntries(q.map(r => [r.kind, r.n]));
    },

    close() { db.close(); },
  };
}

module.exports = { openIndex, buildMatchExpr, sqliteAvailable };
