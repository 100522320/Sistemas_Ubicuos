const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs').promises;
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIGURACIÓN IA (HuggingFace) ──
let aiGenerator = null;
let aiMessages = [{ 
  role: "system", 
  content: "Eres Pepe, el asistente personal de un hogar inteligente. Responde SIEMPRE de forma natural y SÓLO en español. NUNCA uses chino, inglés ni otros idiomas. Sé directo, amable y conciso." 
}];
let isAiResponding = false;
let ubicacionUsuario = { lat: "40.4168", lon: "-3.7038" }; // Por defecto

async function initAI(retries = 3) {
  try {
    console.log("🤖 Pepe: Descargando/Cargando modelo...");
    const { pipeline } = await import('@huggingface/transformers');
    
    aiGenerator = await pipeline("text-generation", "onnx-community/Qwen2.5-0.5B-Instruct", { 
      dtype: "q4",
      // ── Capturar el progreso y enviarlo a las pantallas ──
      progress_callback: (info) => {
        if (info.status === 'progress') {
          io.emit('aiProgress', { progress: Math.round(info.progress) });
        }
      }
    });
    
    console.log("🤖 Pepe: ¡Modelo listo y cargado en el servidor!");
    io.emit('aiReady'); 
  } catch (error) {
    console.error(`❌ Error cargando la IA (${retries} intentos restantes). Motivo:`, error.message);
    if (retries > 0) {
      console.log("🔄 Reintentando en 5 segundos...");
      setTimeout(() => initAI(retries - 1), 5000);
    }
  }
}
initAI(); // Ejecutar al arrancar el servidor

// Función principal para pensar y emitir tokens
async function askPepe(question) {
  if (!aiGenerator || isAiResponding) return;
  isAiResponding = true;
  
  aiMessages.push({ role: "user", content: question });
  io.emit('aiStart', { question }); // Dice a la pantalla que cree las burbujas

  try {
    const { TextStreamer } = await import('@huggingface/transformers');
    let fullResponse = "";
    
    // El streamer enviará cada trocito de palabra por socket
    const streamer = new TextStreamer(aiGenerator.tokenizer, {
      skip_prompt: true,
      callback_function: (token) => {
        fullResponse += token;
        io.emit('aiToken', { token });
      }
    });

    await aiGenerator(aiMessages, {
      max_new_tokens: 150,
      temperature: 0.4,          // Menos creatividad = menos alucinaciones extrañas
      repetition_penalty: 1.1,   // Evita que repita la misma palabra en bucle
      streamer: streamer
    });

    aiMessages.push({ role: "assistant", content: fullResponse });
  } catch(e) {
    console.error("Error en Pepe:", e);
    io.emit('aiToken', { token: " [Error generando respuesta]" });
  } finally {
    isAiResponding = false;
    io.emit('aiEnd'); // Libera la pantalla
  }
}

// ── BASES DE DATOS INDEPENDIENTES POR ZONA ──

const DATA_DIR = path.join(__dirname, 'data');
if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR);

const FILES = {
  appliances: path.join(DATA_DIR, 'appliances.json'),
  objects:  path.join(DATA_DIR, 'objects.json'),
  payments: path.join(DATA_DIR, 'payments.json'),
  tasks:    path.join(DATA_DIR, 'tasks.json'),
  events:   path.join(DATA_DIR, 'events.json')
};

// Datos predeterminados si los archivos no existen la primera vez
const defaultData = {
  appliances: [ 
    { name: "Luz habitación", category: "light", icon: "💡", on: false },
    { name: "Persiana salón", category: "blind", icon: "🪟", on: false }
  ],
  objects: [],
  payments: [],
  tasks: [],
  events: []
};

// Función para cargar un JSON o crearlo si no existe
function loadJSON(key) {
  if (fsSync.existsSync(FILES[key])) {
    try { return JSON.parse(fsSync.readFileSync(FILES[key], 'utf8')); } catch(e) {}
  }
  fsSync.writeFileSync(FILES[key], JSON.stringify(defaultData[key], null, 2), 'utf8');
  return defaultData[key];
}

// Funciones para guardar CADA zona en su propio archivo al instante
function saveAppliances() { fsSync.writeFileSync(FILES.appliances, JSON.stringify(state.appliances, null, 2), 'utf8'); }
function saveObjects()  { fsSync.writeFileSync(FILES.objects,  JSON.stringify(state.objects,  null, 2), 'utf8'); }
function savePayments() { fsSync.writeFileSync(FILES.payments, JSON.stringify(state.payments, null, 2), 'utf8'); }
function saveEvents()   { fsSync.writeFileSync(FILES.events,   JSON.stringify(state.events,   null, 2), 'utf8'); } 

// ── TAREAS (async) ──
const DATA_FILE = path.join(__dirname, 'data', 'tasks.json');
async function readTasks() {
  try { return JSON.parse(await fs.readFile(DATA_FILE, 'utf8')); } catch(e) { return []; }
}
async function writeTasks(tasks) {
  await fs.writeFile(DATA_FILE, JSON.stringify(tasks, null, 2));
}

// API REST de tareas
app.get('/api/tasks', async (req, res) => { res.json(await readTasks()); });

app.post('/api/tasks', async (req, res) => {
  const newTask = req.body;
  if (!newTask.title) return res.status(400).json({ error: 'El título es obligatorio' });
  let tasks = await readTasks();
  newTask.id = Date.now().toString();
  newTask.assignee = newTask.assignee || 'Casa';
  tasks.push(newTask);
  await writeTasks(tasks);

  // Actualizar el estado global y mover el puntero a la nueva tarea
  state.tasks = tasks.map(t => ({ 
    id: t.id, 
    person: t.assignee || 'Casa', 
    title: t.title, 
    done: t.done || false 
  }));
  state.tasksCursor = state.tasks.length - 1;
  io.emit('stateUpdate', state);

  res.status(201).json(newTask);
});

app.put('/api/tasks/:id', async (req, res) => {
  let tasks = await readTasks();
  const index = tasks.findIndex(t => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Tarea no encontrada' });
  tasks[index] = { ...tasks[index], ...req.body };
  await writeTasks(tasks);
  res.json(tasks[index]);
});

app.delete('/api/tasks/:id', async (req, res) => {
  let tasks = await readTasks();
  const index = tasks.findIndex(t => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Tarea no encontrada' });
  const removed = tasks.splice(index, 1)[0];
  await writeTasks(tasks);
  res.json(removed);
});

// ── ESTADO GLOBAL ──
let state = {
  activeSection: null,
  cursor: { x: 0, y: 0 },
  appliancesCursor: 0, tasksCursor: 0, objectsCursor: 0, paymentsCursor: 0,eventsCursor: 0,
  appliances: loadJSON('appliances'), 
  objects:  loadJSON('objects'),
  payments: loadJSON('payments'),
  tasks:    loadJSON('tasks'),
  events: loadJSON('events'),    
  calendarMonth: new Date().getMonth(), 
  calendarYear: new Date().getFullYear()
};

// ── GRID CONFIG ──
const GRID_W = 2, GRID_H = 2;

// ── LÓGICA DE OBJETOS COMPARTIDA (menú principal + sección objetos) ──
// Devuelve true si el comando fue reconocido y procesado, false si no aplica.
function handleObjectVoice(socket, t, tNorm) {
  const IS_QUERY = /(donde|dond|busca|buscar|ves|estas|esta|encuentr|sabe|quien|quién|cuand)/;

  // 1. CONSULTA E HISTORIAL: "¿dónde están las llaves?"
  if (IS_QUERY.test(tNorm)) {
    let found = null;
    for (const obj of state.objects) {
      if (tNorm.includes(norm(obj.name))) { found = obj; break; }
    }
    
    //  Si no se encuentra en el JSON, avisa por voz y corta la ejecución
    if (!found) {
      io.emit('speakPhrase', { text: 'Ese objeto no está registrado en la base de datos.' });
      socket.emit('objectQuery', { found: false, name: '?' });
      return true;
    }

    //  Si existe pero no tiene historial, también lo dice por voz
    if (!found.history || found.history.length === 0) {
      io.emit('speakPhrase', { text: `Tengo registrado el objeto ${found.name}, pero nadie me ha dicho dónde lo ha dejado.` });
      socket.emit('objectQuery', { found: false, name: found.name });
      return true;
    }

    const last = found.history[found.history.length - 1];
    socket.emit('objectQuery', {
      found: true,
      name:     found.name,
      location: last.location,
      who:      last.who,
      when:     timeAgo(new Date(last.when)),
      history:  found.history
    });
    const idx = state.objects.indexOf(found);
    if (idx !== -1) state.objectsCursor = idx;
    io.emit('stateUpdate', state);
    return true;
  }

  // 2. REGISTRO GLOBAL: Permite a CUALQUIER persona registrar movimientos
  let whoName = null, objName = null, location = null;

  const matchSoy = tNorm.match(/(?:soy|me llamo)\s+(\w+)/);
  const matchDej = tNorm.match(/(?:he?\s+)?(?:dejado|puesto|guardado|colocado|dejo|pongo|puse)\s+(?:el |la |los |las |un |una )?(.+?)\s+en\s+(.+)/);
  if (matchSoy && matchDej) {
    whoName  = matchSoy[1];
    objName  = matchDej[1].trim();
    location = matchDej[2].trim();
  }

  if (!whoName) {
    const matchTerc = tNorm.match(/(\w+)\s+ha\s+(?:dejado|puesto|guardado|colocado)\s+(?:el |la |los |las |un |una )?(.+?)\s+en\s+(.+)/);
    if (matchTerc) {
      whoName  = matchTerc[1];
      objName  = matchTerc[2].trim();
      location = matchTerc[3].trim();
    }
  }

  if (!whoName) {
    const matchCualquiera = tNorm.match(/^(\w+)\s+(?:he?\s+)?(?:dejado|puesto|guardado|colocado|dejo|pongo|puse)\s+(?:el |la |los |las |un |una )?(.+?)\s+en\s+(.+)/);
    if (matchCualquiera) {
      whoName = matchCualquiera[1];
      objName = matchCualquiera[2].trim();
      location = matchCualquiera[3].trim();
    }
  }

  if (whoName && objName && location) {
    // Formateamos el nombre (Ej: maria -> Maria)
    whoName = whoName.charAt(0).toUpperCase() + whoName.slice(1);

    let targetObj = null, targetIdx = -1;
    for (let i = 0; i < state.objects.length; i++) {
      if (tNorm.includes(norm(state.objects[i].name)) || norm(state.objects[i].name).includes(objName)) {
        targetObj = state.objects[i]; targetIdx = i; break;
      }
    }
    
    if (!targetObj) {
      const newObj = { id: Date.now(), name: objName.charAt(0).toUpperCase() + objName.slice(1),  history: [] };
      state.objects.push(newObj);
      targetObj = newObj;
      targetIdx = state.objects.length - 1;
    }

    // Se EMPUJA (push) la nueva localización, manteniendo todo el historial anterior
    const entry = {
      location: location.charAt(0).toUpperCase() + location.slice(1),
      who:      whoName,
      when:     new Date().toISOString()
    };
    targetObj.history.push(entry);
    
    state.objectsCursor = targetIdx;
    saveObjects();
    io.emit('stateUpdate', state);
    socket.emit('objectLocated', { name: targetObj.name, location: entry.location, who: whoName });
    return true;
  }

  return false; // No fue un comando de objetos
}

// ── UTILIDADES VOZ ──
const norm = str => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

// ── SOCKET LOGIC ──
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);
  socket.emit('fullState', state);

  // Si la IA ya existe, avisa al nuevo cliente que se conecte
  if (aiGenerator) {
    socket.emit('aiReady');
  }

  // ── NAVIGATE ──
  socket.on('navigate', async dir => {
    if (state.activeSection === null) {
      let { x, y } = state.cursor;
      if (dir === 'left')  x = Math.max(0, x - 1);
      if (dir === 'right') x = Math.min(1, x + 1);
      if (dir === 'up')    y = Math.max(0, y - 1);
      if (dir === 'down')  y = Math.min(1, y + 1);
      state.cursor = { x, y };
    } else {
      // ── Evitar que el servidor busque listas si estamos hablando con Pepe ──
      if (state.activeSection === 'chat') return;

      const key     = state.activeSection + 'Cursor';
      const listKey = state.activeSection;

      if (listKey === 'tasks') {
        try {
          const dbTasks = await readTasks();
          state.tasks = dbTasks.map(t => ({
            id: t.id, person: t.assignee || 'Casa', title: t.title, done: t.done || false
          }));
        } catch(e) {}
      }

      const list = state[listKey];
      const len  = list.length;
      let cur    = state[key];

      if (len > 0) {
        if (cur >= len) cur = len - 1;

        if (listKey === 'tasks') {
          const persons = [...new Set(list.map(t => t.person || t.assignee || 'Casa'))];
          const cols = persons.map(p => {
            let indices = [];
            list.forEach((t, i) => { if ((t.person || t.assignee || 'Casa') === p) indices.push(i); });
            return indices;
          });
          let c = 0, r = 0;
          for (let i = 0; i < cols.length; i++) {
            const rIdx = cols[i].indexOf(cur);
            if (rIdx !== -1) { c = i; r = rIdx; break; }
          }
          if (dir === 'left')  c = Math.max(0, c - 1);
          if (dir === 'right') c = Math.min(cols.length - 1, c + 1);
          if (dir === 'up')    r = Math.max(0, r - 1);
          if (dir === 'down')  r = Math.min(cols[c].length - 1, r + 1);
          r = Math.min(r, cols[c].length - 1);
          cur = cols[c][r];

        } else if (listKey === 'appliances') {
          // ── LÓGICA PARA ELECTRODOMÉSTICOS ──
          // Agrupamos los dispositivos en "filas" según su categoría
          const cats = ['light', 'blind', 'heating', 'ac', 'fan', 'other'];
          const rows = cats.map(c => {
            let indices = [];
            list.forEach((item, i) => { if (item.category === c) indices.push(i); });
            return indices;
          }).filter(r => r.length > 0); // Omitir categorías que estén vacías

          if (rows.length > 0) {
            let cIdx = 0, rIdx = 0;
            // Buscar en qué fila (categoría) y columna está el cursor actualmente
            for (let i = 0; i < rows.length; i++) {
              const pos = rows[i].indexOf(cur);
              if (pos !== -1) { rIdx = i; cIdx = pos; break; }
            }

            // Movimientos del joystick
            if (dir === 'left')  cIdx = Math.max(0, cIdx - 1);
            if (dir === 'right') cIdx = Math.min(rows[rIdx].length - 1, cIdx + 1);
            if (dir === 'up')    rIdx = Math.max(0, rIdx - 1);
            if (dir === 'down')  rIdx = Math.min(rows.length - 1, rIdx + 1);

            // Si bajas de una fila larga a una fila más corta, ajustar el cursor
            cIdx = Math.min(cIdx, rows[rIdx].length - 1);
            cur = rows[rIdx][cIdx];
          }

        } else {
          // ── OBJETOS Y PAGOS ──
          let numCols = 1;
          if (listKey === 'objects')  numCols = 3;
          if (listKey === 'payments') numCols = 2;

          let r = Math.floor(cur / numCols);
          let c = cur % numCols;
          const numRows = Math.ceil(len / numCols);

          if (dir === 'left')  c = Math.max(0, c - 1);
          if (dir === 'right') c = Math.min(numCols - 1, c + 1);
          if (dir === 'up')    r = Math.max(0, r - 1);
          if (dir === 'down')  r = Math.min(numRows - 1, r + 1);

          let nextIdx = r * numCols + c;
          if (nextIdx >= len) nextIdx = len - 1;
          cur = nextIdx;
        }
      }
      state[key] = cur;
    }
    io.emit('stateUpdate', state);
  });

  // ── TEXTO DIRECTO (Desde el input del chat) ──
  socket.on('askAi', (text) => {
    state.activeSection = 'chat';
    io.emit('stateUpdate', state);
    askPepe(text);
  });
socket.on('guardarUbicacionReal', (coords) => {
    ubicacionUsuario = coords;
    console.log("📍 Ubicación actualizada para Pepe:", ubicacionUsuario);
});
  // ── VOZ ──
  socket.on('voiceTask', async (text) => {
    if (!text || text.trim() === '') return;
    const t     = text.trim().toLowerCase();
    const tNorm = norm(t);

   
    if (/^(atras|salir|volver|cerrar)/.test(tNorm)) {
      if (state.activeSection !== null) {
        state.activeSection = null;
        io.emit('stateUpdate', state);
        
      } else {
        io.emit('speakPhrase', { text: 'Ya estás en el inicio' });
      }
      return; // Cortamos aquí para que no siga leyendo comandos
    }
    if (/(que tengo|tengo algo|que hay|dime los eventos|eventos para).*?(?:dia|el)\s*(\d+|[a-z]+)/.test(tNorm)) {
      let pText = tNorm;
      
      // 1. Convertir números escritos a dígitos por si dice "el día quince"
      const nums = {"uno":1,"dos":2,"tres":3,"cuatro":4,"cinco":5,"seis":6,"siete":7,"ocho":8,"nueve":9,"diez":10,"once":11,"doce":12,"trece":13,"catorce":14,"quince":15,"dieciseis":16,"diecisiete":17,"dieciocho":18,"diecinueve":19,"veinte":20,"veintiuno":21,"veintidos":22,"veintitres":23,"veinticuatro":24,"veinticinco":25,"veintiseis":26,"veintisiete":27,"veintiocho":28,"veintinueve":29,"treinta":30,"treinta y uno":31};
      for(let k in nums) { pText = pText.replace(new RegExp(`\\b${k}\\b`, 'g'), nums[k]); }

      // 2. Extraer el día y el mes
      const dayMatch = pText.match(/(?:dia|el)\s*(\d+)/);
      const monthMatch = pText.match(/(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);

      if (dayMatch) {
        const day = parseInt(dayMatch[1]);
        const monthsList = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
        
        // Si no dice mes, usamos el actual
        let targetMonth = monthMatch ? monthsList.indexOf(monthMatch[1]) : new Date().getMonth();
        let targetYear = new Date().getFullYear();

        // Si dice un mes que ya ha pasado este año (ej: dice "Enero" estando en Noviembre), asumimos que es el año que viene
        if (monthMatch && targetMonth < new Date().getMonth()) {
          targetYear++;
        }

        // 3. Buscar eventos que coincidan
        const eventsOnDay = state.events.filter(e => e.day === day && e.month === targetMonth && e.year === targetYear);

        if (eventsOnDay.length === 0) {
          io.emit('speakPhrase', { text: `No tienes ningún evento el día ${day} de ${monthsList[targetMonth]}.` });
        } else {
          // 4. Formatear la respuesta
          let textResp = eventsOnDay.length === 1 ? `El día ${day} de ${monthsList[targetMonth]} tienes un evento: ` : `El día ${day} de ${monthsList[targetMonth]} tienes ${eventsOnDay.length} eventos: `;
          
          // Unimos los nombres y las horas. Ej: "Cena a las 10, y Reunión a las 12"
          const evDetails = eventsOnDay.map(e => `${e.name} a las ${e.time.split(':')[0]}`).join(', y ');
          
          io.emit('speakPhrase', { text: textResp + evDetails + "." });
        }
      } else {
        io.emit('speakPhrase', { text: 'No he entendido bien el día. Prueba a decir: ¿Qué tengo el día 15 de mayo?' });
      }
      return; 
    }
    // 1. CASO: TRIGGER "OYE PEPE"
    const TRIGGER_PEPE = /^(oye )?pepe/;
    if (TRIGGER_PEPE.test(tNorm)) {
      let question = t.replace(/^(oye )?pepe/i, '').trim();
      
      state.activeSection = 'chat';
      io.emit('stateUpdate', state);
      io.emit('aiCommand'); // Fuerza abrir el chat
      
      if (question === '') {
        socket.emit('taskSaved', { text: '🤖 Pepe: ¿Dime?' });
      } else {
        socket.emit('taskSaved', { text: `🤖 Preguntando a Pepe...` });
        askPepe(question);
      }
      return; // Detener ejecución normal
    }
// ── ENTRAR A EVENTOS (Por voz) ──
    if (/(eventos|calendario|agenda)/.test(tNorm)) {
      state.activeSection = 'events';
      io.emit('stateUpdate', state);
      socket.emit('taskSaved', { text: 'Abriendo calendario' });
      return;
    }

    // ==========================================================
    // ── SECCIÓN: EVENTOS ──
    // ==========================================================
    if (state.activeSection === 'events') {
      
 

      // NAVEGAR POR LOS MESES
      if (/mes (siguiente|proximo|que viene|adelante)/.test(tNorm)) {
        state.calendarMonth++;
        if (state.calendarMonth > 11) { state.calendarMonth = 0; state.calendarYear++; }
        io.emit('stateUpdate', state);
        socket.emit('taskSaved', { text: 'Mes siguiente' });
        return;
      }
      if (/mes (anterior|pasado|atras)/.test(tNorm)) {
        state.calendarMonth--;
        if (state.calendarMonth < 0) { state.calendarMonth = 11; state.calendarYear--; }
        io.emit('stateUpdate', state);
        socket.emit('taskSaved', { text: 'Mes anterior' });
        return;
      }

      // AÑADIR EVENTO
      if (/^(.*?)\s*(anade|anadir|crea|crear|nuevo|pon|programa).*evento/.test(tNorm)) {
        let pText = tNorm;
        const nums = {"uno":1,"dos":2,"tres":3,"cuatro":4,"cinco":5,"seis":6,"siete":7,"ocho":8,"nueve":9,"diez":10,"once":11,"doce":12,"trece":13,"catorce":14,"quince":15,"dieciseis":16,"diecisiete":17,"dieciocho":18,"diecinueve":19,"veinte":20,"veintiuno":21,"veintidos":22,"veintitres":23,"veinticuatro":24,"veinticinco":25,"veintiseis":26,"veintisiete":27,"veintiocho":28,"veintinueve":29,"treinta":30,"treinta y uno":31};
        for(let k in nums) { pText = pText.replace(new RegExp(`\\b${k}\\b`, 'g'), nums[k]); }

        // 1. Extraer Persona (La primera palabra si existe)
        const actionMatch = pText.match(/^([a-z]+)\s+(?:anade|anadir|crea|crear|nuevo|pon|programa)/);
        let person = actionMatch ? actionMatch[1].charAt(0).toUpperCase() + actionMatch[1].slice(1) : 'Casa';

        // 2. Extraer Nombre del evento (Todo lo que hay entre "evento" y la siguiente palabra clave)
        const nameMatch = pText.match(/evento\s+(.*?)\s+(?=el\s+|dia\s+|a las|para|con)/);
        let eventName = nameMatch ? nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1) : 'Evento';

        // 3. Extraer Datos base
        const dayMatch = pText.match(/(?:dia|el)\s*(\d+)/);
        const timeMatch = pText.match(/(?:a las|las|alas|a la|ala)\s*(\d+)/);
        const peopleMatch = pText.match(/(?:con|para|de)\s*(\d+)/);
        const monthMatch = pText.match(/(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);

        if (dayMatch && timeMatch && peopleMatch) {
          const day = parseInt(dayMatch[1]);
          const time = timeMatch[1] + ':00';
          const people = parseInt(peopleMatch[1]);
          
          const monthsList = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
          let eventMonth = new Date().getMonth(); // Mes actual por defecto
          let eventYear = new Date().getFullYear();

          // Si dice el mes, lo cambiamos
          if (monthMatch) {
            eventMonth = monthsList.indexOf(monthMatch[1]);
            // Si el mes que dice es anterior al mes actual (ej: estamos en Nov y dice Febrero), asumimos que es el año que viene
            if (eventMonth < new Date().getMonth()) eventYear++;
          }

          if (day < 1 || day > 31) {
            socket.emit('taskIgnored', { text: 'Día inválido' });
            return;
          }

          state.events.push({ id: Date.now(), day, month: eventMonth, year: eventYear, time, people, name: eventName, person });
          state.events.sort((a, b) => a.day - b.day);
          saveEvents();
          
          // Cambiamos el calendario visualmente a ese mes para que vea lo que acaba de añadir
          state.calendarMonth = eventMonth;
          state.calendarYear = eventYear;
          
          io.emit('stateUpdate', state);
          socket.emit('taskSaved', { text: `Evento añadido` });
          io.emit('speakPhrase', { text: `Añadido ${eventName} el ${day} de ${monthsList[eventMonth]}.` });
        } else {
          socket.emit('taskError');
          io.emit('speakPhrase', { text: 'Faltan datos. Comando tipo: Adrián añade evento cena el día 2 a las 10 para 4 personas.' });
        }
        return;
      }

      // BORRAR EVENTO
      if (/^(.*?)\s*(borra|borrar|elimina|eliminar|quita|quitar|cancela).*evento/.test(tNorm)) {
        let pText = tNorm;
        const nums = {"uno":1,"dos":2,"tres":3,"cuatro":4,"cinco":5,"seis":6,"siete":7,"ocho":8,"nueve":9,"diez":10,"once":11,"doce":12,"trece":13,"catorce":14,"quince":15,"dieciseis":16,"diecisiete":17,"dieciocho":18,"diecinueve":19,"veinte":20,"veintiuno":21,"veintidos":22,"veintitres":23,"veinticuatro":24,"veinticinco":25,"veintiseis":26,"veintisiete":27,"veintiocho":28,"veintinueve":29,"treinta":30,"treinta y uno":31};
        for(let k in nums) { pText = pText.replace(new RegExp(`\\b${k}\\b`, 'g'), nums[k]); }

        const dayMatch = pText.match(/(?:dia|el)\s*(\d+)/);
        const monthMatch = pText.match(/(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);
        
        if (dayMatch) {
          const day = parseInt(dayMatch[1]);
          const monthsList = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
          let targetMonth = monthMatch ? monthsList.indexOf(monthMatch[1]) : state.calendarMonth; // Borra del mes que haya dicho, o del que esté viendo
          
          const idx = state.events.findIndex(e => e.day === day && e.month === targetMonth);

          if (idx !== -1) {
            state.events.splice(idx, 1);
            saveEvents();
            io.emit('stateUpdate', state);
            socket.emit('taskDeleted', { text: `Evento borrado` });
            io.emit('speakPhrase', { text: `El evento ha sido cancelado.` });
          } else {
            socket.emit('taskError');
            io.emit('speakPhrase', { text: `No hay eventos ese día.` });
          }
        } else {
          socket.emit('taskError');
          io.emit('speakPhrase', { text: 'Dime qué día quieres borrar.' });
        }
        return;
      }

    
    }
    // 2. CASO: PIKACHU MODE
    if (/pikachu te elijo a ti/.test(tNorm)) {
      io.emit('pikachuMode', true);
      socket.emit('taskSaved', { text: '⚡ ¡PIKACHU, TE ELIJO A TI!' });
      return;
    }
    if (/^pikachu vuelve$/.test(tNorm)) {
      io.emit('pikachuMode', false);
      socket.emit('taskSaved', { text: '⚡ Pikachu ha vuelto a la Pokéball' });
      return;
    }

    // 3. CASO: ESTAMOS DENTRO DEL CHAT
    if (state.activeSection === 'chat') {
      // Excepción para dejar salir del chat
      const NAVIGATION = /^(ir a |abrir |mostrar )?(inicio|principal|dispositivos|tareas|clima|objetos|pagos)/;
      
      if (!NAVIGATION.test(tNorm) && tNorm.length > 2) {
        socket.emit('taskSaved', { text: `🤖 Pepe pensando...` });
        askPepe(t); // Le pasamos el texto original (con mayúsculas/tildes)
        return; 
      }
    }

    // ── COMANDO GLOBAL DEL CLIMA ──
    if (/(actualiza|actualizar|dime|que|qué|como).*(tiempo|clima)/.test(tNorm) || /^(tiempo|clima)$/.test(tNorm)) {
    io.emit('updateWeather');
    socket.emit('taskSaved', { text: '🌤 Actualizando clima...' });

    // MODIFICADO: Ahora usamos la latitud y longitud guardadas
    const url = `https://wttr.in/${ubicacionUsuario.lat},${ubicacionUsuario.lon}?format=j1&lang=es`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            const temp = parseInt(data.current_condition[0].temp_C);
            const desc = data.current_condition[0].lang_es[0].value.toLowerCase();
            
            const ciudadDetectada = data.nearest_area[0].areaName[0].value;
            let frase = `El tiempo actual en ${ciudadDetectada} es de ${temp} grados y está ${desc}. `;
            
            // 2. Lógica de frases extra según el clima
        if (desc.includes("lluvia") || desc.includes("llovizna") || desc.includes("chubascos")) {
            frase += "¡No olvides el paraguas si vas a salir!";
        } 
        else if (temp >= 30) {
            frase += "Hace bastante calor, busca la sombra y mantente hidratado.";
        } 
        else if (temp <= 10) {
            frase += "Hace bastante frío hoy, no olvides una buena chaqueta.";
        } 
        else if (desc.includes("despejado") || desc.includes("sol")) {
            frase += "Es un momento genial para dar un paseo.";
        } 
        else if (desc.includes("nieve")) {
            frase += "¡Mira! Está nevando, qué día más especial.";
        }
        else {
            frase += "¡Que tengas un excelente día!";
        }

            io.emit('speakPhrase', { text: frase });
        })
        .catch(err => console.error("Error en clima Pepe:", err));
    return;
}
    

    // ── SECCIÓN: TAREAS ──
    if (state.activeSection === 'tasks') {
      const words      = text.trim().split(/\s+/);
      const actionWord = norm(words[0]);

      if (/^(eliminar|borrar|quitar|borra|elimina)$/.test(actionWord)) {
        try {
          let tasks = await readTasks();
          if (tasks.length === 0) { socket.emit('taskError'); return; }
          if (words.length > 1) {
            const targetText = norm(words.slice(1).join(' '));
            const exactIdx = tasks.findIndex(task =>
              norm(task.assignee + ' ' + task.title).includes(targetText) ||
              norm(task.title).includes(targetText)
            );
            if (exactIdx !== -1) {
              const removed = tasks.splice(exactIdx, 1)[0];
              await writeTasks(tasks);
              state.tasks = tasks.map(t => ({ id: t.id, person: t.assignee || 'Casa', title: t.title, done: t.done || false }));
              state.tasksCursor = Math.max(0, Math.min(state.tasksCursor, tasks.length - 1));
              io.emit('stateUpdate', state);
              socket.emit('taskDeleted', { text: removed.title });
              return;
            } else { socket.emit('voiceUnknown', { text }); return; }
          }
          const idx     = Math.min(state.tasksCursor, tasks.length - 1);
          const removed = tasks.splice(idx, 1)[0];
          await writeTasks(tasks);
          state.tasksCursor = Math.max(0, idx - 1);
          io.emit('stateUpdate', state);
          socket.emit('taskDeleted', { text: removed.title });
        } catch(err) { socket.emit('taskError'); }
        return;
      }

      if (/^(anadir|anade|crear|crea|pon|poner|agregar|agrega|nueva|nuevo)$/.test(actionWord)) {
        words.shift();
        if (words.length === 0) return;
        let assignee = 'Casa', title = '';
        if (words.length > 1) {
          const rawName = words[0];
          assignee = rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
          title = words.slice(1).join(' ');
        } else { title = words[0]; }
        const newTask = { id: Date.now().toString(), title, assignee, done: false };
        try {
          let tasks = await readTasks();
          tasks.push(newTask);
          await writeTasks(tasks);
          state.tasks = tasks.map(t => ({ id: t.id, person: t.assignee || 'Casa', title: t.title, done: t.done || false }));
          state.tasksCursor = state.tasks.length - 1;
          io.emit('stateUpdate', state);
          io.emit('taskAdded', { text: title });
          socket.emit('taskSaved', { text: `${assignee}: ${title}` });
        } catch(err) { socket.emit('taskError'); }
        return;
      }
      socket.emit('voiceUnknown', { text });
      return;
    }

    // ── SECCIÓN: OBJETOS ──
    if (state.activeSection === 'objects') {

      // Delega en la función compartida; si devuelve true, el comando fue procesado
      if (handleObjectVoice(socket, t, tNorm)) return;

      //  AÑADIR objeto vacío: "añadir X" / "nuevo objeto X"
      const words      = tNorm.split(/\s+/);
      const actionWord = words[0];
      if (/^(anadir|anade|crear|crea|nuevo|nueva|agregar)$/.test(actionWord)) {
        const name = words.slice(1).join(' ').trim();
        if (!name) { socket.emit('voiceUnknown', { text }); return; }

        const existeObjeto = state.objects.some(o => norm(o.name) === name);

        if (existeObjeto) {
          // Si ya existe, enviamos un aviso al móvil y cancelamos la creación
          socket.emit('taskIgnored', { text: `Ya existe un objeto llamado ${name}` });
          return; 
        }

        const newObj = {
          id:      Date.now(),
          name:    name.charAt(0).toUpperCase() + name.slice(1),
          history: []
        };
        state.objects.push(newObj);
        state.objectsCursor = state.objects.length - 1;
        saveObjects();
        io.emit('stateUpdate', state);
        socket.emit('taskSaved', { text: ` Objeto añadido: ${newObj.name}` });
        return;
      }

      //  BORRAR objeto: "borrar X"
      if (/^(eliminar|borrar|quitar|borra|elimina)$/.test(actionWord)) {
        const targetName = words.slice(1).join(' ').trim();
        if (!targetName) {
          // Borrar seleccionado
          if (state.objects.length === 0) { socket.emit('taskError'); return; }
          const removed = state.objects.splice(state.objectsCursor, 1)[0];
          state.objectsCursor = Math.max(0, state.objectsCursor - 1);
          saveObjects();
          io.emit('stateUpdate', state);
          socket.emit('taskDeleted', { text: removed.name });
          return;
        }
        const idx = state.objects.findIndex(o => norm(o.name).includes(targetName) || targetName.includes(norm(o.name)));
        if (idx !== -1) {
          const removed = state.objects.splice(idx, 1)[0];
          state.objectsCursor = Math.max(0, Math.min(state.objectsCursor, state.objects.length - 1));
          saveObjects();
          io.emit('stateUpdate', state);
          socket.emit('taskDeleted', { text: removed.name });
        } else { socket.emit('voiceUnknown', { text }); }
        return;
      }

      socket.emit('voiceUnknown', { text });
      return;
    }

    // ── SECCIÓN: PAGOS ──
    if (state.activeSection === 'payments') {
      const words      = text.trim().split(/\s+/);
      const actionWord = norm(words[0]);

      // --- VERIFICAR SI ESTAMOS ESPERANDO CONFIRMACIÓN ---
      if (socket.pendingPayment) {
        const p = socket.pendingPayment;
        socket.pendingPayment = null; // Lo limpiamos para no preguntar dos veces
        clearTimeout(socket.pendingPaymentTimer); // Cancelamos el temporizador

        // Si la respuesta contiene algo afirmativo
        if (/\b(si|sí|claro|por supuesto|ok|vale|añadelo)\b/.test(tNorm)) {
          state.payments.push(p);
          state.paymentsCursor = state.payments.length - 1;
          savePayments(); 
          io.emit('stateUpdate', state);
          socket.emit('paymentConfirmed', { name: p.name });
        } else {
          // Si dice "no" o cualquier otra cosa
          socket.emit('paymentCancelled', { name: p.name });
        }
        return; // Terminamos aquí para que no lo procese como un comando normal
      }

      if (/^(eliminar|borrar|quitar|borra|elimina)$/.test(actionWord)) {
        const targetNameNorm = norm(words.slice(1).join(' '));
        if (state.payments.length === 0) { socket.emit('taskError'); return; }
        if (targetNameNorm !== '') {
          const exactIdx = state.payments.findIndex(p => norm(p.name) === targetNameNorm || targetNameNorm.includes(norm(p.name)));
          if (exactIdx !== -1) {
            const removed = state.payments.splice(exactIdx, 1)[0];
            state.paymentsCursor = Math.max(0, Math.min(state.paymentsCursor, state.payments.length - 1));
            savePayments(); io.emit('stateUpdate', state); socket.emit('taskDeleted', { text: removed.name });
            return;
          } else { socket.emit('voiceUnknown', { text }); return; }
        }
        const idx = Math.min(state.paymentsCursor, state.payments.length - 1);
        const removed = state.payments.splice(idx, 1)[0];
        state.paymentsCursor = Math.max(0, idx - 1);
        savePayments(); io.emit('stateUpdate', state); socket.emit('taskDeleted', { text: removed.name });
        return;
      }

      let currentText = t, currentTNorm = tNorm;
      if (/^(anadir|anade|crear|crea|pon|poner|agregar|agrega|nuevo|nueva)$/.test(actionWord)) {
        currentText = words.slice(1).join(' '); currentTNorm = norm(currentText);
      }
      if (currentText.trim() === '') { socket.emit('voiceUnknown', { text }); return; }

      if (/(pendiente|no pagad[oa]|sin pagar|debe)/.test(currentTNorm)) {
        let rawName = currentText.replace(/(pendiente|no pagado|no pagada|sin pagar|debe)/gi, '').trim();
        if (rawName === '') {
          const p = state.payments[state.paymentsCursor];
          if (!p) { socket.emit('taskError'); return; }
          p.paid = false; savePayments(); io.emit('stateUpdate', state); return;
        }
        let targetPayment = null, targetIdx = -1;
        for (let i = 0; i < state.payments.length; i++) {
          if (norm(state.payments[i].name) === norm(rawName) || currentTNorm.includes(norm(state.payments[i].name))) {
            targetPayment = state.payments[i]; targetIdx = i; break;
          }
        }
        if (targetPayment) {
          targetPayment.paid = false; state.paymentsCursor = targetIdx; savePayments(); io.emit('stateUpdate', state);
        } else {
          const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
          state.payments.push({ id: Date.now(), name, icon: '💳', amount: 0, due: 'Sin fecha', category: 'otros', paid: false });
          state.paymentsCursor = state.payments.length - 1; savePayments(); io.emit('stateUpdate', state);
        }
        return;
      }

      if (/(pagad[oa]|pagar|marcar|ya pagu|cobrad[oa])/.test(currentTNorm)) {
        let targetPayment = null, targetIdx = -1;
        for (let i = 0; i < state.payments.length; i++) {
          if (currentTNorm.includes(norm(state.payments[i].name))) { targetPayment = state.payments[i]; targetIdx = i; break; }
        }
        if (targetPayment) {
          targetPayment.paid = true; state.paymentsCursor = targetIdx; savePayments(); io.emit('stateUpdate', state);
          socket.emit('paymentPaid', { name: targetPayment.name });
        } else {
          const p = state.payments[state.paymentsCursor];
          if (!p) { socket.emit('taskError'); return; }
          p.paid = true; savePayments(); io.emit('stateUpdate', state);
          socket.emit('paymentPaid', { name: p.name });
        }
        return;
      }

      // Añadir pago con cantidad
      let cleaned    = currentText.replace(/\s*(?:euros?|€)$/i, '').trim();
      let wordsArray = cleaned.split(/\s+/);
      let nameWords = [], amountWords = [];
      const numWords = ["cero","un","uno","una","dos","tres","cuatro","cinco","seis","siete","ocho","nueve",
        "diez","once","doce","trece","catorce","quince","dieciseis","dieciséis","diecisiete","dieciocho","diecinueve",
        "veinte","veintiun","veintiuno","veintidos","veintitres","veinticuatro","veinticinco","veintiseis","veintisiete","veintiocho","veintinueve",
        "treinta","cuarenta","cincuenta","sesenta","setenta","ochenta","noventa","cien","ciento",
        "doscientos","trescientos","cuatrocientos","quinientos","seiscientos","setecientos","ochocientos","novecientos","mil",
        "con","coma","punto","y","euro","euros","€","centimo","centimos","céntimo","céntimos"];
      for (let i = wordsArray.length - 1; i >= 0; i--) {
        let w = wordsArray[i].toLowerCase();
        if (!isNaN(parseFloat(w.replace(/[,']/g, '.'))) || numWords.includes(w)) { amountWords.unshift(wordsArray[i]); }
        else { nameWords = wordsArray.slice(0, i + 1); break; }
      }
      if (nameWords.length > 0 && amountWords.length > 0) {
        const name = nameWords.join(' ');
        let amountStr = amountWords.join(' ').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        
        // 1. Convertir separadores hablados (y comas) a un punto decimal
        amountStr = amountStr.replace(/\s+(con|coma|punto|y)\s+/g, '.').replace(/,/g, '.');
        
        // 2. Eliminar cualquier carácter que no sea un número o un punto
        let digitsOnly = amountStr.replace(/[^\d.]/g, '');
        
        // 3. Convertir a float de forma segura
        let amount = parseFloat(digitsOnly);
        if (isNaN(amount)) amount = 0;

        const newPayment = { id: Date.now(), name: name.charAt(0).toUpperCase() + name.slice(1), icon: '💳', amount, due: 'Sin fecha', category: 'otros', paid: false };
        
        // --- SI EL IMPORTE ES 0, PEDIMOS CONFIRMACIÓN ---
        if (amount === 0) {
          socket.pendingPayment = newPayment;
          socket.emit('askPaymentConfirmation', { name: newPayment.name });
          
          // Si no responde en 10 segundos, lo cancelamos automáticamente
          socket.pendingPaymentTimer = setTimeout(() => {
            if (socket.pendingPayment === newPayment) {
              socket.pendingPayment = null;
              socket.emit('paymentCancelledTimeout', { name: newPayment.name });
            }
          }, 10000); 
          return;
        }

        state.payments.push(newPayment);
        state.paymentsCursor = state.payments.length - 1;
        savePayments(); io.emit('stateUpdate', state);
        socket.emit('taskSaved', { text: `Pago: ${newPayment.name} (${amount.toFixed(2)}€)` });
        return;
      }
      socket.emit('voiceUnknown', { text }); return;
    }

    // ── SECCIÓN: ELECTRODOMÉSTICOS ──
    if (state.activeSection === 'appliances') {
      const words = text.trim().split(/\s+/);
      const actionWord = norm(words[0]);

      // Función para detectar la categoría por la palabra clave
      const getCatInfo = (txt) => {
        if (/(persiana|estor|toldo)/.test(txt)) return { cat: 'blind', icon: '🪟' };
        if (/(calefaccion|radiador|estufa)/.test(txt)) return { cat: 'heating', icon: '🌡️' };
        if (/(aire acondicionado|climatizador)/.test(txt)) return { cat: 'ac', icon: '❄️' };
        if (/(ventilador|techo)/.test(txt)) return { cat: 'fan', icon: '🌀' };
        if (/(luz|luces|lampara|foco)/.test(txt)) return { cat: 'light', icon: '💡' };
        return { cat: 'other', icon: '🔌' };
      };

      // 1. Añadir
      if (/^(anadir|anade|crear|crea|agregar|agrega|nueva|nuevo)$/.test(actionWord)) {
        const name = words.slice(1).join(' ').trim();
        if (!name) { socket.emit('voiceUnknown', { text }); return; }
        
        const info = getCatInfo(norm(name));
        const existe = state.appliances.some(a => norm(a.name) === norm(name));
        if (existe) { socket.emit('taskIgnored', { text: `Ya existe: ${name}` }); return; }

        const newApp = { name: name.charAt(0).toUpperCase() + name.slice(1), category: info.cat, icon: info.icon, on: false };
        state.appliances.push(newApp);
        state.appliancesCursor = state.appliances.length - 1;
        saveAppliances(); io.emit('stateUpdate', state);
        socket.emit('taskSaved', { text: `Añadido: ${newApp.name}` });
        return;
      }

      // 2. Eliminar
      if (/^(eliminar|borrar|quitar|borra|elimina)$/.test(actionWord)) {
        const targetName = words.slice(1).join(' ').trim();
        if (!targetName) { socket.emit('voiceUnknown', { text }); return; }

        const idx = state.appliances.findIndex(a => norm(a.name).includes(norm(targetName)) || norm(targetName).includes(norm(a.name)));
        if (idx !== -1) {
          if (norm(state.appliances[idx].name).includes("luz habitacion")) {
            socket.emit('taskIgnored', { text: "Ese dispositivo no se puede borrar" }); return;
          }
          const removed = state.appliances.splice(idx, 1)[0];
          state.appliancesCursor = Math.max(0, Math.min(state.appliancesCursor, state.appliances.length - 1));
          saveAppliances(); io.emit('stateUpdate', state);
          socket.emit('taskDeleted', { text: removed.name });
        } else { socket.emit('voiceUnknown', { text }); }
        return;
      }

      // 3. Encender/Apagar/Subir/Bajar
      const TOGGLE_OFF = /apag|desactiv|apagar|desactivar|bajar|baja|cierra|cerrar/;
      const TOGGLE_ON  = /encend|activ|encender|activar|subir|sube|abre|abrir/;
      let targetApp = null, targetIdx = -1;
      
      for (let i = 0; i < state.appliances.length; i++) {
        if (tNorm.includes(norm(state.appliances[i].name))) { targetApp = state.appliances[i]; targetIdx = i; break; }
      }
      
      if (targetApp) {
        if (TOGGLE_OFF.test(tNorm)) targetApp.on = false;
        else if (TOGGLE_ON.test(tNorm)) targetApp.on = true;
        else { socket.emit('voiceUnknown', { text }); return; }
        
        state.appliancesCursor = targetIdx; 
        saveAppliances(); io.emit('stateUpdate', state);
        socket.emit('applianceToggled', { name: targetApp.name, on: targetApp.on }); 
        return;
      } else {
        socket.emit('voiceUnknown', { text }); return;
      }
    }

    // ── MENÚ PRINCIPAL ──
    if (state.activeSection === null) {
      if (/(electrodomestico|electrodomesticos|dispositivo|dispositivos)/.test(tNorm)) { state.activeSection = 'appliances'; io.emit('stateUpdate', state); socket.emit('taskSaved', { text: '🔌 Abriendo Dispositivos' }); return; }
      if (/(tarea|tareas)/.test(tNorm))              { state.activeSection = 'tasks';    io.emit('stateUpdate', state); socket.emit('taskSaved', { text: '✅ Abriendo Tareas' });   return; }
      if (/(^objeto|^objetos)/.test(tNorm))          { state.activeSection = 'objects';  io.emit('stateUpdate', state); socket.emit('taskSaved', { text: '📦 Abriendo Objetos' }); return; }
      if (/(pago|pagos|cuenta|cuentas)/.test(tNorm)) { state.activeSection = 'payments'; io.emit('stateUpdate', state); socket.emit('taskSaved', { text: '💳 Abriendo Pagos' });   return; }
      // Consulta o registro de objeto sin entrar en la sección
      if (handleObjectVoice(socket, t, tNorm)) return;
      socket.emit('voiceUnknown', { text }); return;
    }

    socket.emit('taskIgnored', { text });
  });

  // ── ENTER ──
  socket.on('enter', () => {
    if (state.activeSection === null) {
      const sections = ['appliances', 'tasks', 'objects', 'payments'];
      const idx      = state.cursor.y * GRID_W + state.cursor.x;
      state.activeSection = sections[idx];
    }
    io.emit('stateUpdate', state);
  });

  // ── BACK ──
  socket.on('back', () => {
    // ── LÓGICA DE SALIDA DEL CHAT ──
    if (state.activeSection === 'chat') {
      console.log("🔙 Saliendo del chat con Pepe");
      // Volvemos al inicio
      state.activeSection = null;
      
      // Enviamos el evento para que la pantalla se entere y cambie
      io.emit('stateUpdate', state);
      
      // Le decimos a la pantalla explícitamente que cierre la UI de Pepe
      io.emit('aiCommand', { action: 'close' });
      return; // Importante para que no siga bajando
    }
    if (state.activeSection !== null) {
      state.activeSection = null;
      io.emit('stateUpdate', state);
    }
  });

  // ── ACTION (giroscopio/botón) — en objetos no hace toggle, abre historial ──
  socket.on('action', async () => {
    if (state.activeSection === null) return;

    if (state.activeSection === 'appliances' && state.appliances.length > 0) {
      const a = state.appliances[state.appliancesCursor];
      a.on = !a.on;
      saveAppliances();
      io.emit('applianceToggled', { name: a.name, on: a.on });
    } else if (state.activeSection === 'objects' && state.objects.length > 0) {
      // En objetos, action emite el historial del objeto seleccionado
      const obj = state.objects[state.objectsCursor];
      if (obj) socket.emit('objectHistory', { obj });
      return; // No emitimos stateUpdate aquí
    } else if (state.activeSection === 'payments' && state.payments.length > 0) {
      state.payments[state.paymentsCursor].paid = !state.payments[state.paymentsCursor].paid;
      savePayments();
    } else if (state.activeSection === 'tasks') {
      try {
        let dbTasks = await readTasks();
        if (dbTasks.length > 0 && state.tasksCursor < dbTasks.length) {
          dbTasks[state.tasksCursor].done = !dbTasks[state.tasksCursor].done;
          await writeTasks(dbTasks);
          state.tasks = dbTasks.map(t => ({ id: t.id, person: t.assignee || 'Casa', title: t.title, done: t.done || false }));
        }
      } catch(e) {}
    }

    io.emit('stateUpdate', state);
  });
});

// ── UTILIDAD: tiempo relativo ──
function timeAgo(date) {
  const diff = Math.floor((Date.now() - date) / 1000);
  if (diff < 60)   return 'hace unos segundos';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} minutos`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} horas`;
  return `hace ${Math.floor(diff / 86400)} días`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🏠 Smart Home Server running on http://localhost:${PORT}`);
  console.log(`📺 Screen  → http://localhost:${PORT}/screen.html`);
  console.log(`📱 Mobile  → http://localhost:${PORT}/mobile.html\n`);
});