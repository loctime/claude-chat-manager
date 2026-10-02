const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();
const SLOTS_FILE = path.join(HOME_DIR, '.ccm-slots.json');
const VALID_ENGINES = new Set(['claude', 'codex', 'gemini']);

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

function createSlot({ label, osUser, projectPath, engine }, file = SLOTS_FILE) {
  if (!VALID_ENGINES.has(engine)) throw new Error(`engine invalido: ${engine}`);
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
  if (!VALID_ENGINES.has(newEngine)) throw new Error(`engine invalido: ${newEngine}`);
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

module.exports = { load, save, createSlot, listSlots, resolveByPin, getSlot, switchEngine, setActiveConversation, SLOTS_FILE, VALID_ENGINES };
