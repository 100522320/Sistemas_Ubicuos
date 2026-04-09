const socket = io();
  let state = null;
  let apiTasks = [];

  setInterval(() => {
    const d = new Date();
    document.getElementById('clock').textContent =
      d.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }, 1000);

  socket.on('connect', () => {
    document.getElementById('dot').style.background = 'var(--green)';
    document.getElementById('conn-label').textContent = 'CONECTADO';
  });
  socket.on('disconnect', () => {
    document.getElementById('dot').style.background = 'var(--red)';
    document.getElementById('conn-label').textContent = 'SIN CONEXIÓN';
  });

  socket.on('fullState', s => {
    try {
      state = s;
      if (apiTasks.length) s.tasks = apiTasks;
      render(s);
      document.getElementById('conn-overlay').classList.add('hidden');
    } catch(e) { console.error(e); }
  });

  socket.on('stateUpdate', s => {
    try {
      if (apiTasks.length > 0) s.tasks = apiTasks;
      if (s.tasksCursor >= s.tasks.length && s.tasks.length > 0) s.tasksCursor = s.tasks.length - 1;
      state = s;
      render(s);
    } catch(e) { console.error(e); }
  });

  // Historial de objeto (botón acción en móvil)
  socket.on('objectHistory', ({ obj }) => {
    showHistoryModal(obj);
  });

  // ── API TAREAS ──
  async function loadApiTasks() {
    try {
      const res  = await fetch('/api/tasks');
      const data = await res.json();
      apiTasks = data.map(t => ({
        id: t.id, person: t.assignee || 'Casa', text: t.title,
        done: t.done || false, priority: t.priority || 'media',
      }));
      if (state) {
        state.tasks = apiTasks;
        if (state.tasksCursor >= state.tasks.length && state.tasks.length > 0) state.tasksCursor = state.tasks.length - 1;
        if (state.activeSection === 'tasks') renderTasks(state);
        renderTasksStats(state);
      }
    } catch(e) { console.error(e); }
  }
  loadApiTasks();
  setInterval(loadApiTasks, 1500);

  document.getElementById('task-add-btn').addEventListener('click', async () => {
    const title  = document.getElementById('task-title').value.trim();
    const person = document.getElementById('task-person').value.trim() || 'Casa';
    if (!title) return;
    await fetch('/api/tasks', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ title, assignee: person }) });
    document.getElementById('task-title').value  = '';
    document.getElementById('task-person').value = '';
    loadApiTasks();
  });

  // ── RENDER ──
  function render(s) {
    if (!s.activeSection) showGrid(s);
    else showSection(s);
  }

  function showGrid(s) {
    document.getElementById('grid-view').classList.remove('hidden');
    document.getElementById('section-view').classList.remove('visible');
    ['appliances','tasks','objects','payments'].forEach(sec => {
      document.getElementById('view-' + sec).style.display = 'none';
    });
    const sections  = ['appliances','tasks','objects','payments'];
    const activeIdx = s.cursor.y * 2 + s.cursor.x;
    sections.forEach((sec, i) => {
      document.getElementById('card-' + sec).classList.toggle('active', i === activeIdx);
    });
    renderAppliancesStats(s);
    renderTasksStats(s);
    renderObjectsStats(s);
    renderPaymentsStats(s);
  }

  function renderAppliancesStats(s) {
    const on = s.appliances.filter(a => a.on).length;
    document.getElementById('appliances-stats').innerHTML = `
      <div class="stat-chip"><div class="stat-dot amber"></div>${on} activos</div>
      <div class="stat-chip"><div class="stat-dot copper"></div>${s.appliances.length - on} apagados</div>`;
  }
  function renderTasksStats(s) {
    const done = s.tasks.filter(t => t.done).length;
    document.getElementById('tasks-stats').innerHTML = `
      <div class="stat-chip"><div class="stat-dot green"></div>${done} hechas</div>
      <div class="stat-chip"><div class="stat-dot red"></div>${s.tasks.length - done} pendientes</div>`;
  }
  function renderObjectsStats(s) {
    const located  = s.objects.filter(o => o.history && o.history.length > 0).length;
    const unknown  = s.objects.length - located;
    document.getElementById('objects-stats').innerHTML = `
      <div class="stat-chip"><div class="stat-dot blue"></div>${located} localizados</div>
      <div class="stat-chip"><div class="stat-dot red"></div>${unknown} sin ubicar</div>`;
  }
  function renderPaymentsStats(s) {
    const pending = s.payments.filter(p => !p.paid).length;
    const amount  = s.payments.filter(p => !p.paid).reduce((a,p) => a + p.amount, 0);
    document.getElementById('payments-stats').innerHTML = `
      <div class="stat-chip"><div class="stat-dot red"></div>${pending} pendientes</div>
      <div class="stat-chip"><div class="stat-dot amber"></div>${amount.toFixed(2)} €</div>`;
  }

  function showSection(s) {
    document.getElementById('grid-view').classList.add('hidden');
    document.getElementById('section-view').classList.add('visible');
    
    ['appliances','tasks','objects','payments', 'chat'].forEach(sec => {
      const el = document.getElementById('view-' + sec);
      if(el) el.style.display = 'none';
    });
    
    // Mostramos la sección activa actual
    const v = document.getElementById('view-' + s.activeSection);
    if(v) {
        v.style.display = (s.activeSection === 'tasks' || s.activeSection === 'chat') ? 'flex' : 'block';
    }

    switch(s.activeSection) {
      case 'appliances':   renderAppliances(s);   break;
      case 'tasks':        renderTasks(s);        break;
      case 'objects':      renderObjects(s);      break;
      case 'payments':     renderPayments(s);     break;
      // No necesitamos un 'case' para el chat porque se maneja por Sockets
    }
  }

  function enterSection(sec) { socket.emit('enter'); }

  function renderAppliances(s) {
      const container = document.getElementById('appliances-grid');
      const cats = [
        { id: 'light', name: 'Luces' },
        { id: 'blind', name: 'Persianas' },
        { id: 'heating', name: 'Calefacción' },
        { id: 'ac', name: 'Aire Acondicionado' },
        { id: 'fan', name: 'Ventiladores de techo' },
        { id: 'other', name: 'Otros' }
      ];

      let html = '';
      cats.forEach(c => {
        // Filtramos los elementos de esta categoría
        const items = s.appliances.map((a, i) => ({...a, _idx: i})).filter(a => a.category === c.id);

        // Si hay elementos, los dibujamos. Si no, ponemos un texto de marcador de posición.
        const itemsHtml = items.length > 0 
          ? items.map(a => `
              <div class="light-card ${a.on?'on':''} ${a._idx===s.appliancesCursor?'active-cursor':''}" style="min-width: 150px; flex-shrink:0;">
                <div class="light-icon">${a.icon}</div>
                <div class="light-name">${a.name}</div>
                <div class="light-toggle"></div>
              </div>
            `).join('')
          : `<div style="font-size: .8rem; color: var(--muted2); font-style: italic; padding-top: 6px;">Sin dispositivos</div>`;

        html += `
          <div style="margin-bottom: 24px;">
            <h3 style="font-family:'Cinzel',serif; color:var(--muted); margin-bottom: 4px; font-size: .9rem; letter-spacing:.1em;">${c.name}</h3>
            <div style="display:flex; gap:14px; overflow-x:auto; padding: 12px 10px 20px 4px; scrollbar-width:none;">
              ${itemsHtml}
            </div>
          </div>`;
      });
      container.innerHTML = html;

      // Hacer scroll automático al elemento seleccionado
      const active = container.querySelector('.active-cursor');
      if (active) active.scrollIntoView({block:'nearest', inline:'center', behavior:'smooth'});
    }

  function renderTasks(s) {
    const list = document.getElementById('tasks-container');
    list.style.display = 'flex';
    list.style.flexDirection = 'row';
    list.style.gap = '18px';
    list.style.paddingBottom = '120px';
    const persons = [...new Set(s.tasks.map(t => t.person || t.assignee || 'Casa'))];
    let html = '';
    persons.forEach(p => {
      const initial = p.charAt(0).toUpperCase();
      const avClass = 'av-' + p;
      const personTasks = s.tasks.map((t,i) => ({...t, _i: i})).filter(t => (t.person || t.assignee || 'Casa') === p);
      html += `<div style="flex:0 0 320px;display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg);z-index:5;">
          <div style="width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:.8rem;" class="${avClass}">${initial}</div>
          <span style="font-weight:600;color:var(--cream);">${p}</span>
          <span style="margin-left:auto;font-size:.72rem;color:var(--muted);">${personTasks.filter(t=>t.done).length}/${personTasks.length}</span>
        </div>`;
      personTasks.forEach(t => {
        html += `<div class="task-item ${t.done?'done':''} ${t._i===s.tasksCursor?'active-cursor':''}">
          <div class="task-check">${t.done?'✓':''}</div>
          <div class="task-text">${t.title || t.text || 'Tarea'}</div>
        </div>`;
      });
      html += `</div>`;
    });
    list.innerHTML = html;
    const active = list.querySelector('.task-item.active-cursor');
    if (active) active.scrollIntoView({block:'nearest',behavior:'smooth'});
  }

  // ── RENDER OBJETOS — LOCALIZADOR ──
  function renderObjects(s) {
    const g = document.getElementById('objects-grid');
    g.innerHTML = s.objects.map((o, i) => {
      const hasLoc  = o.history && o.history.length > 0;
      const last    = hasLoc ? o.history[o.history.length - 1] : null;
      const prev    = hasLoc && o.history.length > 1 ? o.history.slice(-3, -1).reverse() : [];
      const isActive = i === s.objectsCursor;

      let locationHtml = `<div class="obj-no-location">Ubicación desconocida</div>`;
      if (last) {
        locationHtml = `
          <div class="obj-location-badge">
            <div class="obj-location-text">${last.location}</div>
            <div class="obj-who-when">
              <span class="obj-who">${last.who}</span>
              <span class="obj-dot">·</span>
              <span class="obj-when">${timeAgoClient(last.when)}</span>
            </div>
          </div>`;
      }

      let historyHtml = '';
      if (prev.length > 0) {
        historyHtml = `<div class="obj-history-mini">
          <div class="obj-history-mini-title">Antes</div>
          ${prev.map(e => `
            <div class="obj-history-entry">
              <span class="h-loc">${e.location}</span>
              <span class="h-dot">·</span>
              <span class="h-who">${e.who}</span>
              <span class="h-dot">·</span>
              <span>${timeAgoClient(e.when)}</span>
            </div>`).join('')}
        </div>`;
      }

      return `
        <div class="obj-card ${isActive?'active-cursor':''} ${hasLoc?'has-location':''}"
             onclick="showHistoryModalById(${JSON.stringify(o)})">
          <div class="obj-header">

            <div class="obj-name">${o.name}</div>
          </div>
          ${locationHtml}
          ${historyHtml}
        </div>`;
    }).join('');

    const cards = g.querySelectorAll('.obj-card');
    if (cards[s.objectsCursor]) cards[s.objectsCursor].scrollIntoView({block:'nearest',behavior:'smooth'});
  }

  // ── MODAL HISTORIAL ──
  function showHistoryModal(obj) {
    document.getElementById('modal-obj-name').textContent = obj.name;
    const list = document.getElementById('modal-history-list');
    if (!obj.history || obj.history.length === 0) {
      list.innerHTML = '<div style="color:var(--muted);font-size:.85rem;">Sin registros todavía.</div>';
    } else {
      list.innerHTML = [...obj.history].reverse().map((e, i) => `
        <div class="history-row">
          <div class="hr-loc">${e.location}</div>
          <div class="hr-meta">
            <span class="hr-who">${e.who}</span>
            · ${timeAgoClient(e.when)}
            · <span style="color:var(--muted2);font-size:.72rem">${new Date(e.when).toLocaleString('es-ES')}</span>
          </div>
        </div>`).join('');
    }
    document.getElementById('obj-history-modal').classList.add('visible');
  }
  function showHistoryModalById(obj) { showHistoryModal(obj); }

  function closeHistoryModal() {
    document.getElementById('obj-history-modal').classList.remove('visible');
  }

  function renderPayments(s) {
    const totalPending = s.payments.filter(p => !p.paid).reduce((a,p) => a + p.amount, 0);
    const totalPaid    = s.payments.filter(p =>  p.paid).reduce((a,p) => a + p.amount, 0);
    document.getElementById('pay-summary').innerHTML = `
      <div class="pay-sum-card pending"><div class="pay-sum-label">Pendiente</div><div class="pay-sum-value">${totalPending.toFixed(2)} €</div></div>
      <div class="pay-sum-card paid"><div class="pay-sum-label">Pagado</div><div class="pay-sum-value">${totalPaid.toFixed(2)} €</div></div>`;
    const list = document.getElementById('payments-list');
    list.innerHTML = s.payments.map((p,i) => `
      <div class="payment-item ${p.paid?'paid':''} ${i===s.paymentsCursor?'active-cursor':''}">
        <div class="pay-icon-wrap">${p.icon}</div>
        <div class="pay-info">
          <div class="pay-name">${p.name}</div>
          <div class="pay-due">${p.due}</div>
          <div class="pay-category">${p.category}</div>
        </div>
        <div>
          <div class="pay-amount">${p.amount.toFixed(2)} €</div>
          <div class="pay-status">${p.paid ? 'pagado' : 'pendiente'}</div>
        </div>
      </div>`).join('');
    const items = list.querySelectorAll('.payment-item');
    if (items[s.paymentsCursor]) items[s.paymentsCursor].scrollIntoView({block:'nearest',behavior:'smooth'});
  }

  // ── TIEMPO RELATIVO (cliente) ──
  function timeAgoClient(isoStr) {
    const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000);
    if (diff < 60)    return 'hace unos segundos';
    if (diff < 3600)  return `hace ${Math.floor(diff/60)} min`;
    if (diff < 86400) return `hace ${Math.floor(diff/3600)} h`;
    return `hace ${Math.floor(diff/86400)} días`;
  }

  // ── TECLADO ──
  document.addEventListener('keydown', async e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') { closeHistoryModal(); return; }
    const map = {ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right'};
    if (map[e.key]) socket.emit('navigate', map[e.key]);
    if (e.key === 'Enter' || e.key === ' ') socket.emit(state?.activeSection ? 'action' : 'enter');
    if (e.key === 'Backspace') socket.emit('back');
    if (e.key === 'Delete' && state?.activeSection === 'tasks') {
      const t = state.tasks[state.tasksCursor];
      if (t) { await fetch(`/api/tasks/${t.id}`, {method:'DELETE'}); loadApiTasks(); }
    }
  });

  // ── INTEGRACIÓN DEL CLIMA Y UBICACIÓN ──

  // Escuchar la orden del servidor para actualizar el clima
  socket.on('updateWeather', () => {
      document.getElementById("w-location").innerText = "📍 Actualizando...";
      getLocation();
  });

  function getLocation() {
      if ("geolocation" in navigator) {
          navigator.geolocation.getCurrentPosition(
              (position) => {
                  const lat = position.coords.latitude;
                  const lon = position.coords.longitude;
                  getWeather(lat, lon);
                  getCityName(lat, lon);
              },
              (error) => {
                  console.warn("Error obteniendo ubicación: ", error.message);
                  document.getElementById("w-location").innerText = "📍 Madrid (Por defecto)";
                  getWeather(40.4168, -3.7038); 
              }
          );
      } else {
          document.getElementById("w-location").innerText = "📍 Ubicación no soportada";
      }
  }

  function getCityName(lat, lon) {
      const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=es`;
      fetch(url)
          .then(response => response.json())
          .then(data => {
              const city = data.locality || data.city || data.principalSubdivision || "Ubicación actual";
              document.getElementById("w-location").innerText = `📍 ${city}`;
          })
          .catch(error => {
              console.error("Error obteniendo ciudad:", error);
              document.getElementById("w-location").innerText = "📍 Coordenadas OK";
          });
  }

  function getWeather(lat, lon) {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,wind_speed_10m,weather_code`;
      fetch(url)
          .then(response => {
              if (!response.ok) throw new Error("Error en la API");
              return response.json();
          })
          .then(data => {
              const temp = data.current.temperature_2m;
              const wind = data.current.wind_speed_10m;
              const rain = data.current.precipitation;
              const code = data.current.weather_code;

              let icon = "🌤";
              if (code === 0) icon = "☀️"; 
              else if (code >= 1 && code <= 3) icon = "⛅"; 
              else if (code >= 45 && code <= 48) icon = "🌫️"; 
              else if (code >= 51 && code <= 67) icon = "🌧️"; 
              else if (code >= 71 && code <= 77) icon = "❄️"; 
              else if (code >= 80 && code <= 82) icon = "🌦️"; 
              else if (code >= 95 && code <= 99) icon = "⛈️"; 

              document.getElementById("w-icon").innerText = icon;
              document.getElementById("w-temp").innerText = `${temp}°C`;
              document.getElementById("w-wind").innerText = `🌬 ${wind} km/h`;
              document.getElementById("w-rain").innerText = `💧 ${rain} mm`;
          })
          .catch(error => console.error("Error al obtener clima:", error));
  }

  window.addEventListener('load', getLocation);

  // ── LÓGICA DEL CLIENTE (IA en Servidor) ──
  const aiTrigger = document.getElementById('ai-trigger');
  const chatMessages = document.getElementById('chat-messages');
  const inputEl = document.getElementById('ai-input');
  const sendBtn = document.getElementById('ai-send');
  let currentAiMsgId = null;

  function appendMsg(role, text, id = null) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    msgDiv.innerHTML = `<b>${role === 'user' ? 'Tú' : 'Pepe'}</b><span class="content">${text}</span>`;
    if (id) msgDiv.id = id;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Click manual
  sendBtn.onclick = () => { if(inputEl.value) { socket.emit('askAi', inputEl.value); inputEl.value = ''; } };
  inputEl.onkeypress = (e) => { if(e.key === 'Enter') sendBtn.click(); };
  
  // En lugar de forzar la UI, emitimos el evento al servidor para que él organice la vista
  aiTrigger.onclick = () => { socket.emit('voiceTask', 'oye pepe'); };

  // ── Escuchar el progreso de descarga ──
  socket.on('aiProgress', (data) => {
    const progressTxt = document.getElementById('ai-progress-text');
    if (progressTxt) {
      progressTxt.innerText = `${data.progress}%`;
    }
  });

  // Sockets recibidos del servidor
  socket.on('aiReady', () => {
    aiTrigger.classList.replace('ai-loading', 'ai-ready');
    aiTrigger.title = "Hablar con Pepe";
    inputEl.disabled = false; sendBtn.disabled = false;
    
    const progressTxt = document.getElementById('ai-progress-text');
    if (progressTxt) progressTxt.innerText = ''; // Borramos el texto
  });

  socket.on('aiCommand', (data) => {
    // Si la data trae action: 'close', mandamos atrás
    if (data && data.action === 'close') {
        socket.emit('back'); 
    }
  });

  socket.on('aiStart', (data) => {
    appendMsg('user', data.question);
    currentAiMsgId = 'ai-resp-' + Date.now();
    appendMsg('ai', '', currentAiMsgId);
    inputEl.disabled = true; sendBtn.disabled = true;
  });

  socket.on('aiToken', (data) => {
    if(!currentAiMsgId) return;
    document.getElementById(currentAiMsgId).querySelector('.content').textContent += data.token;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
  socket.on('aiEnd', () => {
    currentAiMsgId = null;
    inputEl.disabled = false; sendBtn.disabled = false;
    inputEl.focus();
  });

// ── PIKACHU MODE ──
  socket.on('pikachuMode', (active) => {
    const body  = document.body;
    const badge = document.getElementById('pikachu-badge');
    if (active) {
      body.classList.add('pikachu-mode', 'pikachu-flash');
      badge.classList.add('visible');
      setTimeout(() => body.classList.remove('pikachu-flash'), 700);
    } else {
      body.classList.add('pikachu-flash');
      setTimeout(() => {
        body.classList.remove('pikachu-mode', 'pikachu-flash');
        badge.classList.remove('visible');
      }, 300);
    }
  });