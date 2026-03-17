const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs').promises;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── BASES DE DATOS INDEPENDIENTES POR ZONA ──

const DATA_DIR = path.join(__dirname, 'data');
if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR);

const FILES = {
  lights: path.join(DATA_DIR, 'lights.json'),
  objects: path.join(DATA_DIR, 'objects.json'),
  payments: path.join(DATA_DIR, 'payments.json'),
  tasks: path.join(DATA_DIR, 'tasks.json')
};

// Datos predeterminados si los archivos no existen la primera vez
const defaultData = {
  lights: [
    { name: "Techo", room: "Salón", icon: "💡", on: false },
    { name: "Lectura", room: "Salón", icon: "📖", on: false },
    { name: "Principal", room: "Cocina", icon: "🍳", on: true },
    { name: "Pasillo", room: "Pasillo", icon: "🚪", on: false }
  ],
  objects: [
    { name: "Termostato", icon: "🌡️", value: "22°C", active: true },
    { name: "Persianas", icon: "🪟", value: "Abiertas", active: false }
  ],
  payments: [
    { id: 1, name: "Alquiler", icon: "🏠", amount: 850, due: "Día 1", category: "vivienda", paid: false }
  ],
  tasks: []
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
function saveLights()   { fsSync.writeFileSync(FILES.lights, JSON.stringify(state.lights, null, 2), 'utf8'); }
function saveObjects()  { fsSync.writeFileSync(FILES.objects, JSON.stringify(state.objects, null, 2), 'utf8'); }
function savePayments() { fsSync.writeFileSync(FILES.payments, JSON.stringify(state.payments, null, 2), 'utf8'); }

// Para tareas mantenemos las que ya tienes asíncronas
async function writeTasks(tasks) { fsSync.writeFileSync(FILES.tasks, JSON.stringify(tasks, null, 2), 'utf8'); }
async function readTasks() { return loadJSON('tasks'); }

// Inicializamos el estado general de la casa
let state = {
  activeSection: null,
  cursor: { x: 0, y: 0 },
  lightsCursor: 0, tasksCursor: 0, objectsCursor: 0, paymentsCursor: 0,
  lights: loadJSON('lights'),
  objects: loadJSON('objects'),
  payments: loadJSON('payments'),
  tasks: loadJSON('tasks')
};

// ── LÓGICA DE TAREAS (API REST) ───────────────────────────────────────────────

const DATA_FILE = path.join(__dirname, 'data', 'tasks.json');

async function readTasks() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

async function writeTasks(tasks) {
  await fs.writeFile(DATA_FILE, JSON.stringify(tasks, null, 2));
}

app.get('/api/tasks', async (req, res) => {
  const tasks = await readTasks();
  res.json(tasks);
});

app.post('/api/tasks', async (req, res) => {
  const newTask = req.body;
  if (!newTask.title) {
    return res.status(400).json({ error: 'El título de la tarea es obligatorio' });
  }
  let tasks = await readTasks();
  newTask.id = Date.now().toString();
  newTask.assignee = newTask.assignee || 'Casa';
  tasks.push(newTask);
  await writeTasks(tasks);
  res.status(201).json(newTask);
});

app.put('/api/tasks/:id', async (req, res) => {
  const taskId = req.params.id;
  const updatedTask = req.body;
  let tasks = await readTasks();
  const index = tasks.findIndex(task => task.id === taskId);
  if (index === -1) {
    return res.status(404).json({ error: 'Tarea no encontrada' });
  }
  tasks[index] = { ...tasks[index], ...updatedTask };
  await writeTasks(tasks);
  res.json(tasks[index]);
});

app.delete('/api/tasks/:id', async (req, res) => {
  const taskId = req.params.id;
  let tasks = await readTasks();
  const index = tasks.findIndex(task => task.id === taskId);
  if (index === -1) {
    return res.status(404).json({ error: 'Tarea no encontrada' });
  }
  const removedTask = tasks.splice(index, 1)[0];
  await writeTasks(tasks);
  res.json(removedTask);
});

// ── GRID CONFIG ───────────────────────────────────────────────────────────────
const GRID_W = 2, GRID_H = 2;

// ── SOCKET LOGIC ──────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  socket.emit('fullState', state);

  socket.on('navigate', async dir => {
    if (state.activeSection === null) {
      let { x, y } = state.cursor;
      if (dir === 'left')  x = Math.max(0, x - 1);
      if (dir === 'right') x = Math.min(1, x + 1);
      if (dir === 'up')    y = Math.max(0, y - 1);
      if (dir === 'down')  y = Math.min(1, y + 1);
      state.cursor = { x, y };
    } else {
      const key     = state.activeSection + 'Cursor';
      const listKey = state.activeSection;

      // Sincronizamos las tareas reales antes de movernos
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
          // LÓGICA DE COLUMNAS PARA TAREAS
          const persons = [...new Set(list.map(t => t.person || t.assignee || 'Casa'))];
          const cols = persons.map(p => {
            let indices = [];
            list.forEach((t, originalIndex) => {
              if ((t.person || t.assignee || 'Casa') === p) indices.push(originalIndex);
            });
            return indices;
          });

          // Buscar fila y columna actual
          let c = 0, r = 0;
          for (let i = 0; i < cols.length; i++) {
            const rIdx = cols[i].indexOf(cur);
            if (rIdx !== -1) { c = i; r = rIdx; break; }
          }

          // Aplicar movimiento 2D
          if (dir === 'left')  c = Math.max(0, c - 1);
          if (dir === 'right') c = Math.min(cols.length - 1, c + 1);
          if (dir === 'up')    r = Math.max(0, r - 1);
          if (dir === 'down')  r = Math.min(cols[c].length - 1, r + 1);

          r = Math.min(r, cols[c].length - 1);
          cur = cols[c][r];

        } else {
          // Lógica para Luces, Objetos y Pagos (Pagos tiene 1 columna, Luces tiene 4)
          let numCols = 1; 
          if (listKey === 'lights' || listKey === 'objects') numCols = 4; 

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

  // ── VOZ: lógica por sección activa ─────────────────────────────────────────
  socket.on('voiceTask', async (text) => {
    if (!text || text.trim() === '') return;
    const t = text.trim().toLowerCase();
    
    // Función auxiliar para quitar tildes y comparar fácilmente (Ej: "Salón" -> "salon")
    const norm = str => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const tNorm = norm(t);

    const TOGGLE_OFF = /apag|a pagar|desactiv|apaga|desactiva|apagar|desactivar/;
    const TOGGLE_ON  = /encend|activ|enciende|activa|encender|activar/;

    // ── SECCIÓN: TAREAS ──────────────────────────────────────────────────────
    if (state.activeSection === 'tasks') {
      const words = text.trim().split(/\s+/);
      const actionWord = norm(words[0]); // Cogemos la 1ª palabra y le quitamos tildes (ej: "Añadir" -> "anadir")

      // 1. Lógica para Eliminar
      if (/^(eliminar|borrar|quitar|borra|elimina)$/.test(actionWord)) {
        try {
          let tasks = await readTasks();
          if (tasks.length === 0) { socket.emit('taskError'); return; }

          // Si el usuario dijo más de una palabra (ej: "Borrar comprar pan")
          if (words.length > 1) {
            const targetText = norm(words.slice(1).join(' '));

            // Buscamos si el texto encaja con la persona o la tarea
            const exactIdx = tasks.findIndex(task =>
              norm(task.assignee + ' ' + task.title).includes(targetText) ||
              norm(task.title).includes(targetText)
            );

            if (exactIdx !== -1) {
              const removed = tasks.splice(exactIdx, 1)[0];
              await writeTasks(tasks);
              state.tasks = tasks.map(t => ({
                id: t.id, person: t.assignee || 'Casa', title: t.title, done: t.done || false
              }));
              state.tasksCursor = Math.max(0, Math.min(state.tasksCursor, tasks.length - 1));
              io.emit('stateUpdate', state);
              socket.emit('taskDeleted', { text: removed.title });
              return;
            } else {
              // ¡NUEVO!: Dijo un nombre pero no existe. Avisamos y cancelamos el borrado.
              socket.emit('voiceUnknown', { text });
              return;
            }
          }

          // Solo llega aquí si la ÚNICA palabra que pronunciaste fue "borrar"
          const idx = Math.min(state.tasksCursor, tasks.length - 1);
          const removed = tasks.splice(idx, 1)[0];
          await writeTasks(tasks);
          state.tasksCursor = Math.max(0, idx - 1);
          io.emit('stateUpdate', state);
          socket.emit('taskDeleted', { text: removed.title });
        } catch (err) { socket.emit('taskError'); }
        return;
      }
      
      // 2. Lógica para Añadir
      if (/^(anadir|anade|crear|crea|pon|poner|agregar|agrega|nueva|nuevo)$/.test(actionWord)) {
        words.shift(); // Eliminamos la palabra de acción ("añadir") de la lista de palabras
        
        if (words.length === 0) return; // Si solo dijo "Añadir" y nada más, se ignora

        let assignee = 'Casa';
        let title = '';

        if (words.length > 1) {
          // La siguiente palabra asume que es la persona
          const rawName = words[0];
          assignee = rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
          // El resto es la tarea
          title = words.slice(1).join(' ');
        } else {
          // Si por error dijo solo "Añadir pan", va a la lista general
          title = words[0];
        }

        const newTask = { id: Date.now().toString(), title: title, assignee: assignee, done: false };
        try {
          let tasks = await readTasks();
          tasks.push(newTask);
          await writeTasks(tasks);
          
          // 💾 ¡NUEVO!: Actualizar la memoria visual antes de avisar a la pantalla
          state.tasks = tasks.map(t => ({
            id: t.id, person: t.assignee || 'Casa', title: t.title, done: t.done || false
          }));
          
          state.tasksCursor = state.tasks.length - 1;
          io.emit('stateUpdate', state);
          
          io.emit('taskAdded', { text: title });
          socket.emit('taskSaved', { text: `${assignee}: ${title}` }); 
        } catch (err) { socket.emit('taskError'); }
        return;
      }

      // 3. Si no entendió la primera palabra (ni añadir ni borrar)
      socket.emit('voiceUnknown', { text });
      return;
    }

    // ── SECCIÓN: PAGOS ───────────────────────────────────────────────────────
    if (state.activeSection === 'payments') {
      const words = text.trim().split(/\s+/);
      const actionWord = norm(words[0]);

      // 1. Eliminar un pago (ej: "borrar coche", "quitar agua")
      if (/^(eliminar|borrar|quitar|borra|elimina)$/.test(actionWord)) {
        // Quitamos la primera palabra ("borrar") para quedarnos con el nombre buscado
        const targetNameNorm = norm(words.slice(1).join(' '));
        
        if (state.payments.length === 0) { socket.emit('taskError'); return; }

        // Si hay texto después de la palabra "borrar"
        if (targetNameNorm !== '') {
          // Buscar el pago por nombre
          const exactIdx = state.payments.findIndex(p => norm(p.name) === targetNameNorm || targetNameNorm.includes(norm(p.name)));
          
          if (exactIdx !== -1) {
            const removed = state.payments.splice(exactIdx, 1)[0];
            state.paymentsCursor = Math.max(0, Math.min(state.paymentsCursor, state.payments.length - 1));
            savePayments();
            io.emit('stateUpdate', state);
            socket.emit('taskDeleted', { text: removed.name });
            return;
          } else {
            // ¡NUEVO!: Dijo un nombre pero no existe. Avisamos y cancelamos el borrado.
            socket.emit('voiceUnknown', { text });
            return;
          }
        }

        // Solo llega aquí si la ÚNICA palabra pronunciada fue "borrar" (borra el seleccionado)
        const idx = Math.min(state.paymentsCursor, state.payments.length - 1);
        const removed = state.payments.splice(idx, 1)[0];
        state.paymentsCursor = Math.max(0, idx - 1);
        savePayments();
        io.emit('stateUpdate', state);
        socket.emit('taskDeleted', { text: removed.name });
        return;
      }

      // TRUCO: Si la frase empieza por "añadir", "crear", etc., se lo quitamos a la frase 
      // para que el resto del código funcione exactamente igual que antes.
      let currentText = t;
      let currentTNorm = tNorm;
      
      if (/^(anadir|anade|crear|crea|pon|poner|agregar|agrega|nuevo|nueva)$/.test(actionWord)) {
        currentText = words.slice(1).join(' ');
        currentTNorm = norm(currentText);
      }

      // Si después de quitar "añadir" se quedó vacío, no hacemos nada
      if (currentText.trim() === '') {
         socket.emit('voiceUnknown', { text });
         return;
      }

      // 2. Poner en PENDIENTE o CREAR vacío si no existe (ej: "[añadir] coche pendiente")
      if (/(pendiente|no pagad[oa]|sin pagar|debe)/.test(currentTNorm)) {
        let rawName = currentText.replace(/(pendiente|no pagado|no pagada|sin pagar|debe)/gi, '').trim();
        
        if (rawName === '') {
           const p = state.payments[state.paymentsCursor];
           if (!p) { socket.emit('taskError'); return; }
           p.paid = false;
           savePayments();
           io.emit('stateUpdate', state);
           return;
        }

        let targetPayment = null;
        let targetIdx = -1;

        for (let i = 0; i < state.payments.length; i++) {
           if (norm(state.payments[i].name) === norm(rawName) || currentTNorm.includes(norm(state.payments[i].name))) {
               targetPayment = state.payments[i];
               targetIdx = i;
               break;
           }
        }

        if (targetPayment) {
           targetPayment.paid = false;
           state.paymentsCursor = targetIdx; 
           savePayments();
           io.emit('stateUpdate', state);
           return;
        } else {
           const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
           const newPayment = { id: Date.now(), name: name, icon: '💳', amount: 0, due: 'Sin fecha', category: 'otros', paid: false };
           state.payments.push(newPayment);
           state.paymentsCursor = state.payments.length - 1;
           savePayments();
           io.emit('stateUpdate', state);
           return;
        }
      }

      // 3. Marcar como PAGADO (ej: "agua pagada")
      if (/(pagad[oa]|pagar|marcar|ya pagu|cobrad[oa])/.test(currentTNorm)) {
        let targetPayment = null;
        let targetIdx = -1;

        for (let i = 0; i < state.payments.length; i++) {
           if (currentTNorm.includes(norm(state.payments[i].name))) {
               targetPayment = state.payments[i];
               targetIdx = i;
               break;
           }
        }

        if (targetPayment) {
           targetPayment.paid = true;
           state.paymentsCursor = targetIdx;
           savePayments();
           io.emit('stateUpdate', state);
           socket.emit('paymentPaid', { name: targetPayment.name });
           return;
        } else {
           const p = state.payments[state.paymentsCursor];
           if (!p) { socket.emit('taskError'); return; }
           p.paid = true;
           savePayments();
           io.emit('stateUpdate', state);
           socket.emit('paymentPaid', { name: p.name });
           return;
        }
      }

      // 4. Añadir nuevo pago con cantidad (dígitos o hablado)
      let cleaned = currentText.replace(/\s*(?:euros?|€)$/i, '').trim();
      let wordsArray = cleaned.split(/\s+/);
      let nameWords = [];
      let amountWords = [];

      // Añadimos centenas y miles al diccionario
      const numWords = ["cero","un","uno","una","dos","tres","cuatro","cinco","seis","siete","ocho","nueve",
          "diez","once","doce","trece","catorce","quince","dieciseis","dieciséis","diecisiete","dieciocho","diecinueve",
          "veinte","veintiun","veintiún","veintiuno","veintidos","veintidós","veintitres","veintitrés","veinticuatro","veinticinco","veintiseis","veintiséis","veintisiete","veintiocho","veintinueve",
          "treinta","cuarenta","cincuenta","sesenta","setenta","ochenta","noventa","cien","ciento",
          "doscientos","trescientos","cuatrocientos","quinientos","seiscientos","setecientos","ochocientos","novecientos","mil",
          "con","coma","punto","y","euro","euros","€","centimo","centimos","céntimo","céntimos"];

      // Recorremos la frase desde el final hacia el principio
      for (let i = wordsArray.length - 1; i >= 0; i--) {
          let w = wordsArray[i].toLowerCase();
          // Convertimos cualquier apóstrofe o coma en punto para que parseFloat no se vuelva loco
          if (!isNaN(parseFloat(w.replace(/[,']/g, '.'))) || numWords.includes(w)) {
              amountWords.unshift(wordsArray[i]); 
          } else {
              nameWords = wordsArray.slice(0, i + 1);
              break;
          }
      }

      if (nameWords.length > 0 && amountWords.length > 0) {
          const rawName = nameWords.join(' ');
          const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
          
          let amountStr = amountWords.join(' ').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[,']/g, '.');
          let amount = 0;

          // Limpiamos la frase de "euros" o "centimos" si el móvil ya lo pilló en dígitos perfectos
          let digitsOnlyStr = amountStr.replace(/\s*(?:euros?|€|centimos?)/g, '').trim();

          if (/^\d+(\.\d+)?$/.test(digitsOnlyStr)) {
              amount = parseFloat(digitsOnlyStr);
          } else {
              const map = {
                  'cero':0, 'un':1, 'uno':1, 'una':1, 'dos':2, 'tres':3, 'cuatro':4, 'cinco':5, 'seis':6, 'siete':7, 'ocho':8, 'nueve':9,
                  'diez':10, 'once':11, 'doce':12, 'trece':13, 'catorce':14, 'quince':15, 'dieciseis':16, 'diecisiete':17, 'dieciocho':18, 'diecinueve':19,
                  'veinte':20, 'veintiun':21, 'veintiuno':21, 'veintidos':22, 'veintitres':23, 'veinticuatro':24, 'veinticinco':25, 'veintiseis':26, 'veintisiete':27, 'veintiocho':28, 'veintinueve':29,
                  'treinta':30, 'cuarenta':40, 'cincuenta':50, 'sesenta':60, 'setenta':70, 'ochenta':80, 'noventa':90, 'cien':100, 'ciento':100,
                  'doscientos':200, 'trescientos':300, 'cuatrocientos':400, 'quinientos':500, 'seiscientos':600, 'setecientos':700, 'ochocientos':800, 'novecientos':900
              };

              let parts = amountStr.split(/\s+(?:con|coma|punto)\s+/);
              
              function calcSum(s) {
                  if (!s) return 0;
                  let sum = 0;
                  for (let w of s.split(/\s+/)) {
                      if (w === 'mil') {
                          sum = sum === 0 ? 1000 : sum * 1000;
                      } else if (map[w] !== undefined) {
                          sum += map[w];
                      } else if (!isNaN(parseFloat(w))) {
                          sum += parseFloat(w);
                      }
                  }
                  return sum;
              }

              let intVal = calcSum(parts[0]);
              let decVal = parts.length > 1 ? calcSum(parts[1]) : 0;
              let finalDec = 0;
              
              if (decVal > 0) {
                  let decStr = parts[1].trim();
                  if (decStr.includes('centimo') || decStr.match(/^0/) || decStr.match(/^cero/)) {
                      finalDec = decVal / 100;
                  } else {
                      if (decVal < 10) finalDec = decVal / 10;
                      else if (decVal < 100) finalDec = decVal / 100;
                      else finalDec = decVal / 1000;
                  }
              }
              amount = intVal + finalDec;
          }

          const newPayment = { id: Date.now(), name, icon: '💳', amount, due: 'Sin fecha', category: 'otros', paid: false };
          state.payments.push(newPayment);
          
          state.paymentsCursor = state.payments.length - 1;
          savePayments();
          io.emit('stateUpdate', state);
          socket.emit('taskSaved', { text: `Pago: ${name} (${amount.toFixed(2)}€)` });
          return;
      }
      
      socket.emit('voiceUnknown', { text });
      return;
    }

    // ── SECCIÓN: LUCES ───────────────────────────────────────────────────────
    if (state.activeSection === 'lights') {
      let targetLight = null;
      let targetIdx = -1;

      // Buscar si el texto contiene el nombre de la luz o habitación (ej: "Salón")
      for (let i = 0; i < state.lights.length; i++) {
         if (tNorm.includes(norm(state.lights[i].name)) || tNorm.includes(norm(state.lights[i].room))) {
             targetLight = state.lights[i];
             targetIdx = i;
             break;
         }
      }

      if (targetLight) {
         if (TOGGLE_OFF.test(t)) targetLight.on = false;
         else if (TOGGLE_ON.test(t)) targetLight.on = true;
         else { socket.emit('voiceUnknown', { text }); return; }

         state.lightsCursor = targetIdx; // Movemos el puntero a esa luz
         saveLights();
         io.emit('stateUpdate', state);
         socket.emit('lightToggled', { name: targetLight.name, on: targetLight.on });
         return;
      } else {
         // Fallback a la luz seleccionada si no dijo nombre
         const l = state.lights[state.lightsCursor];
         if (!l) { socket.emit('taskError'); return; }
         if (TOGGLE_OFF.test(t)) { l.on = false; }
         else if (TOGGLE_ON.test(t)) { l.on = true; }
         else { socket.emit('voiceUnknown', { text }); return; }
         saveLights();
         io.emit('stateUpdate', state);
         socket.emit('lightToggled', { name: l.name, on: l.on });
         return;
      }
    }

    // ── SECCIÓN: OBJETOS ─────────────────────────────────────────────────────
    if (state.activeSection === 'objects') {
      let targetObj = null;
      let targetIdx = -1;

      // Buscar si el texto contiene el nombre del objeto (ej: "Lavadora")
      for (let i = 0; i < state.objects.length; i++) {
         if (tNorm.includes(norm(state.objects[i].name))) {
             targetObj = state.objects[i];
             targetIdx = i;
             break;
         }
      }

      if (targetObj) {
         if (TOGGLE_OFF.test(t)) targetObj.active = false;
         else if (TOGGLE_ON.test(t)) targetObj.active = true;
         else { socket.emit('voiceUnknown', { text }); return; }

         state.objectsCursor = targetIdx; 
         saveObjects();
         io.emit('stateUpdate', state);
         socket.emit('objectToggled', { name: targetObj.name, active: targetObj.active });
         return;
      } else {
         const o = state.objects[state.objectsCursor];
         if (!o) { socket.emit('taskError'); return; }
         if (TOGGLE_OFF.test(t)) { o.active = false; }
         else if (TOGGLE_ON.test(t)) { o.active = true; }
         else { socket.emit('voiceUnknown', { text }); return; }
         saveObjects();
         io.emit('stateUpdate', state);
         socket.emit('objectToggled', { name: o.name, active: o.active });
         return;
      }
    }

    // ── PANTALLA PRINCIPAL (MENÚ) ───────────────────────────────────────────
    if (state.activeSection === null) {
      if (/(luz|luces)/.test(tNorm)) { 
        state.activeSection = 'lights'; 
        io.emit('stateUpdate', state); 
        socket.emit('taskSaved', { text: '💡 Abriendo Luces' }); 
        return; 
      }
      if (/(tarea|tareas)/.test(tNorm)) { 
        state.activeSection = 'tasks'; 
        io.emit('stateUpdate', state); 
        socket.emit('taskSaved', { text: '✅ Abriendo Tareas' }); 
        return; 
      }
      if (/(objeto|objetos|domotica)/.test(tNorm)) { 
        state.activeSection = 'objects'; 
        io.emit('stateUpdate', state); 
        socket.emit('taskSaved', { text: '🏠 Abriendo Objetos' }); 
        return; 
      }
      if (/(pago|pagos|cuenta|cuentas)/.test(tNorm)) { 
        state.activeSection = 'payments'; 
        io.emit('stateUpdate', state); 
        socket.emit('taskSaved', { text: '💳 Abriendo Pagos' }); 
        return; 
      }
      
      socket.emit('voiceUnknown', { text });
      return;
    }

    // Cualquier otra sección
    socket.emit('taskIgnored', { text });
  });

  socket.on('enter', () => {
    if (state.activeSection === null) {
      const sections = ['lights', 'tasks', 'objects', 'payments'];
      const idx = state.cursor.y * GRID_W + state.cursor.x;
      state.activeSection = sections[idx];
    }
    io.emit('stateUpdate', state);
  });

  socket.on('back', () => {
    if (state.activeSection !== null) {
      state.activeSection = null;
      io.emit('stateUpdate', state);
      console.log('🔙 Regresando al menú principal');
    }
  });

  socket.on('action', async () => {
    if (state.activeSection === null) return;
    
    if (state.activeSection === 'lights' && state.lights.length > 0) {
      state.lights[state.lightsCursor].on = !state.lights[state.lightsCursor].on;
      saveLights(); // 💾 ¡NUEVO!: Guardar luces
    }
    else if (state.activeSection === 'objects' && state.objects.length > 0) {
      state.objects[state.objectsCursor].active = !state.objects[state.objectsCursor].active;
      saveObjects(); // 💾 ¡NUEVO!: Guardar objetos
    }
    else if (state.activeSection === 'payments' && state.payments.length > 0) {
      state.payments[state.paymentsCursor].paid = !state.payments[state.paymentsCursor].paid;
      savePayments(); // 💾 ¡NUEVO!: Guardar pagos
    }
    else if (state.activeSection === 'tasks') {
      try {
        let dbTasks = await readTasks();
        if (dbTasks.length > 0 && state.tasksCursor < dbTasks.length) {
          dbTasks[state.tasksCursor].done = !dbTasks[state.tasksCursor].done;
          await writeTasks(dbTasks);
          
          // 💾 ¡NUEVO!: Actualizar la memoria visual para que la pantalla lo vea al instante
          state.tasks = dbTasks.map(t => ({
            id: t.id, person: t.assignee || 'Casa', title: t.title, done: t.done || false
          }));
        }
      } catch(e) {}
    }
    
    io.emit('stateUpdate', state);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🏠 Smart Home Server running on http://localhost:${PORT}`);
  console.log(`📺 Screen  → http://localhost:${PORT}/screen.html`);
  console.log(`📱 Mobile  → http://localhost:${PORT}/mobile.html\n`);
});