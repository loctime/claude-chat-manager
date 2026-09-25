// ── Mascota animada compañera (J.A.R.V.I.S) ──
// Personalidad: Gruñón, fastidioso, no quiere laburar.
// Estados: idle (durmiendo Zzz), reading (despertado con bronca), thinking (echando humo),
// working (aporreando el teclado con odio), done (revolea todo y vuelve a dormir).

(function() {
  const STATES = ['idle', 'reading', 'thinking', 'working', 'done'];
  let currentState = 'idle';
  let currentVisual = 'idle'; // qué .webp se muestra en realidad (puede diferir de currentState durante 'working')
  let currentTool = null;
  let currentMood = null;
  let isEnabled = true;
  let doneTimer = null;
  let readingTimer = null;
  let tapTimer = null;
  let tapVisualTimer = null;
  let popTimer = null;
  let bubbleTimer = null;
  const preloadedImages = {};

  const ASSET_DIR = '/assets/mascot';
  const POS_STORAGE_KEY = 'jarvis_mascot_pos';

  const ALL_ANIMATIONS = [
    'idle', 'reading', 'thinking', 'working', 'done',
    // tap (8)
    'tap_1_question', 'tap_2_dodge', 'tap_3_stare', 'tap_4_listen',
    'tap_5_bored', 'tap_6_mock', 'tap_7_stop', 'tap_8_disappointed',
    // reading (6)
    'reading_1_groan', 'reading_2_knew_it', 'reading_3_look',
    'reading_4_facepalm', 'reading_5_fine', 'reading_6_sarcasm',
    // thinking (8)
    'thinking_1_smoke', 'thinking_2_shrug', 'thinking_3_clue',
    'thinking_4_idea', 'thinking_5_watch', 'thinking_6_clueless',
    'thinking_7_invent', 'thinking_8_headache',
    // working (9)
    'working_1_confident', 'working_2_sigh', 'working_3_endless',
    'working_4_blind', 'working_5_mate', 'working_6_pressure',
    'working_7_rage', 'working_8_slam', 'working_9_threat',
    // done (7)
    'done_1_bye', 'done_2_sleep', 'done_3_throw', 'done_4_whatever',
    'done_5_closed', 'done_6_silence', 'done_7_leave'
  ];

  // Frases de personalidad fastidiosa con su animación específica
  const PHRASES = {
    tap: [
      '? [tap_1_question]',
      'No me toques. [tap_2_dodge]',
      'Qué tocas? [tap_3_stare]',
      'Si... decime ... [tap_4_listen]',
      'Que pesado... [tap_5_bored]',
      'Tocate el culo [tap_6_mock]',
      'Dejá de joder. [tap_7_stop]',
      'No tenés amigos? [tap_8_disappointed]'
    ],
    reading: [
      'Otra vez vos? [reading_1_groan]',
      'Ya sabía que ibas a venir a pedir algo. [reading_2_knew_it]',
      'Mirá lo que me pide... [reading_3_look]',
      'Las boludeces que me pide... [reading_4_facepalm]',
      'Bueno dale [reading_5_fine]',
      'Mirá qué interesante che [reading_6_sarcasm]'
    ],
    thinking: [
      'Se me quema el chip... [thinking_1_smoke]',
      'Alguna ayuda? [thinking_2_shrug]',
      'Dame una pista... [thinking_3_clue]',
      'Creo que ya sé! [thinking_4_idea]',
      'A ver dejame pensar media hora más... [thinking_5_watch]',
      '... la verdad no tengo ni idea pero algo hay que hacer... ya fue [thinking_6_clueless]',
      'A ver qué invento ahora... [thinking_7_invent]',
      'Me duele la cabeza. [thinking_8_headache]'
    ],
    working: [
      'Esta me la sé [working_1_confident]',
      'Todo tengo que hacer... [working_2_sigh]',
      'No termino más... [working_3_endless]',
      'Ya fue pongo cualquiera. [working_4_blind]',
      'Aahh bueno me tomo mi descanso. [working_5_mate]',
      'Cuanta presión. [working_6_pressure]',
      '#@$%&!... [working_7_rage]',
      'Aporreando teclas... [working_8_slam]',
      'No me apures! [working_9_threat]'
    ],
    done: [
      'Listo bro, no me hables más. [done_1_bye]',
      'Chau. Vuelvo a la siesta. [done_2_sleep]',
      'Ahí tenés, pesado. [done_3_throw]',
      'De nada... [done_4_whatever]',
      'Por hoy ya no vuelvas. [done_5_closed]',
      '... [done_6_silence]',
      'Andá. [done_7_leave]'
    ]
  };

  const KNOWN_PHRASE_ANIMS = {
    '?': 'tap_1_question',
    'no me toques.': 'tap_2_dodge',
    'no me toques': 'tap_2_dodge',
    'qué tocas?': 'tap_3_stare',
    'que tocas?': 'tap_3_stare',
    'si... decime ...': 'tap_4_listen',
    'si... decime': 'tap_4_listen',
    'que pesado...': 'tap_5_bored',
    'que pesado': 'tap_5_bored',
    'tocate el culo': 'tap_6_mock',
    'dejá de joder.': 'tap_7_stop',
    'deja de joder': 'tap_7_stop',
    'no tenés amigos?': 'tap_8_disappointed',
    'no tenes amigos?': 'tap_8_disappointed',

    'otra vez vos?': 'reading_1_groan',
    'ya sabía que ibas a venir a pedir algo.': 'reading_2_knew_it',
    'ya sabia que ibas a venir a pedir algo.': 'reading_2_knew_it',
    'mirá lo que me pide...': 'reading_3_look',
    'mira lo que me pide...': 'reading_3_look',
    'las boludeces que me pide...': 'reading_4_facepalm',
    'bueno dale': 'reading_5_fine',
    'mirá qué interesante che': 'reading_6_sarcasm',
    'mira que interesante che': 'reading_6_sarcasm',

    'se me quema el chip...': 'thinking_1_smoke',
    'alguna ayuda?': 'thinking_2_shrug',
    'dame una pista...': 'thinking_3_clue',
    'creo que ya sé!': 'thinking_4_idea',
    'creo que ya se!': 'thinking_4_idea',
    'a ver dejame pensar media hora más...': 'thinking_5_watch',
    'a ver dejame pensar media hora mas...': 'thinking_5_watch',
    '... la verdad no tengo ni idea pero algo hay que hacer... ya fue': 'thinking_6_clueless',
    'a ver qué invento ahora...': 'thinking_7_invent',
    'a ver que invento ahora...': 'thinking_7_invent',
    'me duele la cabeza.': 'thinking_8_headache',

    'esta me la sé': 'working_1_confident',
    'esta me la se': 'working_1_confident',
    'todo tengo que hacer...': 'working_2_sigh',
    'no termino más...': 'working_3_endless',
    'no termino mas...': 'working_3_endless',
    'ya fue pongo cualquiera.': 'working_4_blind',
    'aahh bueno me tomo mi descanso.': 'working_5_mate',
    'cuanta presión.': 'working_6_pressure',
    'cuanta presion.': 'working_6_pressure',
    '#@$%&!...': 'working_7_rage',
    'aporreando teclas...': 'working_8_slam',
    'no me apures!': 'working_9_threat',

    'listo bro, no me hables más.': 'done_1_bye',
    'listo bro, no me hables mas.': 'done_1_bye',
    'chau. vuelvo a la siesta.': 'done_2_sleep',
    'ahí tenés, pesado.': 'done_3_throw',
    'ahi tenes, pesado.': 'done_3_throw',
    'de nada...': 'done_4_whatever',
    'por hoy ya no vuelvas.': 'done_5_closed',
    '...': 'done_6_silence',
    'andá.': 'done_7_leave',
    'anda.': 'done_7_leave'
  };

  function parsePhraseAnim(rawPhrase, fallbackAnim) {
    if (!rawPhrase) return { text: '', anim: fallbackAnim };
    const match = rawPhrase.match(/\[(.*?)\]\s*$/);
    if (match) {
      const anim = match[1].trim();
      const text = rawPhrase.replace(/\[.*?\]\s*$/, '').trim();
      return { text, anim: anim || fallbackAnim };
    }
    const clean = rawPhrase.trim();
    const known = KNOWN_PHRASE_ANIMS[clean.toLowerCase()];
    if (known) {
      return { text: clean, anim: known };
    }
    return { text: clean, anim: fallbackAnim };
  }

  const MODES_STORAGE_KEY = 'jarvis_mascot_modes';
  const phraseIndices = {
    tap: 0,
    reading: 0,
    thinking: 0,
    working: 0,
    done: 0
  };

  function getEffectivePhrases(category) {
    try {
      const custom = JSON.parse(localStorage.getItem('jarvis_mascot_phrases'));
      if (custom && Array.isArray(custom[category]) && custom[category].length) {
        return custom[category];
      }
    } catch (_) {}
    return PHRASES[category] || [];
  }

  function getEffectiveMode(category) {
    try {
      const modes = JSON.parse(localStorage.getItem(MODES_STORAGE_KEY));
      if (modes && modes[category]) return modes[category];
    } catch (_) {}
    return 'random';
  }

  function randomChoice(arr) {
    if (!arr || !arr.length) return '';
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function getNextPhrase(category) {
    const list = getEffectivePhrases(category);
    if (!list || !list.length) return '';
    const mode = getEffectiveMode(category);
    if (mode === 'sequential') {
      const idx = (phraseIndices[category] || 0) % list.length;
      phraseIndices[category] = (idx + 1) % list.length;
      return list[idx];
    }
    return randomChoice(list);
  }

  // ── Variedad por herramienta ──
  // Cada tool_use dispara un "mood" distinto (normal/aburrido/distraído) con su
  // propio pool de frases y, para aburrido/distraído, un tratamiento visual
  // distinto (sin generar assets nuevos: reusa reading.webp + CSS).
  const MOOD_NORMAL = 'normal';
  const MOOD_BORED = 'bored';
  const MOOD_DISTRACTED = 'distracted';

  function toolCategory(name) {
    if (!name) return 'default';
    const n = String(name).toLowerCase();
    if (n === 'bash' || n === 'command_execution' || n === 'shell') return 'bash';
    if (n === 'edit' || n === 'write' || n === 'notebookedit') return 'edit';
    if (n === 'read') return 'read';
    if (n === 'grep' || n === 'glob') return 'search';
    if (n === 'webfetch' || n === 'websearch') return 'web';
    if (n === 'task' || n === 'agent') return 'agent';
    return 'default';
  }

  const MOOD_WEIGHTS = {
    bash: [[MOOD_NORMAL, 0.75], [MOOD_DISTRACTED, 0.25]],
    edit: [[MOOD_NORMAL, 0.35], [MOOD_BORED, 0.65]],
    read: [[MOOD_DISTRACTED, 0.7], [MOOD_NORMAL, 0.3]],
    search: [[MOOD_NORMAL, 1]],
    web: [[MOOD_NORMAL, 0.65], [MOOD_BORED, 0.35]],
    agent: [[MOOD_BORED, 0.75], [MOOD_NORMAL, 0.25]],
    default: [[MOOD_NORMAL, 1]]
  };

  const TOOL_PHRASES = {
    bash: {
      normal: ['Ah, la consola. Lo único que me gusta.', 'A ver qué rompo esta vez.', '#@$%&! comandos...', 'Bash, mi terapia.'],
      distracted: ['Corriendo esto a medias, ya vuelvo.', 'Miro la terminal de reojo.', 'Ejecuto y me voy a otro lado.']
    },
    edit: {
      normal: ['Escribiendo, aunque no quiera.', 'Un archivo más, la lista no termina nunca.', 'Tecleando por obligación.'],
      bored: ['Un... carácter... a la vez...', 'Esto es arte, no me apures.', 'Zzz... ah, perdón, seguía escribiendo.', 'Tipeo lento a propósito.']
    },
    read: {
      distracted: ['Leyendo... o mirando para el costado.', '¿Esto hay que leerlo TODO?', 'Ya leí la primera línea, ¿alcanza?', 'Mis ojos están en el archivo, mi cabeza no.'],
      normal: ['Leyendo, no molesten.', 'Analizando letra por letra.']
    },
    search: {
      normal: ['Buscando como loco.', '¿Dónde está...? ¡Ahí!', 'Grep, mi único amigo de verdad.', 'Rastreando cada carpeta.']
    },
    web: {
      normal: ['Mirando internet, como cualquiera.', 'Buscando en la web, tranqui.', 'Googleando por vos.'],
      bored: ['Scrolleando resultados sin ganas.', 'Internet está lento, o yo.']
    },
    agent: {
      bored: ['Mandé a otro a laburar por mí.', 'Delegué, ¿algún problema?', 'Que labure el subagente, yo superviso.', 'Tercerizado. Como corresponde.'],
      normal: ['Coordinando el trabajo sucio.']
    }
  };

  function pickMood(category) {
    const weights = MOOD_WEIGHTS[category] || MOOD_WEIGHTS.default;
    const total = weights.reduce((sum, [, w]) => sum + w, 0);
    let r = Math.random() * total;
    for (const [mood, w] of weights) {
      if (r < w) return mood;
      r -= w;
    }
    return weights[0][0];
  }

  function moodVisual(mood) {
    return mood === MOOD_BORED ? 'reading' : 'working';
  }

  function moodPhrase(category, mood) {
    const pool = TOOL_PHRASES[category];
    if (pool && pool[mood] && pool[mood].length) return randomChoice(pool[mood]);
    if (pool && pool.normal && pool.normal.length) return randomChoice(pool.normal);
    return getNextPhrase('working');
  }

  // Drag & drop state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;
  let hasMoved = false;

  function init() {
    ALL_ANIMATIONS.forEach(st => {
      const img = new Image();
      img.src = `${ASSET_DIR}/${st}.webp`;
      preloadedImages[st] = img;
    });

    setupDOM();
    restorePosition();
    updateDOM();

    window.addEventListener('resize', keepWithinBounds);
  }

  function setupDOM() {
    const wrap = document.getElementById('messages-wrap');
    if (!wrap) return;

    let widget = document.getElementById('mascot-widget');
    if (!widget) {
      widget = document.createElement('div');
      widget.id = 'mascot-widget';
      widget.className = 'mascot-widget';
      widget.setAttribute('aria-label', 'Compañero J.A.R.V.I.S');
      widget.title = 'El robot gruñón (Arrastrame para moverme · Doble click para reiniciar posición)';

      const bubble = document.createElement('div');
      bubble.id = 'mascot-bubble';
      bubble.className = 'mascot-bubble';
      bubble.hidden = true;

      const img = document.createElement('img');
      img.id = 'mascot-img';
      img.className = 'mascot-img';
      img.alt = 'Mascota J.A.R.V.I.S';
      img.draggable = false;

      widget.appendChild(bubble);
      widget.appendChild(img);

      widget.addEventListener('pointerdown', onPointerDown);
      widget.addEventListener('pointermove', onPointerMove);
      widget.addEventListener('pointerup', onPointerUp);
      widget.addEventListener('pointercancel', onPointerCancel);
      widget.addEventListener('dblclick', resetPosition);

      const jumpBottom = document.getElementById('jump-bottom');
      if (jumpBottom && jumpBottom.parentNode === wrap) {
        wrap.insertBefore(widget, jumpBottom);
      } else {
        wrap.appendChild(widget);
      }
    }
  }

  function showBubble(text, duration = 2200) {
    const bubble = document.getElementById('mascot-bubble');
    if (!bubble || !isEnabled) return;

    bubble.textContent = text;
    bubble.hidden = false;

    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubble.hidden = true;
    }, duration);
  }

  // ── Drag & Drop ──

  function onPointerDown(e) {
    if (!isEnabled) return;
    if (e.button !== undefined && e.button !== 0) return;

    const widget = document.getElementById('mascot-widget');
    const wrap = document.getElementById('messages-wrap');
    if (!widget || !wrap) return;

    isDragging = true;
    hasMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const wrapRect = wrap.getBoundingClientRect();
    const widgetRect = widget.getBoundingClientRect();

    initialLeft = widgetRect.left - wrapRect.left;
    initialTop = widgetRect.top - wrapRect.top;

    widget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!isDragging) return;

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    if (!hasMoved && Math.hypot(dx, dy) > 5) {
      hasMoved = true;
      const widget = document.getElementById('mascot-widget');
      if (widget) widget.classList.add('dragging');
    }

    if (!hasMoved) return;

    const widget = document.getElementById('mascot-widget');
    const wrap = document.getElementById('messages-wrap');
    if (!widget || !wrap) return;

    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    const widgetW = widget.offsetWidth;
    const widgetH = widget.offsetHeight;

    let newLeft = initialLeft + dx;
    let newTop = initialTop + dy;

    newLeft = Math.max(8, Math.min(wrapW - widgetW - 8, newLeft));
    newTop = Math.max(8, Math.min(wrapH - widgetH - 8, newTop));

    widget.style.left = `${newLeft}px`;
    widget.style.top = `${newTop}px`;
    widget.style.right = 'auto';
    widget.style.bottom = 'auto';
  }

  function onPointerUp(e) {
    if (!isDragging) return;
    isDragging = false;

    const widget = document.getElementById('mascot-widget');
    if (!widget) return;

    try { widget.releasePointerCapture(e.pointerId); } catch (_) {}
    widget.classList.remove('dragging');

    if (hasMoved) {
      saveCurrentPosition();
    } else {
      onMascotTap();
    }
  }

  function onPointerCancel(e) {
    if (!isDragging) return;
    isDragging = false;
    const widget = document.getElementById('mascot-widget');
    if (widget) {
      widget.classList.remove('dragging');
      try { widget.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  }

  function saveCurrentPosition() {
    const widget = document.getElementById('mascot-widget');
    const wrap = document.getElementById('messages-wrap');
    if (!widget || !wrap) return;

    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    if (wrapW === 0 || wrapH === 0) return;

    const left = widget.offsetLeft;
    const top = widget.offsetTop;

    const pos = {
      xPct: left / wrapW,
      yPct: top / wrapH
    };
    localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(pos));
  }

  function restorePosition() {
    const widget = document.getElementById('mascot-widget');
    const wrap = document.getElementById('messages-wrap');
    if (!widget || !wrap) return;

    const raw = localStorage.getItem(POS_STORAGE_KEY);
    if (!raw) return;

    try {
      const pos = JSON.parse(raw);
      if (typeof pos.xPct === 'number' && typeof pos.yPct === 'number') {
        const wrapW = wrap.clientWidth;
        const wrapH = wrap.clientHeight;
        if (wrapW > 0 && wrapH > 0) {
          const widgetW = widget.offsetWidth || 68;
          const widgetH = widget.offsetHeight || 68;
          const left = Math.max(8, Math.min(wrapW - widgetW - 8, pos.xPct * wrapW));
          const top = Math.max(8, Math.min(wrapH - widgetH - 8, pos.yPct * wrapH));

          widget.style.left = `${left}px`;
          widget.style.top = `${top}px`;
          widget.style.right = 'auto';
          widget.style.bottom = 'auto';
        }
      }
    } catch (_) {}
  }

  function keepWithinBounds() {
    const widget = document.getElementById('mascot-widget');
    const wrap = document.getElementById('messages-wrap');
    if (!widget || !wrap || widget.style.left === '') return;

    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    const widgetW = widget.offsetWidth;
    const widgetH = widget.offsetHeight;

    let left = widget.offsetLeft;
    let top = widget.offsetTop;

    left = Math.max(8, Math.min(wrapW - widgetW - 8, left));
    top = Math.max(8, Math.min(wrapH - widgetH - 8, top));

    widget.style.left = `${left}px`;
    widget.style.top = `${top}px`;
  }

  function resetPosition(e) {
    if (e) e.stopPropagation();
    const widget = document.getElementById('mascot-widget');
    if (!widget) return;

    localStorage.removeItem(POS_STORAGE_KEY);
    widget.style.left = '';
    widget.style.top = '';
    widget.style.right = '';
    widget.style.bottom = '';

    showBubble('Al fin en mi rincón...', 1800);
    triggerPopAnimation();
  }

  function onMascotTap() {
    if (!isEnabled) return;
    const widget = document.getElementById('mascot-widget');
    if (!widget) return;

    const raw = getNextPhrase('tap');
    const { text, anim } = parsePhraseAnim(raw, 'tap_1_question');

    currentVisual = anim;
    updateDOM();

    showBubble(text, 2200);

    widget.classList.add('tapped');
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      widget.classList.remove('tapped');
    }, 550);

    clearTimeout(tapVisualTimer);
    tapVisualTimer = setTimeout(() => {
      if (currentState === 'idle') {
        currentVisual = 'idle';
        updateDOM();
      }
    }, 2400);
  }

  // ── Máquina de Estados ──

  function setState(state, toolName) {
    if (!STATES.includes(state)) return;

    clearTimeout(tapVisualTimer);

    if (state === 'working') {
      // Cada tool_use nuevo re-sortea mood + frase, aunque ya estuviera 'working'
      // (si no, todas las herramientas de un mismo turno se verían idénticas).
      const isNewTool = toolName && toolName !== currentTool;
      if (toolName) currentTool = toolName;
      if (isNewTool || currentState !== 'working') {
        const category = toolCategory(currentTool);
        currentMood = pickMood(category);
        const fallback = moodVisual(currentMood);
        const raw = moodPhrase(category, currentMood);
        const { text, anim } = parsePhraseAnim(raw, fallback);
        currentVisual = anim;
        showBubble(text, 2200);
        triggerPopAnimation();
      }
      currentState = 'working';
      updateDOM();
      return;
    }

    if (state === currentState && state !== 'done') return;

    clearTimeout(doneTimer);
    clearTimeout(readingTimer);

    currentState = state;
    currentTool = null;
    currentMood = null;

    // Bocadillo de queja y animación según la frase
    if (PHRASES[state]) {
      const raw = getNextPhrase(state);
      const { text, anim } = parsePhraseAnim(raw, state);
      currentVisual = anim;
      showBubble(text, state === 'done' ? 2600 : 2200);
    } else {
      currentVisual = state;
    }

    if (state === 'reading') {
      readingTimer = setTimeout(() => {
        if (currentState === 'reading') {
          setState('thinking');
        }
      }, 1600);
    } else if (state === 'done') {
      doneTimer = setTimeout(() => {
        if (currentState === 'done') {
          setState('idle');
        }
      }, 2600);
    }

    triggerPopAnimation();
    updateDOM();
  }

  function triggerPopAnimation() {
    const widget = document.getElementById('mascot-widget');
    if (!widget) return;

    widget.classList.remove('state-pop');
    void widget.offsetWidth;
    widget.classList.add('state-pop');

    clearTimeout(popTimer);
    popTimer = setTimeout(() => {
      widget.classList.remove('state-pop');
    }, 350);
  }

  function updateDOM() {
    let widget = document.getElementById('mascot-widget');
    if (!widget) {
      setupDOM();
      widget = document.getElementById('mascot-widget');
      if (!widget) return;
    }

    const img = document.getElementById('mascot-img');
    if (!img) return;

    if (!isEnabled) {
      widget.hidden = true;
      return;
    }

    widget.hidden = false;
    widget.dataset.state = currentState;

    const targetSrc = `${ASSET_DIR}/${currentVisual}.webp`;
    if (!img.src.endsWith(targetSrc)) {
      img.src = targetSrc;
    }

    img.onerror = () => {
      if (currentVisual !== currentState) {
        currentVisual = currentState;
        img.src = `${ASSET_DIR}/${currentState}.webp`;
      }
    };

    img.classList.toggle('mood-bored', currentState === 'working' && currentMood === 'bored');
    img.classList.toggle('mood-distracted', currentState === 'working' && currentMood === 'distracted');
  }

  function setEnabled(val) {
    isEnabled = Boolean(val);
    updateDOM();
  }

  function getState() {
    return currentState;
  }

  window.Mascot = {
    init,
    setState,
    getState,
    setEnabled,
    isEnabled: () => isEnabled,
    resetPosition,
    showBubble
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
