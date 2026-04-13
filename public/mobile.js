const socket = io();
  let mode = 'gyro';
  let gyroActive = false;
  let lastDir = null;
  let lastDirTime = 0;
  const THRESHOLD_DEG = 12;
  const COOLDOWN_MS   = 280;
  let lastShakeTime = 0;
  let currentSection = null;
  let lastNavTime = 0;


  // --- VARIABLES BLUETOOTH HUE ---
    const HUE_SERVICE_UUID = '932c32bd-0000-47a2-835a-a8d455b859dd';
    const CHAR_ON_OFF_UUID = '932c32bd-0002-47a2-835a-a8d455b859dd';
    let hueOnOffChar = null;

    async function connectHueBluetooth() {
      try {
        showToast('Buscando luz...', 'blue');
        const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true, // Aceptamos todo para probar
        optionalServices: [HUE_SERVICE_UUID]
      });
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(HUE_SERVICE_UUID);
        hueOnOffChar = await service.getCharacteristic(CHAR_ON_OFF_UUID);
        
        showToast('✓ Luz vinculada por Bluetooth');
        playSuccess();
      } catch(e) {
        console.error(e);
        showToast('✗ Error al vincular Bluetooth', 'error');
      }
    }
  


  // ── Audio ──
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  function playTone(freq, duration, type = 'sine', gain = 0.35, startDelay = 0) {
    try {
      const ctx = getAudioCtx();
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.connect(env); env.connect(ctx.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime + startDelay);
      env.gain.setValueAtTime(0, ctx.currentTime + startDelay);
      env.gain.linearRampToValueAtTime(gain, ctx.currentTime + startDelay + 0.01);
      env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startDelay + duration);
      osc.start(ctx.currentTime + startDelay);
      osc.stop(ctx.currentTime + startDelay + duration + 0.05);
    } catch(e) {}
  }
  function playSuccess() { playTone(523, 0.12, 'sine', 0.35, 0); playTone(659, 0.18, 'sine', 0.40, 0.13); }
  function playError()   { playTone(220, 0.25, 'sine', 0.35, 0); playTone(180, 0.20, 'sine', 0.30, 0.20); }
  // Sonido especial para "objeto encontrado" — tres notas suaves ascendentes
  function playLocated() {
    playTone(440, 0.10, 'sine', 0.3, 0.00);
    playTone(554, 0.10, 'sine', 0.3, 0.12);
    playTone(659, 0.20, 'sine', 0.35, 0.24);
  }

  // ── Toast ──
  let toastTimer = null;
  function showToast(msg, type = 'ok') {
    const el = document.getElementById('voice-toast');
    el.textContent = msg;
    el.classList.remove('error-toast', 'blue-toast');
    if (type === 'error') el.classList.add('error-toast');
    if (type === 'blue')  el.classList.add('blue-toast');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
  }

  // ── Voz TTS: responder por voz ──
  function speak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = 'es-ES';
    utt.rate = 1.05;
    utt.pitch = 1.0;
    window.speechSynthesis.speak(utt);
  }

  // ── Connection ──
  socket.on('connect', () => {
    document.getElementById('conn-dot').classList.add('on');
    document.getElementById('conn-text').textContent = 'Conectado';
  });
  socket.on('disconnect', () => {
    document.getElementById('conn-dot').classList.remove('on');
    document.getElementById('conn-text').textContent = 'Sin conexión';
  });

  socket.on('stateUpdate', updateInfo);
  socket.on('fullState',   updateInfo);

  // ── Eventos de respuesta del servidor ──

  socket.on('taskSaved', ({ text }) => {
    playSuccess();
    navigator.vibrate && navigator.vibrate([40, 60, 40, 60, 120]);
    showToast('✓ ' + text);
    voiceBtn('success');
    flash('✓ GUARDADO');
  });

  socket.on('taskError', () => {
    playError();
    navigator.vibrate && navigator.vibrate([200, 100, 200]);
    showToast('✗ Error al procesar el comando', 'error');
    voiceBtn('error');
    flash('✗ ERROR');
  });

  socket.on('taskIgnored', () => {
    navigator.vibrate && navigator.vibrate([60, 80, 60]);
    showToast('⚠ Comando no disponible aquí', 'error');
    voiceBtn(null);
    flash('⚠ NO DISPONIBLE');
  });

  socket.on('taskDeleted', ({ text }) => {
    playSuccess();
    navigator.vibrate && navigator.vibrate([40, 60, 120]);
    showToast('🗑 Eliminado: ' + text);
    voiceBtn('success');
    flash('🗑 ELIMINADO');
  });

  socket.on('paymentPaid', ({ name }) => {
    playSuccess();
    navigator.vibrate && navigator.vibrate([40, 60, 120]);
    showToast('✓ Pagado: ' + name);
    voiceBtn('success');
    flash('✓ PAGADO');
  });

  // Cuando el servidor pide confirmación
  socket.on('askPaymentConfirmation', ({ name }) => {
    const msg = `¿Estás seguro que quieres añadir ${name} por 0 euros?`;
    showToast('❓ Esperando confirmación...', 'blue');
    flash('❓ CONFIRMA POR VOZ');
    
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(msg);
    utt.lang = 'es-ES';
    utt.rate = 1.05;
    utt.pitch = 1.0;
    
    utt.onend = () => {
      setTimeout(() => startVoice(), 200); 
    };
    window.speechSynthesis.speak(utt);
  });

  // Si dice que SÍ
  socket.on('paymentConfirmed', ({ name }) => {
    const msg = `Pago de ${name} añadido correctamente.`;
    speak(msg);
    showToast(`✓ Pago añadido`);
    playSuccess();
    flash('✓ PAGO CONFIRMADO');
  });

  // Si dice que NO o cualquier otra cosa
  socket.on('paymentCancelled', ({ name }) => {
    const msg = `Vale, el pago de ${name} no se ha añadido.`;
    speak(msg);
    showToast(`❌ Pago cancelado`, 'error');
    playError();
    flash('❌ CANCELADO');
  });

  // Si no dice nada y salta el temporizador
  socket.on('paymentCancelledTimeout', ({ name }) => {
    const msg = `Al no recibir confirmación, el pago de ${name} no se ha añadido.`;
    speak(msg);
    showToast(`⏳ Tiempo agotado. Pago cancelado`, 'error');
    playError();
    flash('⏳ TIEMPO AGOTADO');
  });

  socket.on('applianceToggled', async ({ name, on }) => {
    playSuccess();
    navigator.vibrate && navigator.vibrate([40, 60, 120]);
    // Comprobar si es algo que sube/baja (persiana/toldo) o enciende/apaga
    const isBlind = /(persiana|estor|toldo)/i.test(name);
    const actionText = isBlind ? (on ? '🔼 Subiendo: ' : '🔽 Bajando: ') : (on ? '💡 Encendido: ' : '🌑 Apagado: ');
    
    showToast(actionText + name);
    voiceBtn('success');
    flash(on ? '⚡ ACTIVADO' : '🌑 DESACTIVADO');

    // --- ENVIAR COMANDO BLUETOOTH DESDE EL MÓVIL ---
    const nombreLuz = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (nombreLuz.includes('luz habitacion')) {
      if (hueOnOffChar) {
        try {
          const val = new Uint8Array([on ? 1 : 0]);
          await hueOnOffChar.writeValue(val);
        } catch(e) {
          console.error('Error enviando BT:', e);
          showToast('✗ Error enviando comando físico', 'error');
        }
      } else {
        showToast('⚠ Luz física no vinculada. Pulsa "Vincular Luz"', 'error');
      }
    }
  });

  // ── : objeto registrado ──
  socket.on('objectLocated', ({ name, location, who }) => {
    playSuccess();
    navigator.vibrate && navigator.vibrate([40, 60, 40, 60, 120]);
    showToast(`📦 ${name} → ${location} (${who})`, 'ok');
    voiceBtn('success');
    flash('📦 UBICACIÓN GUARDADA');
  });

  // ── : respuesta de consulta de objeto — se lee por voz ──
  socket.on('objectQuery', ({ found, name, location, who, when }) => {
    voiceBtn('success');
    if (!found) {
      const msg = `No sé dónde están ${name}. Nadie lo ha registrado todavía.`;
      playError();
      navigator.vibrate && navigator.vibrate([100, 50, 100]);
      showToast(`❓ ${name}: sin ubicación`, 'error');
      speak(msg);
      flash('❓ SIN UBICACIÓN');
    } else {
      const msg = `${name} están en ${location}. Lo dejó ${who} ${when}.`;
      playLocated();
      navigator.vibrate && navigator.vibrate([40, 60, 120]);
      showToast(`📍 ${name} → ${location} · ${who} · ${when}`, 'blue');
      speak(msg);
      flash('📍 ENCONTRADO');
    }
  });

  // ── : error de objeto ──
  socket.on('objectError', ({ msg }) => {
    playError();
    navigator.vibrate && navigator.vibrate([200, 100, 200]);
    showToast('✗ ' + msg, 'error');
    voiceBtn('error');
    flash('✗ ERROR');
  });

  socket.on('voiceUnknown', ({ text }) => {
    navigator.vibrate && navigator.vibrate([60, 80, 60]);
    showToast('⚠ No entendí: "' + text + '"', 'error');
    voiceBtn(null);
    flash('⚠ NO ENTENDIDO');
  });

  function updateInfo(s) {
    currentSection = s.activeSection;

    const sectionNames = { appliances:'🔌 Dispositivos', tasks:'✅ Tareas', objects:'📦 Objetos', payments:'💳 Pagos' };
    document.getElementById('panel-section').textContent = sectionNames[s.activeSection] || '— Inicio';

    // Hint dinámico de voz según la sección
    const hintCard = document.getElementById('voice-hint-card');
    //SESION 1
    // Objeto con todos los comandos de voz, incluyendo el menú principal ("main")
    //const hints = {
    //events: {
      //  t: "📅 Comandos — Eventos", c: "var(--amber)", bg: "rgba(232,160,69,.06)", bd: "rgba(232,160,69,.2)",
        //ex: "Añadir: <span>«Adrián añade evento Cena el día 15 de mayo a las 10 para 4»</span><br>Eventos: <span>«¿Que tengo el dia 2 de mayo?»</span><br>Navegar: <span>«Mes siguiente / anterior»</span><br>Borrar: <span>«Borrar evento día 15 de mayo»</span>"
      //},
      //appliances: {
        //t: "🎤 Comandos — Dispositivos", c: "var(--amber)", bg: "rgba(232,160,69,.06)", bd: "rgba(232,160,69,.2)",
        //ex: "Encender/Subir: <span>«Encender luz» / «Subir persiana salón»</span><br>Apagar/Bajar: <span>«Apagar aire» / «Bajar toldo»</span><br>Añadir: <span>«Añadir aire acondicionado»</span><br>Borrar: <span>«Borrar luz terraza»</span>"
      //},
      //tasks: {
        //t: "🎤 Comandos — Tareas", c: "var(--green)", bg: "rgba(126,201,138,.06)", bd: "rgba(126,201,138,.2)",
        //ex: "Añadir: <span>«Añadir Adrián comprar pan»</span><br>Borrar: <span>«Borrar Adrián comprar pan»</span>"
      //},
      //objects: {
        //t: "🎤 Comandos — Objetos", c: "var(--blue)", bg: "rgba(106,176,232,.06)", bd: "rgba(106,176,232,.2)",
        //ex: "Registrar: <span>«Soy [Tu nombre], He dejado los zapatos en la cocina»</span><br>Consultar: <span>«¿Dónde están las gafas?»</span><br>Nuevo: <span>«Añadir gafas»</span><br>Borrar: <span>«Borrar gafas</span>"
      //},
      //payments: {
        //t: "🎤 Comandos — Pagos", c: "var(--red)", bg: "rgba(224,96,96,.06)", bd: "rgba(224,96,96,.2)",
        //ex: "Añadir: <span>«Añadir Netflix 14 con 99 euros»</span><br>Pagar: <span>«Netflix pagado»</span><br>Pendiente: <span>«Netflix pendiente»</span><br>Borrar: <span>«Borrar Netflix»</span>"
      //},
      //main: {
        //t: "🎤 Comandos — Inicio", c: "var(--cream)", bg: "rgba(240,230,208,.06)", bd: "rgba(240,230,208,.2)",
        //ex: "Navegar: <span>«Dispositivos»,«Eventos»,...</span><br>Eventos: <span>«¿Que tengo el dia 2 de mayo?»</span><br>Clima: <span>«¿Qué tiempo hace?»</span><br>Asistente: <span>«Oye Pepe, ¿quién inventó el WiFi?»</span><br>Global: <span>«¿Qué tiempo hace?»</span>,<span>«¿Dónde están las gafas?»</span>"
      //}
    //};
    
    // Si no hay una sección activa, cargamos la de "main" (Menú Principal)
    const sectionKey = s.activeSection || 'main';
    const h = hints[sectionKey];
    
    // Mostramos los textos de ejemplo de voz y aplicamos los colores de la sección
    if (h) {
      hintCard.style.background = h.bg;
      hintCard.style.borderColor = h.bd;
      document.getElementById('hint-title').style.color = h.c;
      document.getElementById('hint-title').textContent = h.t;
      document.getElementById('hint-examples').innerHTML = h.ex;
      hintCard.classList.add('visible');
    } else {
      hintCard.classList.remove('visible');
    }

    // Actualización del panel inferior
    if (!s.activeSection) {
      const names = ['Dispositivos', 'Tareas', 'Objetos', 'Pagos'];
      const idx   = s.cursor.y * 2 + s.cursor.x;
      document.getElementById('panel-item').textContent = '▶ ' + names[idx];
    } else {
      const lists   = { appliances: s.appliances, tasks: s.tasks, objects: s.objects, payments: s.payments };
      const cursors = { appliances: s.appliancesCursor, tasks: s.tasksCursor, objects: s.objectsCursor, payments: s.paymentsCursor };
      const item    = lists[s.activeSection]?.[cursors[s.activeSection]];
      if (item) {
        if (s.activeSection === 'objects' && item.history && item.history.length > 0) {
          const last = item.history[item.history.length - 1];
          document.getElementById('panel-item').textContent = `▶ ${item.name} · 📍 ${last.location}`;
        } else {
          document.getElementById('panel-item').textContent = '▶ ' + (item.name || item.text || '—');
        }
      }
    }
  }

  // ── Mode switch ──
  function setMode(m) {
    mode = m;
    document.getElementById('mode-gyro').classList.toggle('active', m === 'gyro');
    document.getElementById('mode-buttons').classList.toggle('active', m === 'buttons');
    document.getElementById('gyro-area').classList.toggle('hidden', m === 'buttons');
    document.getElementById('buttons-area').classList.toggle('hidden', m === 'gyro');
  }

  // ── Gyro ──
  function requestGyro() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission()
        .then(perm => { if (perm === 'granted') startGyro(); })
        .catch(console.error);
    } else { startGyro(); }
  }
  function startGyro() {
    document.getElementById('gyro-permission').classList.add('hidden');
    gyroActive = true;
    window.addEventListener('deviceorientation', handleOrientation, true);
    window.addEventListener('devicemotion',      handleMotion,      true);
  }
  if (typeof DeviceOrientationEvent !== 'undefined') {
    if (typeof DeviceOrientationEvent.requestPermission !== 'function') startGyro();
  }

  let baseGamma = null, baseBeta = null, calibrating = true;
  setTimeout(() => { calibrating = false; }, 1500);

  window.resetGyro = function() {
    calibrating = true;
    flash('🔄 CALIBRANDO...');
    navigator.vibrate && navigator.vibrate(30);
    setTimeout(() => { calibrating = false; flash('✅ CENTRADO'); }, 800);
  };

  function handleOrientation(e) {
    const gamma = e.gamma || 0;
    const beta  = e.beta  || 0;
    if (calibrating) { baseGamma = gamma; baseBeta = beta; return; }
    const dGamma = gamma - (baseGamma || 0);
    const dBeta  = beta  - (baseBeta  || 0);
    const area = document.getElementById('gyro-area');
    const w = area.clientWidth, h = area.clientHeight;
    const bx = Math.max(30, Math.min(w - 30, w/2 + (dGamma / 30) * w/2));
    const by = Math.max(30, Math.min(h - 30, h/2 + (dBeta  / 30) * h/2));
    const bubble = document.getElementById('gyro-bubble');
    bubble.style.left = (bx - 30) + 'px';
    bubble.style.top  = (by - 30) + 'px';
    const now = Date.now();
    if (now - lastDirTime < COOLDOWN_MS) return;
    if (now - lastShakeTime < 800) return;
    let dir = null;
    if (Math.abs(dGamma) > Math.abs(dBeta)) {
      if      (dGamma >  THRESHOLD_DEG) dir = 'right';
      else if (dGamma < -THRESHOLD_DEG) dir = 'left';
    } else {
      if      (dBeta  >  THRESHOLD_DEG) dir = 'down';
      else if (dBeta  < -THRESHOLD_DEG) dir = 'up';
    }
    if (beta > 70 && now - lastDirTime > 800) {
      if (currentSection !== null) { sendBack(); lastDirTime = now; }
      return;
    }
    if (dir && dir !== lastDir) { lastDir = dir; navSend(dir); lastDirTime = now; }
    else if (!dir) { lastDir = null; }
  }

  function handleMotion(e) {
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;
    const total = Math.abs(acc.x || 0) + Math.abs(acc.y || 0) + Math.abs(acc.z || 0);
    const now   = Date.now();
    if (total > 40 && now - lastShakeTime > 800) {
      lastShakeTime = now;
      if (currentSection === null) sendEnter();
      else sendAction();
    }
  }

  // ── Send events ──
  window.navSend = function(dir) {
    const now = Date.now();
    if (now - lastNavTime < 250) return;
    lastNavTime = now;
    socket.emit('navigate', dir);
    navigator.vibrate && navigator.vibrate(15);
  };

  function sendEnter() {
    socket.emit('enter');
    flash('↩ ENTRAR');
    navigator.vibrate && navigator.vibrate([30, 20, 30]);
  }

  window.sendBack = function() {
    socket.emit('back');
    flash('🔙 ATRÁS');
    navigator.vibrate && navigator.vibrate([30, 50, 30]);
  };

  function sendAction() {
    socket.emit('action');
    flash('⚡ ACCIÓN');
    navigator.vibrate && navigator.vibrate([20, 10, 20, 10, 30]);
  }

  function flash(msg) {
    const el = document.getElementById('last-cmd');
    el.textContent = msg;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 400);
  }

  function voiceBtn(state) {
    const btn = document.getElementById('btn-voice');
    btn.classList.remove('recording', 'success', 'error');
    if (state) {
      btn.classList.add(state);
      setTimeout(() => btn.classList.remove(state), 1800);
    }
  }

  // ── Voice Recognition ──
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'es-ES';
    recognition.continuous = false;

    window.startVoice = function() {
      getAudioCtx().resume();
      recognition.start();
      document.getElementById('btn-voice').classList.remove('success', 'error');
      document.getElementById('btn-voice').classList.add('recording');
      flash('🎤 ESCUCHANDO...');
      navigator.vibrate && navigator.vibrate(50);
    };

   recognition.onresult = (event) => {
      const text = event.results[0][0].transcript;
      
      const tNorm = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      
      if (tNorm.includes('pikachu te elijo') || tNorm.includes('pikachu vuelve')) {
         const sonidoPikachu = new Audio('./secreto/pikapika.mp3');
         sonidoPikachu.play().catch(err => console.log("Error reproduciendo Pikachu en móvil:", err));
      }
      // -----------------------------------------------

      socket.emit('voiceTask', text);
      flash('🎤 ' + text.slice(0, 22).toUpperCase());
    };

    recognition.onend = () => {
      const btn = document.getElementById('btn-voice');
      if (btn.classList.contains('recording')) btn.classList.remove('recording');
    };

    recognition.onerror = (event) => {
      document.getElementById('btn-voice').classList.remove('recording');
      playError();
      navigator.vibrate && navigator.vibrate([200, 100, 200]);
      flash('✗ ERROR DE VOZ');
      console.error(event.error);
    };
  } else {
    document.getElementById('btn-voice').style.display = 'none';
  }
  socket.on('speakPhrase', (data) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel(); // Corta si estaba diciendo otra cosa
      
      const utterance = new SpeechSynthesisUtterance(data.text);
      utterance.lang = 'es-ES'; // Idioma español
      utterance.rate = 1.0;     // Velocidad normal
      
      // Intentamos reproducirlo
      window.speechSynthesis.speak(utterance);
    }
  });