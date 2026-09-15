const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CODEX_TTS_VOICE = 'es-AR-TomasNeural';
const GEMINI_TTS_VOICE = 'es-UY-ValentinaNeural';
const DEFAULT_VOICE_NAME = { claude: 'es-AR-ElenaNeural', codex: CODEX_TTS_VOICE, antigravity: GEMINI_TTS_VOICE };

// edge-tts no tiene endpoint de validación — lista fija de las voces es-*
// reales (`edge-tts --list-voices`, revisado a mano el 2026-09-14). Evita
// persistir un nombre inventado que silenciosamente no sintetice nada.
const ALLOWED_VOICE_NAMES = new Set([
  'es-AR-ElenaNeural', 'es-AR-TomasNeural',
  'es-UY-ValentinaNeural', 'es-UY-MateoNeural',
  'es-MX-DaliaNeural', 'es-MX-JorgeNeural',
  'es-ES-ElviraNeural', 'es-ES-AlvaroNeural', 'es-ES-XimenaNeural',
  'es-CO-SalomeNeural', 'es-CO-GonzaloNeural',
  'es-CL-CatalinaNeural', 'es-CL-LorenzoNeural',
  'es-PY-TaniaNeural', 'es-PY-MarioNeural',
  'es-VE-PaolaNeural', 'es-VE-SebastianNeural',
  'es-PE-CamilaNeural', 'es-PE-AlexNeural',
  'es-US-PalomaNeural', 'es-US-AlonsoNeural',
]);

function clampVolume(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 100;
}

function getVoiceFlagFiles(homeDir = os.homedir()) {
  return {
    claude: path.join(homeDir, '.claude', 'voice-on'),
    codex: path.join(homeDir, '.claude', 'codex-voice-on'),
    antigravity: path.join(homeDir, '.claude', 'antigravity-voice-on'),
  };
}

function getVoiceVolumeFiles(homeDir = os.homedir()) {
  return {
    codex: path.join(homeDir, '.claude', 'codex-voice-volume'),
    antigravity: path.join(homeDir, '.claude', 'antigravity-voice-volume'),
  };
}

function getVoiceNameFiles(homeDir = os.homedir()) {
  return {
    codex: path.join(homeDir, '.claude', 'codex-voice-name'),
    antigravity: path.join(homeDir, '.claude', 'antigravity-voice-name'),
  };
}

function readVoiceName(voice, homeDir = os.homedir()) {
  if (voice === 'claude') {
    const claudeSettings = path.join(homeDir, '.claude', 'settings.json');
    try {
      const s = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
      const v = s.env && s.env.CLAUDE_TTS_VOICE;
      return ALLOWED_VOICE_NAMES.has(v) ? v : DEFAULT_VOICE_NAME.claude;
    } catch { return DEFAULT_VOICE_NAME.claude; }
  }
  const nameFiles = getVoiceNameFiles(homeDir);
  try {
    const v = fs.readFileSync(nameFiles[voice], 'utf8').trim();
    return ALLOWED_VOICE_NAMES.has(v) ? v : DEFAULT_VOICE_NAME[voice];
  } catch { return DEFAULT_VOICE_NAME[voice]; }
}

function writeVoiceName(voice, value, homeDir = os.homedir()) {
  if (!ALLOWED_VOICE_NAMES.has(value)) throw new Error('voz de edge-tts desconocida: ' + value);
  if (voice === 'claude') {
    const claudeSettings = path.join(homeDir, '.claude', 'settings.json');
    let s = {};
    try { s = JSON.parse(fs.readFileSync(claudeSettings, 'utf8')); } catch {}
    s.env = s.env || {};
    s.env.CLAUDE_TTS_VOICE = value;
    fs.writeFileSync(claudeSettings, JSON.stringify(s, null, 2) + '\n', 'utf8');
  } else {
    const nameFiles = getVoiceNameFiles(homeDir);
    const file = nameFiles[voice];
    if (!file) throw new Error('voz desconocida');
    fs.writeFileSync(file, value, 'utf8');
  }
  return value;
}

function readVoiceOn(voice, homeDir = os.homedir()) {
  const file = getVoiceFlagFiles(homeDir)[voice];
  return !!file && fs.existsSync(file);
}

function writeVoiceOn(voice, on, homeDir = os.homedir()) {
  const file = getVoiceFlagFiles(homeDir)[voice];
  if (!file) throw new Error('voz desconocida');
  if (on) fs.writeFileSync(file, '', 'utf8');
  else { try { fs.unlinkSync(file); } catch {} }
}

function readVoiceVolume(voice, homeDir = os.homedir()) {
  if (voice === 'claude') {
    const claudeSettings = path.join(homeDir, '.claude', 'settings.json');
    try {
      const s = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
      const v = s.env && s.env.CLAUDE_TTS_VOLUME;
      return v != null ? clampVolume(v) : 100;
    } catch { return 100; }
  }
  const volumeFiles = getVoiceVolumeFiles(homeDir);
  const file = volumeFiles[voice];
  try { return clampVolume(fs.readFileSync(file, 'utf8').trim()); } catch { return 100; }
}

function writeVoiceVolume(voice, value, homeDir = os.homedir()) {
  const volume = clampVolume(value);
  if (voice === 'claude') {
    const claudeSettings = path.join(homeDir, '.claude', 'settings.json');
    let s = {};
    try { s = JSON.parse(fs.readFileSync(claudeSettings, 'utf8')); } catch {}
    s.env = s.env || {};
    s.env.CLAUDE_TTS_VOLUME = String(volume);
    fs.writeFileSync(claudeSettings, JSON.stringify(s, null, 2) + '\n', 'utf8');
  } else {
    const volumeFiles = getVoiceVolumeFiles(homeDir);
    const file = volumeFiles[voice];
    if (!file) throw new Error('voz desconocida');
    fs.writeFileSync(file, String(volume), 'utf8');
  }
  return volume;
}

function createVoiceRouter({ homeDir = os.homedir() } = {}) {
  const router = express.Router();
  const flagFiles = getVoiceFlagFiles(homeDir);

  router.get('/', (req, res) => {
    const out = {};
    for (const v of Object.keys(flagFiles)) {
      out[v] = {
        on: readVoiceOn(v, homeDir),
        volume: readVoiceVolume(v, homeDir),
        name: readVoiceName(v, homeDir),
      };
    }
    res.json({ voices: out, options: [...ALLOWED_VOICE_NAMES] });
  });

  router.patch('/:voice', (req, res) => {
    const voice = req.params.voice;
    if (!flagFiles[voice]) return res.status(404).json({ error: 'voz desconocida' });
    try {
      if ('on' in req.body) writeVoiceOn(voice, !!req.body.on, homeDir);
      if ('volume' in req.body) writeVoiceVolume(voice, req.body.volume, homeDir);
      if ('name' in req.body) writeVoiceName(voice, req.body.name, homeDir);
      res.json({
        on: readVoiceOn(voice, homeDir),
        volume: readVoiceVolume(voice, homeDir),
        name: readVoiceName(voice, homeDir),
      });
    } catch (err) {
      res.status(500).json({ error: 'no se pudo guardar: ' + err.message });
    }
  });

  return router;
}

module.exports = {
  createVoiceRouter,
  readVoiceName,
  writeVoiceName,
  readVoiceOn,
  writeVoiceOn,
  readVoiceVolume,
  writeVoiceVolume,
  getVoiceFlagFiles,
  ALLOWED_VOICE_NAMES,
};
