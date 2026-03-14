const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── STATE ────────────────────────────────────────────────────────────────────

const state = {
  cursor: { x: 1, y: 0 },   // grid position on screen (0-based)
  activeSection: null,        // null = grid view, string = inside a section

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

// ── GRID CONFIG ──────────────────────────────────────────────────────────────
// sections layout:
//  [0,0]=Luces  [1,0]=Tareas
//  [0,1]=Objetos [1,1]=Pagos
const GRID_W = 2, GRID_H = 2;

// ── SOCKET LOGIC ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  // send full state to whoever just connected
  socket.emit('fullState', state);

  // mobile → server → screen
  socket.on('navigate', dir => {
    if (state.activeSection === null) {
      // move cursor on grid
      let { x, y } = state.cursor;
      if (dir === 'left')  x = Math.max(0, x - 1);
      if (dir === 'right') x = Math.min(GRID_W - 1, x + 1);
      if (dir === 'up')    y = Math.max(0, y - 1);
      if (dir === 'down')  y = Math.min(GRID_H - 1, y + 1);
      state.cursor = { x, y };
    } else {
      // navigate inside section list
      const key = state.activeSection + 'Cursor';
      const listKey = state.activeSection;
      const len = state[listKey].length;
      let cur = state[key];
      if (dir === 'up')    cur = Math.max(0, cur - 1);
      if (dir === 'down')  cur = Math.min(len - 1, cur + 1);
      if (dir === 'left')  cur = Math.max(0, cur - 1);
      if (dir === 'right') cur = Math.min(len - 1, cur + 1);
      state[key] = cur;
    }
    io.emit('stateUpdate', state);
  });

  socket.on('enter', () => {
    if (state.activeSection === null) {
      const sections = ['lights','tasks','objects','payments'];
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
    // toggle/complete current item
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
