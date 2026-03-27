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

// ── BASES DE DATOS INDEPENDIENTES POR ZONA ──

const DATA_DIR = path.join(__dirname, 'data');
if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR);

const FILES = {
  lights:   path.join(DATA_DIR, 'lights.json'),
  objects:  path.join(DATA_DIR, 'objects.json'),
  payments: path.join(DATA_DIR, 'payments.json'),
  tasks:    path.join(DATA_DIR, 'tasks.json')
};

// Datos predeterminados si los archivos no existen la primera vez
const defaultData = {
  lights: [
    { name: "luz habitación", room: "Habitación", icon: "💡", on: false }
  ],
  objects: [],
  payments: [],
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
function saveLights()   { fsSync.writeFileSync(FILES.lights,   JSON.stringify(state.lights,   null, 2), 'utf8'); }
function saveObjects()  { fsSync.writeFileSync(FILES.objects,  JSON.stringify(state.objects,  null, 2), 'utf8'); }
function savePayments() { fsSync.writeFileSync(FILES.payments, JSON.stringify(state.payments, null, 2), 'utf8'); }

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
  lightsCursor: 0, tasksCursor: 0, objectsCursor: 0, paymentsCursor: 0,
  lights:   loadJSON('lights'),
  objects:  loadJSON('objects'),
  payments: loadJSON('payments'),
  tasks:    loadJSON('tasks')
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
    // Si no mencionó nombre concreto pero hay un objeto seleccionado, úsalo
    if (!found) found = state.objects[state.objectsCursor] || null;

    if (!found || !found.history || found.history.length === 0) {
      socket.emit('objectQuery', { found: false, name: found ? found.name : '?' });
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

        } else {
          let numCols = 1;
          if (listKey === 'lights')   numCols = 4;
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

  // ── VOZ ──
  socket.on('voiceTask', async (text) => {
    if (!text || text.trim() === '') return;
    const t     = text.trim().toLowerCase();
    const tNorm = norm(t);

    const TOGGLE_OFF = /apag|desactiv|apagar|desactivar/;
    const TOGGLE_ON  = /encend|activ|encender|activar/;

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

    // ── SECCIÓN: LUCES ──
    if (state.activeSection === 'lights') {
      const words = text.trim().split(/\s+/);
      const actionWord = norm(words[0]);

      // 1. Añadir nueva luz
      if (/^(anadir|anade|crear|crea|agregar|agrega|nueva|nuevo)$/.test(actionWord)) {
        const name = words.slice(1).join(' ').trim();
        if (!name) { socket.emit('voiceUnknown', { text }); return; }
        
        const nameNorm = norm(name);
        const existeLuz = state.lights.some(l => norm(l.name) === nameNorm);

        if (existeLuz) {
          // Si ya existe, enviamos un aviso al móvil y cancelamos
          socket.emit('taskIgnored', { text: `Ya existe una luz llamada ${name}` });
          return; 
        }

        const newLight = {
          name: name.charAt(0).toUpperCase() + name.slice(1),
          room: "General",
          icon: "💡",
          on: false
        };
        state.lights.push(newLight);
        state.lightsCursor = state.lights.length - 1;
        saveLights();
        io.emit('stateUpdate', state);
        socket.emit('taskSaved', { text: `Luz añadida: ${newLight.name}` });
        return;
      }

      // 2. Eliminar luz
      if (/^(eliminar|borrar|quitar|borra|elimina)$/.test(actionWord)) {
        const targetName = words.slice(1).join(' ').trim();
        
        // Si no dice nombre de luz a borrar, no hacemos nada (mostramos que no se entendió)
        if (!targetName) {
          socket.emit('voiceUnknown', { text });
          return;
        }

        // Si dice nombre, lo busca y lo borra
        const idx = state.lights.findIndex(l => norm(l.name).includes(norm(targetName)) || norm(targetName).includes(norm(l.name)));
        if (idx !== -1) {
          if (norm(state.lights[idx].name).includes("luz habitacion")) {
            // Enviamos error al móvil (vibrará y dirá que no está disponible)
            //Esta luz es de prueba para el bluetooth
            socket.emit('taskIgnored', { text: "Esa luz no se puede borrar" });
            return;
          }

          const removed = state.lights.splice(idx, 1)[0];
          state.lightsCursor = Math.max(0, Math.min(state.lightsCursor, state.lights.length - 1));
          saveLights(); 
          io.emit('stateUpdate', state);
          socket.emit('taskDeleted', { text: removed.name });
        } else { 
          // Si no encuentra la luz que se ha pedido borrar, no hace nada
          socket.emit('voiceUnknown', { text }); 
        }
        return;
      }

      // 3. Encender / Apagar
      const TOGGLE_OFF = /apag|desactiv|apagar|desactivar/;
      const TOGGLE_ON  = /encend|activ|encender|activar/;
      let targetLight = null, targetIdx = -1;
      
      for (let i = 0; i < state.lights.length; i++) {
        if (tNorm.includes(norm(state.lights[i].name)) || tNorm.includes(norm(state.lights[i].room))) {
          targetLight = state.lights[i]; targetIdx = i; break;
        }
      }
      
      // SOLO actúa si ha encontrado una coincidencia exacta de luz
      if (targetLight) {
        
        if (TOGGLE_OFF.test(t)) {
            targetLight.on = false;
        } 
        else if (TOGGLE_ON.test(t)) {
            targetLight.on = true;
        }
        else { socket.emit('voiceUnknown', { text }); return; }
        
        state.lightsCursor = targetIdx; 
        saveLights(); 
        io.emit('stateUpdate', state);
        socket.emit('lightToggled', { name: targetLight.name, on: targetLight.on }); 
        return;
      } else {
        // Si el comando es de encender/apagar pero no ha entendido la luz, NO hace nada (ni usa el cursor)
        socket.emit('voiceUnknown', { text }); 
        return;
      }
    }

    // ── MENÚ PRINCIPAL ──
    if (state.activeSection === null) {
      if (/(luz|luces)/.test(tNorm))                { state.activeSection = 'lights';   io.emit('stateUpdate', state); socket.emit('taskSaved', { text: '💡 Abriendo Luces' });   return; }
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
      const sections = ['lights', 'tasks', 'objects', 'payments'];
      const idx      = state.cursor.y * GRID_W + state.cursor.x;
      state.activeSection = sections[idx];
    }
    io.emit('stateUpdate', state);
  });

  // ── BACK ──
  socket.on('back', () => {
    if (state.activeSection !== null) {
      state.activeSection = null;
      io.emit('stateUpdate', state);
    }
  });

  // ── ACTION (giroscopio/botón) — en objetos no hace toggle, abre historial ──
  socket.on('action', async () => {
    if (state.activeSection === null) return;

    if (state.activeSection === 'lights' && state.lights.length > 0) {
      const l = state.lights[state.lightsCursor];
      l.on = !l.on;
      saveLights();
      // Avisamos al móvil para que envíe el comando Bluetooth
      io.emit('lightToggled', { name: l.name, on: l.on });
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