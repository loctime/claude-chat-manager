const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const SLOTS_FILE = path.join(HOME_DIR, '.ccm-slots.json');
const VALID_ENGINES = new Set(['claude', 'codex', 'gemini']);
// Hallazgo de la revision final (docs/superpowers/plans/2026-10-02-slots-colaborador.md):
// codex-runner.js y gemini-runner.js nunca heredaron el camino sudo -u que
// SI tiene runner.js (Claude) — el campo `account` que server.js les manda
// se ignora en silencio, asi que un slot de codex/gemini correria el CLI
// como el usuario `claude` (dueño de TODOS los proyectos de este VPS), no
// como su propio usuario aislado. Hoy es inofensivo solo porque esos
// binarios no estan instalados en este VPS (ENOENT); el dia que lo esten,
// cualquier slot de esos dos motores seria una escalada de privilegios
// completa. Hasta que esos dos runners tengan su propio camino sudo -u (y
// sus propios meta/session stores por cuenta, no los globales
// CODEX_META_FILE/GEMINI_META_FILE), un slot SOLO puede usar Claude.
// VALID_ENGINES sigue listando los 3 porque son nombres de motor
// reconocidos por la arquitectura en general; esto es una restriccion
// aparte, especifica de slots.
const SLOT_SAFE_ENGINES = new Set(['claude']);

function load(file = SLOTS_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && Array.isArray(parsed.slots)) ? parsed : { slots: [] };
  } catch {
    return { slots: [] };
  }
}

function save(data, file = SLOTS_FILE) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function genId() { return crypto.randomBytes(6).toString('hex'); }
function genPin() { return crypto.randomBytes(9).toString('base64url'); }

function assertSlotSafeEngine(engine) {
  if (!VALID_ENGINES.has(engine)) throw new Error(`engine invalido: ${engine}`);
  if (!SLOT_SAFE_ENGINES.has(engine)) {
    throw new Error(`motor no habilitado para slots todavia: ${engine} (falta aislamiento por usuario del sistema)`);
  }
}

const OS_USER_RE = /^colab-[a-z0-9-]+$/;

function assertValidOsUserAndPath(osUser, projectPath) {
  // Guarda contra un typo catastrofico (ej. osUser:'claude' o 'root') que
  // crearia un slot SIN aislamiento real de sistema operativo — el nombre
  // tiene que matchear el patron que ya usa provision-slot.sh (colab-*), y
  // el proyecto tiene que vivir dentro del propio home de ese usuario, no
  // en cualquier lado (hallazgo de la revision final del plan).
  if (!OS_USER_RE.test(osUser)) {
    throw new Error(`osUser invalido: ${osUser} (tiene que matchear ${OS_USER_RE})`);
  }
  if (!projectPath.startsWith(`/home/${osUser}/`)) {
    throw new Error(`projectPath invalido: ${projectPath} (tiene que empezar con /home/${osUser}/)`);
  }
}

function createSlot({ label, osUser, projectPath, engine }, file = SLOTS_FILE) {
  assertSlotSafeEngine(engine);
  assertValidOsUserAndPath(osUser, projectPath);
  const data = load(file);
  if (data.slots.some(s => s.osUser === osUser)) throw new Error(`osUser ya usado por otro slot: ${osUser}`);
  const slot = {
    id: genId(),
    label,
    osUser,
    projectPath,
    engine,
    pin: genPin(),
    activeConversationId: null,
    archivedConversationIds: [],
  };
  data.slots.push(slot);
  save(data, file);
  return slot;
}

function listSlots(file = SLOTS_FILE) {
  return load(file).slots;
}

function resolveByPin(pin, file = SLOTS_FILE) {
  return load(file).slots.find(s => s.pin === pin) || null;
}

function getSlot(slotId, file = SLOTS_FILE) {
  const slot = load(file).slots.find(s => s.id === slotId);
  if (!slot) throw new Error(`slot no encontrado: ${slotId}`);
  return slot;
}

function switchEngine(slotId, newEngine, file = SLOTS_FILE) {
  assertSlotSafeEngine(newEngine);
  const data = load(file);
  const slot = data.slots.find(s => s.id === slotId);
  if (!slot) throw new Error(`slot no encontrado: ${slotId}`);
  if (slot.activeConversationId) slot.archivedConversationIds.push(slot.activeConversationId);
  slot.activeConversationId = null;
  slot.engine = newEngine;
  save(data, file);
  return slot;
}

function setActiveConversation(slotId, conversationId, file = SLOTS_FILE) {
  const data = load(file);
  const slot = data.slots.find(s => s.id === slotId);
  if (!slot) throw new Error(`slot no encontrado: ${slotId}`);
  slot.activeConversationId = conversationId;
  save(data, file);
  return slot;
}

module.exports = { load, save, createSlot, listSlots, resolveByPin, getSlot, switchEngine, setActiveConversation, SLOTS_FILE, VALID_ENGINES, SLOT_SAFE_ENGINES };
