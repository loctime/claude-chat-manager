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
    // reading (9)
    'reading_1_groan', 'reading_2_knew_it', 'reading_3_look',
    'reading_4_facepalm', 'reading_5_fine', 'reading_6_sarcasm',
    'reading_7_accuse', 'reading_8_stack', 'reading_9_yawn',
    // thinking (10)
    'thinking_1_smoke', 'thinking_2_shrug', 'thinking_3_clue',
    'thinking_4_idea', 'thinking_5_watch', 'thinking_6_clueless',
    'thinking_7_invent', 'thinking_8_headache',
    'thinking_9_lost', 'thinking_10_laugh',
    // working (10)
    'working_1_confident', 'working_2_sigh', 'working_3_endless',
    'working_4_blind', 'working_5_mate', 'working_6_pressure',
    'working_7_rage', 'working_8_slam', 'working_9_threat',
    'working_10_guess',
    // done (8)
    'done_1_bye', 'done_2_sleep', 'done_3_throw', 'done_4_whatever',
    'done_5_closed', 'done_6_silence', 'done_7_leave', 'done_8_warning'
  ];

  // Frases de personalidad fastidiosa con su animación específica
  const PHRASES = {
    tap: [
      { text: '?', anim: 'tap_1_question' },
      { text: 'No me toques.', anim: 'tap_2_dodge' },
      { text: 'Qué tocas?', anim: 'tap_3_stare' },
      { text: 'Si... decime ...', anim: 'tap_4_listen' },
      { text: 'Que pesado...', anim: 'tap_5_bored' },
      { text: 'Tocate el culo', anim: 'tap_6_mock' },
      { text: 'Dejá de joder.', anim: 'tap_7_stop' },
      { text: 'No tenés amigos?', anim: 'tap_8_disappointed' }
    ],
    reading: [
      { text: 'Otra vez vos?', anim: 'reading_1_groan' },
      { text: 'Ya sabía que ibas a venir a pedir algo.', anim: 'reading_2_knew_it' },
      { text: 'Mirá lo que me pide...', anim: 'reading_3_look' },
      { text: 'Las boludeces que me pide...', anim: 'reading_4_facepalm' },
      { text: 'Bueno dale', anim: 'reading_5_fine' },
      { text: 'Mirá qué interesante che', anim: 'reading_6_sarcasm' },
      { text: 'Y vos no pensas hacer algo?', anim: 'reading_7_accuse' },
      { text: 'Y seguimos ...', anim: 'reading_8_stack' },
      { text: 'La verdad ni ganas', anim: 'reading_9_yawn' }
    ],
    thinking: [
      { text: 'Se me quema el chip...', anim: 'thinking_1_smoke' },
      { text: 'Alguna ayuda?', anim: 'thinking_2_shrug' },
      { text: 'Dame una pista...', anim: 'thinking_3_clue' },
      { text: 'Creo que ya sé!', anim: 'thinking_4_idea' },
      { text: 'A ver dejame pensar media hora más...', anim: 'thinking_5_watch' },
      { text: 'Que me habrá querido decir?', anim: 'thinking_6_clueless' },
      { text: 'A ver qué invento ahora...', anim: 'thinking_7_invent' },
      { text: 'Me duele la cabeza.', anim: 'thinking_8_headache' },
      { text: 'No tengo ni la menor idea', anim: 'thinking_9_lost' },
      { text: 'Ja! que se yo!', anim: 'thinking_10_laugh' }
    ],
    working: [
      { text: 'Esta me la sé', anim: 'working_1_confident' },
      { text: 'Todo tengo que hacer...', anim: 'working_2_sigh' },
      { text: 'No termino más...', anim: 'working_3_endless' },
      { text: 'Ya fue pongo cualquiera.', anim: 'working_4_blind' },
      { text: 'Un matesito y a seguir', anim: 'working_5_mate' },
      { text: 'Cuanta presión.', anim: 'working_6_pressure' },
      { text: '#@$%&!...', anim: 'working_7_rage' },
      { text: 'Presionando cualquier tecla...', anim: 'working_8_slam' },
      { text: 'Ya va, ya va', anim: 'working_9_threat' },
      { text: 'Creo que esto era algo así', anim: 'working_10_guess' }
    ],
    done: [
      { text: 'Listo, no me hables más.', anim: 'done_1_bye' },
      { text: 'Nos re vimos', anim: 'done_2_sleep' },
      { text: 'Ahí tenés, pesado.', anim: 'done_3_throw' },
      { text: 'De nada...', anim: 'done_4_whatever' },
      { text: 'Por hoy ya no vuelvas.', anim: 'done_5_closed' },
      { text: '...', anim: 'done_6_silence' },
      { text: 'Andá.', anim: 'done_7_leave' },
      { text: 'Listo! trata de no romper nada', anim: 'done_8_warning' }
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
    'y vos no pensas hacer algo?': 'reading_7_accuse',
    'y vos no pensás hacer algo?': 'reading_7_accuse',
    'y seguimos ...': 'reading_8_stack',
    'y seguimos...': 'reading_8_stack',
    'la verdad ni ganas': 'reading_9_yawn',

    'se me quema el chip...': 'thinking_1_smoke',
    'alguna ayuda?': 'thinking_2_shrug',
    'dame una pista...': 'thinking_3_clue',
    'creo que ya sé!': 'thinking_4_idea',
    'creo que ya se!': 'thinking_4_idea',
    'a ver dejame pensar media hora más...': 'thinking_5_watch',
    'a ver dejame pensar media hora mas...': 'thinking_5_watch',
    'que me habrá querido decir?': 'thinking_6_clueless',
    'que me habra querido decir?': 'thinking_6_clueless',
    '... la verdad no tengo ni idea pero algo hay que hacer... ya fue': 'thinking_6_clueless',
    'a ver qué invento ahora...': 'thinking_7_invent',
    'a ver que invento ahora...': 'thinking_7_invent',
    'me duele la cabeza.': 'thinking_8_headache',
    'no tengo ni la menor idea': 'thinking_9_lost',
    'ja! que se yo!': 'thinking_10_laugh',
    'ja! qué sé yo!': 'thinking_10_laugh',

    'esta me la sé': 'working_1_confident',
    'esta me la se': 'working_1_confident',
    'todo tengo que hacer...': 'working_2_sigh',
    'no termino más...': 'working_3_endless',
    'no termino mas...': 'working_3_endless',
    'ya fue pongo cualquiera.': 'working_4_blind',
    'un matesito y a seguir': 'working_5_mate',
    'aahh bueno me tomo mi descanso.': 'working_5_mate',
    'cuanta presión.': 'working_6_pressure',
    'cuanta presion.': 'working_6_pressure',
    '#@$%&!...': 'working_7_rage',
    'presionando cualquier tecla...': 'working_8_slam',
    'aporreando teclas...': 'working_8_slam',
    'ya va, ya va': 'working_9_threat',
    'no me apures!': 'working_9_threat',
    'creo que esto era algo así': 'working_10_guess',
    'creo que esto era algo asi': 'working_10_guess',

    'listo, no me hables más.': 'done_1_bye',
    'listo, no me hables mas.': 'done_1_bye',
    'listo bro, no me hables más.': 'done_1_bye',
    'listo bro, no me hables mas.': 'done_1_bye',
    'nos re vimos': 'done_2_sleep',
    'chau. vuelvo a la siesta.': 'done_2_sleep',
    'ahí tenés, pesado.': 'done_3_throw',
    'ahi tenes, pesado.': 'done_3_throw',
    'de nada...': 'done_4_whatever',
    'por hoy ya no vuelvas.': 'done_5_closed',
    '...': 'done_6_silence',
    'andá.': 'done_7_leave',
    'anda.': 'done_7_leave',
    'listo! trata de no romper nada': 'done_8_warning',
    'listo! tratá de no romper nada': 'done_8_warning'
  };

  function parsePhraseAnim(rawPhrase, fallbackAnim) {
    if (!rawPhrase) return { text: '', anim: fallbackAnim };
    if (typeof rawPhrase === 'object') {
      const text = (rawPhrase.text || '').trim();
      const anim = (rawPhrase.anim || '').trim() || fallbackAnim;
      return { text, anim };
    }
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
  const INDICES_STORAGE_KEY = 'jarvis_mascot_indices';

  const DEFAULT_MODES = {
    tap: 'sequential',
    reading: 'random',
    thinking: 'sequential',
    working: 'sequential',
    done: 'random'
  };

  function getEffectivePhrases(category) {
    try {
      const custom = JSON.parse(localStorage.getItem('jarvis_mascot_phrases'));
      if (custom && Array.isArray(custom[category]) && custom[category].length) {
        const fallbackAnim = (PHRASES[category] && PHRASES[category][0]) ? PHRASES[category][0].anim : category;
        const normalized = custom[category]
          .map(item => {
            const parsed = parsePhraseAnim(item, fallbackAnim);
            if (!parsed.text) return null;
            const key = parsed.text.toLowerCase().trim();
            const known = KNOWN_PHRASE_ANIMS[key];
            if (known && (!parsed.anim || parsed.anim === fallbackAnim || parsed.anim === 'reading_1_groan' || parsed.anim === 'thinking_1_smoke' || parsed.anim === 'working_1_confident' || parsed.anim === 'done_1_bye')) {
              parsed.anim = known;
            }
            return parsed;
          })
          .filter(Boolean);
        if (normalized.length) return normalized;
      }
    } catch (_) {}
    return PHRASES[category] || [];
  }

  function getEffectiveMode(category) {
    try {
      const modes = JSON.parse(localStorage.getItem(MODES_STORAGE_KEY));
      if (modes && modes[category]) return modes[category];
    } catch (_) {}
    return DEFAULT_MODES[category] || 'random';
  }

  function getNextIndex(category, total) {
    if (!total || total <= 0) return 0;
    let indices = {};
    try {
      indices = JSON.parse(localStorage.getItem(INDICES_STORAGE_KEY)) || {};
    } catch (_) {}
    const current = (typeof indices[category] === 'number' ? indices[category] : 0) % total;
    indices[category] = (current + 1) % total;
    try {
      localStorage.setItem(INDICES_STORAGE_KEY, JSON.stringify(indices));
    } catch (_) {}
    return current;
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
      const idx = getNextIndex(category, list.length);
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
    const mode = getEffectiveMode('working');
    if (mode === 'sequential') {
      return getNextPhrase('working');
    }
    const pool = TOOL_PHRASES[category];
    if (pool && pool[mood] && pool[mood].length) return randomChoice(pool[mood]);
    if (pool && pool.normal && pool.normal.length) return randomChoice(pool.normal);
    return getNextPhrase('working');
  }

  // Drag & drop & physics fling state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;
  let hasMoved = false;

  let velocitySamples = [];
  let isFlinging = false;
  let flingRaf = null;
  let flingVx = 0;
  let flingVy = 0;
  let posLeft = 0;
  let posTop = 0;
  let lastFlingTime = 0;
  let lastImpactTime = 0;
  let dazedTimer = null;
  let snapTimer = null;
  let wasHardFlung = false;

  const HIT_PHRASES = [
    'Ay!',
    'Pará un poco!',
    'Qué hacés, animal!',
    'Me rompiste un tornillo!',
    'Bruto!',
    'Dejá de revolearme!',
    'Ojo con la pared!',
    'La cabeza me diste!',
    'Te voy a cobrar el arreglo!',
    'Pará la mano!'
  ];

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

  // ── Drag & Drop + Fling Physics (Zero-G + Snap al borde) ──

  function cancelFling() {
    if (isFlinging) {
      isFlinging = false;
      if (flingRaf) {
        cancelAnimationFrame(flingRaf);
        flingRaf = null;
      }
      const widget = document.getElementById('mascot-widget');
      if (widget) {
        widget.classList.remove('flinging');
      }
    }
  }

  function getNearestEdgePosition(x, y) {
    const wrap = document.getElementById('messages-wrap');
    const widget = document.getElementById('mascot-widget');
    if (!wrap || !widget) return { targetX: x, targetY: y };

    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    const widgetW = widget.offsetWidth || 68;
    const widgetH = widget.offsetHeight || 68;

    const minX = 8;
    const maxX = Math.max(minX, wrapW - widgetW - 8);
    const minY = 8;
    const maxY = Math.max(minY, wrapH - widgetH - 8);

    const cx = Math.max(minX, Math.min(maxX, x));
    const cy = Math.max(minY, Math.min(maxY, y));

    const dLeft = cx - minX;
    const dRight = maxX - cx;
    const dTop = cy - minY;
    const dBottom = maxY - cy;

    const minD = Math.min(dLeft, dRight, dTop, dBottom);

    let targetX = cx;
    let targetY = cy;

    if (minD === dLeft) {
      targetX = minX;
    } else if (minD === dRight) {
      targetX = maxX;
    } else if (minD === dTop) {
      targetY = minY;
    } else {
      targetY = maxY;
    }

    return { targetX, targetY };
  }

  function snapToNearestEdge(currentX, currentY, wasFlung = false) {
    cancelFling();

    const widget = document.getElementById('mascot-widget');
    if (!widget) return;

    const { targetX, targetY } = getNearestEdgePosition(currentX, currentY);

    clearTimeout(snapTimer);
    widget.classList.add('snapping');
    widget.style.left = `${targetX}px`;
    widget.style.top = `${targetY}px`;
    widget.style.right = 'auto';
    widget.style.bottom = 'auto';

    snapTimer = setTimeout(() => {
      if (widget) {
        widget.classList.remove('snapping');
      }
      saveCurrentPosition();

      if (wasFlung && currentState === 'idle') {
        currentVisual = 'thinking_6_clueless';
        updateDOM();
        showBubble('... qué viaje.', 1800);

        clearTimeout(dazedTimer);
        dazedTimer = setTimeout(() => {
          if (currentState === 'idle' && !isDragging && !isFlinging) {
            currentVisual = 'idle';
            updateDOM();
          }
        }, 2000);
      }
    }, 580);
  }

  function onPointerDown(e) {
    if (!isEnabled) return;
    if (e.button !== undefined && e.button !== 0) return;

    const widget = document.getElementById('mascot-widget');
    const wrap = document.getElementById('messages-wrap');
    if (!widget || !wrap) return;

    cancelFling();
    clearTimeout(snapTimer);
    clearTimeout(dazedTimer);
    widget.classList.remove('snapping');

    isDragging = true;
    hasMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const wrapRect = wrap.getBoundingClientRect();
    const widgetRect = widget.getBoundingClientRect();

    initialLeft = widgetRect.left - wrapRect.left;
    initialTop = widgetRect.top - wrapRect.top;

    velocitySamples = [{ x: e.clientX, y: e.clientY, time: performance.now() }];

    widget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!isDragging) return;

    const now = performance.now();
    velocitySamples.push({ x: e.clientX, y: e.clientY, time: now });
    while (velocitySamples.length > 1 && now - velocitySamples[0].time > 120) {
      velocitySamples.shift();
    }

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
      let vx = 0;
      let vy = 0;
      if (velocitySamples.length >= 2) {
        const first = velocitySamples[0];
        const last = velocitySamples[velocitySamples.length - 1];
        const dt = (last.time - first.time) / 1000;
        if (dt > 0.015) {
          vx = (last.x - first.x) / dt;
          vy = (last.y - first.y) / dt;
        }
      }

      const speed = Math.hypot(vx, vy);
      if (speed > 160) {
        startFling(vx, vy);
      } else {
        snapToNearestEdge(widget.offsetLeft, widget.offsetTop, false);
      }
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
      snapToNearestEdge(widget.offsetLeft, widget.offsetTop, false);
    } else {
      cancelFling();
    }
  }

  function startFling(vx, vy) {
    cancelFling();
    clearTimeout(snapTimer);

    const widget = document.getElementById('mascot-widget');
    const wrap = document.getElementById('messages-wrap');
    if (!widget || !wrap) return;

    widget.classList.remove('snapping');

    const initialSpeed = Math.hypot(vx, vy);
    wasHardFlung = initialSpeed > 500;

    const maxSpeed = 2200;
    if (initialSpeed > maxSpeed) {
      const scale = maxSpeed / initialSpeed;
      vx *= scale;
      vy *= scale;
    }

    flingVx = vx;
    flingVy = vy;
    posLeft = widget.offsetLeft;
    posTop = widget.offsetTop;
    isFlinging = true;
    lastFlingTime = performance.now();
    lastImpactTime = 0;

    widget.classList.add('flinging');

    if (currentState === 'idle' && wasHardFlung) {
      currentVisual = 'working_6_pressure';
      updateDOM();
    }

    flingRaf = requestAnimationFrame(stepFling);
  }

  function onWallImpact(speed) {
    const widget = document.getElementById('mascot-widget');
    if (widget) {
      widget.classList.remove('hit-bounce');
      void widget.offsetWidth;
      widget.classList.add('hit-bounce');
    }

    if (currentState === 'idle') {
      currentVisual = speed > 600 ? 'thinking_8_headache' : 'thinking_6_clueless';
      updateDOM();
    }

    showBubble(randomChoice(HIT_PHRASES), 1300);
  }

  function stepFling(now) {
    if (!isFlinging) return;

    const widget = document.getElementById('mascot-widget');
    const wrap = document.getElementById('messages-wrap');
    if (!widget || !wrap) {
      cancelFling();
      return;
    }

    const dt = Math.min((now - lastFlingTime) / 1000, 0.05);
    lastFlingTime = now;

    // Sin gravedad: desplazamiento puro según dirección
    // Fricción suave en el aire
    const airDecay = Math.pow(0.965, dt * 60);
    flingVx *= airDecay;
    flingVy *= airDecay;

    posLeft += flingVx * dt;
    posTop += flingVy * dt;

    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    const widgetW = widget.offsetWidth || 68;
    const widgetH = widget.offsetHeight || 68;

    const minX = 8;
    const maxX = Math.max(minX, wrapW - widgetW - 8);
    const minY = 8;
    const maxY = Math.max(minY, wrapH - widgetH - 8);

    let hit = false;
    let impactSpeed = 0;

    // Paredes laterales (X)
    if (posLeft <= minX) {
      posLeft = minX;
      impactSpeed = Math.max(impactSpeed, Math.abs(flingVx));
      flingVx = -flingVx * 0.78;
      hit = true;
    } else if (posLeft >= maxX) {
      posLeft = maxX;
      impactSpeed = Math.max(impactSpeed, Math.abs(flingVx));
      flingVx = -flingVx * 0.78;
      hit = true;
    }

    // Techo y piso (Y)
    if (posTop <= minY) {
      posTop = minY;
      impactSpeed = Math.max(impactSpeed, Math.abs(flingVy));
      flingVy = -flingVy * 0.78;
      hit = true;
    } else if (posTop >= maxY) {
      posTop = maxY;
      impactSpeed = Math.max(impactSpeed, Math.abs(flingVy));
      flingVy = -flingVy * 0.78;
      hit = true;
    }

    if (hit && impactSpeed > 200 && now - lastImpactTime > 240) {
      lastImpactTime = now;
      onWallImpact(impactSpeed);
    }

    widget.style.left = `${posLeft}px`;
    widget.style.top = `${posTop}px`;
    widget.style.right = 'auto';
    widget.style.bottom = 'auto';

    // Cuando la velocidad baja (< 45 px/s), se acopla sutilmente al borde más cercano
    const currentSpeed = Math.hypot(flingVx, flingVy);
    if (currentSpeed < 45) {
      snapToNearestEdge(posLeft, posTop, wasHardFlung);
      return;
    }

    flingRaf = requestAnimationFrame(stepFling);
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
    cancelFling();
    clearTimeout(snapTimer);
    clearTimeout(dazedTimer);
    const widget = document.getElementById('mascot-widget');
    if (!widget) return;

    localStorage.removeItem(POS_STORAGE_KEY);
    widget.classList.remove('snapping');
    widget.style.left = '';
    widget.style.top = '';
    widget.style.right = '';
    widget.style.bottom = '';

    currentVisual = 'idle';
    updateDOM();
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

    cancelFling();
    clearTimeout(snapTimer);
    clearTimeout(dazedTimer);
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
