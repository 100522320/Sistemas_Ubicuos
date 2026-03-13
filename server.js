const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir archivos estáticos desde la carpeta 'public'
app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log('Nuevo dispositivo conectado:', socket.id);

    // Escuchar el evento de movimiento del mando y retransmitirlo a la pantalla
    socket.on('gesture', (command) => {
        console.log('Gesto recibido:', command);
        io.emit('updateScreen', command);
    });

    socket.on('disconnect', () => {
        console.log('Dispositivo desconectado:', socket.id);
    });
});

server.listen(3000, () => {
    console.log('Servidor corriendo en http://localhost:3000');
});