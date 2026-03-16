const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── STATE ────────────────────────────────────────────────────────────────────

const state = {
  cursor: { x: 1, y: 0 },
  activeSection: null,

  lights: [
    { id: 1, name: 'Salón',       icon: '💡', room: 'Salón',   on: true  },
    { id: 2, name: 'Cocina',      icon: '🔆', room: 'Cocina',  on: false },
    { id: 3, name: 'Dormitorio',  icon: '🌙', room: 'Dormi',   on: true  },
    { id: 4, name: 'Baño',        icon: '🚿', room: 'Baño',    on: false },
    { id: 5, name: 'Garaje',      icon: '🚗', room: 'Garaje',  on: false },
    { id: 6, name: 'Jardín',      icon: '🌿', room: 'Jardín',  on: true  },
    { id: 7, name: 'Estudio',     icon: '📚', room: 'Estudio', on: false },
    { id: 8, name: 'Terraza',     icon: '🌅', room: 'Terraza', on: false },
  ],

  tasks: [
    { id: 1, person: 'Ana',    text: 'Comprar leche y pan',      done: false, priority: 'alta'  },
    { id: 2, person: 'Ana',    text: 'Llamar al médico',         done: true,  priority: 'alta'  },
    { id: 3, person: 'Ana',    text: 'Pagar el seguro',          done: false, priority: 'media' },
    { id: 4, person: 'Carlos', text: 'Revisar el coche',         done: false, priority: 'media' },
    { id: 5, person: 'Carlos', text: 'Recoger a los niños',      done: false, priority: 'alta'  },
    { id: 6, person: 'Carlos', text: 'Arreglar la persiana',     done: true,  priority: 'baja'  },
    { id: 7, person: 'Sofía',  text: 'Estudiar matemáticas',     done: false, priority: 'alta'  },
    { id: 8, person: 'Sofía',  text: 'Ordenar habitación',       done: true,  priority: 'baja'  },
    { id: 9, person: 'Sofía',  text: 'Entregar trabajo escolar', done: false, priority: 'alta'  },
    { id:10, person: 'Casa',   text: 'Sacar la basura',          done: false, priority: 'alta'  },
    { id:11, person: 'Casa',   text: 'Limpiar cocina',           done: false, priority: 'media' },
    { id:12, person: 'Casa',   text: 'Pasar la aspiradora',      done: true,  priority: 'baja'  },
  ],

  objects: [
    { id: 1, name: 'Termostato',    icon: '🌡️',  value: '21°C',  type: 'climate',  active: true  },
    { id: 2, name: 'Alarma',        icon: '🔔',  value: 'Activa', type: 'security', active: true  },
    { id: 3, name: 'TV Salón',      icon: '📺',  value: 'Apagada',type: 'media',    active: false },
    { id: 4, name: 'Música',        icon: '🎵',  value: 'Spotify',type: 'media',    active: true  },
    { id: 5, name: 'Lavadora',      icon: '🫧',  value: '34 min', type: 'appliance',active: true  },
    { id: 6, name: 'Lavavajillas',  icon: '🍽️',  value: 'Listo',  type: 'appliance',active: false },
    { id: 7, name: 'Calefacción',   icon: '🔥',  value: 'Auto',   type: 'climate',  active: true  },
    { id: 8, name: 'Puerta',        icon: '🚪',  value: 'Cerrada',type: 'security', active: false },
  ],

  payments: [
    { id: 1, name: 'Netflix',      icon: '🎬', amount: 17.99,  due: '15 Mar', category: 'ocio',     paid: false },
    { id: 2, name: 'Luz',          icon: '⚡', amount: 84.50,  due: '20 Mar', category: 'hogar',    paid: false },
    { id: 3, name: 'Internet',     icon: '📡', amount: 49.99,  due: '01 Mar', category: 'hogar',    paid: true  },
    { id: 4, name: 'Spotify',      icon: '🎵', amount: 9.99,   due: '22 Mar', category: 'ocio',     paid: false },
    { id: 5, name: 'Hipoteca',     icon: '🏠', amount: 850.00, due: '05 Mar', category: 'vivienda', paid: true  },
    { id: 6, name: 'Seguro coche', icon: '🚗', amount: 63.00,  due: '28 Mar', category: 'seguro',   paid: false },
    { id: 7, name: 'Agua',         icon: '💧', amount: 32.10,  due: '18 Mar', category: 'hogar',    paid: false },
    { id: 8, name: 'Gym',          icon: '💪', amount: 29.99,  due: '01 Apr', category: 'salud',    paid: false },
  ],

  lightsCursor: 0,
  tasksCursor:  0,
  objectsCursor: 0,
  paymentsCursor: 0,
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

  socket.on('navigate', dir => {
    if (state.activeSection === null) {
      let { x, y } = state.cursor;
      if (dir === 'left')  x = Math.max(0, x - 1);
      if (dir === 'right') x = Math.min(GRID_W - 1, x + 1);
      if (dir === 'up')    y = Math.max(0, y - 1);
      if (dir === 'down')  y = Math.min(GRID_H - 1, y + 1);
      state.cursor = { x, y };
    } else {
      const key     = state.activeSection + 'Cursor';
      const listKey = state.activeSection;
      const len     = state[listKey].length;
      let cur       = state[key];
      if (dir === 'up')    cur = Math.max(0, cur - 1);
      if (dir === 'down')  cur = Math.min(len - 1, cur + 1);
      if (dir === 'left')  cur = Math.max(0, cur - 1);
      if (dir === 'right') cur = Math.min(len - 1, cur + 1);
      state[key] = cur;
    }
    io.emit('stateUpdate', state);
  });

  // ── VOZ: lógica por sección activa ─────────────────────────────────────────
  socket.on('voiceTask', async (text) => {
    if (!text || text.trim() === '') return;
    const t = text.trim().toLowerCase();
    const TOGGLE_OFF = /apag|desactiv|apaga|desactiva|apagar|desactivar/;
    const TOGGLE_ON  = /encend|activ|enciende|activa|encender|activar/;

    // ── SECCIÓN: TAREAS ──────────────────────────────────────────────────────
    if (state.activeSection === 'tasks') {
      if (/^(eliminar|borrar|quitar|borra|elimina)/.test(t)) {
        try {
          let tasks = await readTasks();
          if (tasks.length === 0) { socket.emit('taskError'); return; }
          const idx = Math.min(state.tasksCursor, tasks.length - 1);
          const removed = tasks.splice(idx, 1)[0];
          await writeTasks(tasks);
          state.tasksCursor = Math.max(0, idx - 1);
          io.emit('stateUpdate', state);
          socket.emit('taskDeleted', { text: removed.title });
          console.log('🗑️ Tarea eliminada por voz:', removed.title);
        } catch (err) { socket.emit('taskError'); }
        return;
      }
      const newTask = { id: Date.now().toString(), title: text, assignee: 'Móvil' };
      try {
        let tasks = await readTasks();
        tasks.push(newTask);
        await writeTasks(tasks);
        io.emit('taskAdded', { text });
        socket.emit('taskSaved', { text });
        console.log('🎤 Tarea guardada:', text);
      } catch (err) { socket.emit('taskError'); }
      return;
    }

    // ── SECCIÓN: PAGOS ───────────────────────────────────────────────────────
    if (state.activeSection === 'payments') {
      if (/^(pagado|pagar|marcar|ya pagu|cobrado)/.test(t)) {
        const p = state.payments[state.paymentsCursor];
        if (!p) { socket.emit('taskError'); return; }
        p.paid = true;
        io.emit('stateUpdate', state);
        socket.emit('paymentPaid', { name: p.name });
        console.log('💳 Pago marcado como pagado:', p.name);
        return;
      }
      // "netflix 20 euros" / "gym 30€" → añadir pago
      const match = t.match(/^(.+?)\s+([\d]+(?:[.,]\d+)?)\s*(?:euros?|€)?$/);
      if (match) {
        const rawName = match[1].trim();
        const name    = rawName.charAt(0).toUpperCase() + rawName.slice(1);
        const amount  = parseFloat(match[2].replace(',', '.'));
        const newPayment = { id: Date.now(), name, icon: '💳', amount, due: 'Sin fecha', category: 'otros', paid: false };
        state.payments.push(newPayment);
        io.emit('stateUpdate', state);
        socket.emit('paymentSaved', { name, amount });
        console.log('💳 Pago añadido por voz:', name, amount);
        return;
      }
      socket.emit('voiceUnknown', { text });
      return;
    }

    // ── SECCIÓN: LUCES ───────────────────────────────────────────────────────
    if (state.activeSection === 'lights') {
      const l = state.lights[state.lightsCursor];
      if (!l) { socket.emit('taskError'); return; }
      if (TOGGLE_OFF.test(t)) { l.on = false; }
      else if (TOGGLE_ON.test(t)) { l.on = true; }
      else { socket.emit('voiceUnknown', { text }); return; }
      io.emit('stateUpdate', state);
      socket.emit('lightToggled', { name: l.name, on: l.on });
      console.log('💡 Luz', l.name, l.on ? 'encendida' : 'apagada', 'por voz');
      return;
    }

    // ── SECCIÓN: OBJETOS ─────────────────────────────────────────────────────
    if (state.activeSection === 'objects') {
      const o = state.objects[state.objectsCursor];
      if (!o) { socket.emit('taskError'); return; }
      if (TOGGLE_OFF.test(t)) { o.active = false; }
      else if (TOGGLE_ON.test(t)) { o.active = true; }
      else { socket.emit('voiceUnknown', { text }); return; }
      io.emit('stateUpdate', state);
      socket.emit('objectToggled', { name: o.name, active: o.active });
      console.log('🏠 Objeto', o.name, o.active ? 'activado' : 'desactivado', 'por voz');
      return;
    }

    // ── Cualquier otra sección ───────────────────────────────────────────────
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
    state.activeSection = null;
    io.emit('stateUpdate', state);
  });

  socket.on('action', () => {
    if (state.activeSection === 'lights') {
      const l = state.lights[state.lightsCursor];
      if (l) l.on = !l.on;
    } else if (state.activeSection === 'tasks') {
      const t = state.tasks[state.tasksCursor];
      if (t) t.done = !t.done;
    } else if (state.activeSection === 'objects') {
      const o = state.objects[state.objectsCursor];
      if (o) o.active = !o.active;
    } else if (state.activeSection === 'payments') {
      const p = state.payments[state.paymentsCursor];
      if (p) p.paid = !p.paid;
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