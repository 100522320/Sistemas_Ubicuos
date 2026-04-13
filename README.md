CHRISTIAN CANO -> 100522320
ADRIAN CURELL -> 100522128

# 🏠 Smart Home Remote Control

Sistema de control remoto domótico con giroscopio y comandos de voz.

## Arquitectura

```
📱 Móvil (mobile.html)
        ↕ WebSocket
🖥️  Servidor (server.js)
        ↕ WebSocket  
📺 Pantalla (screen.html)
```

## Instalación

```bash
npm install
npm start
```

El servidor se levanta en **http://localhost:3000**

## URLs

| Dispositivo | URL                              |
|-------------|----------------------------------|
| Pantalla TV | http://TU_IP:3000/screen.html   |
| Móvil       | http://TU_IP:3000/mobile.html   |

> Para conectar el móvil, usa la IP de tu ordenador en la red local (ej: 192.168.1.10) y en chrome://flags ir al apartado de 'Insecure origins treated as secure', poner 'http://TU_IP:3000' y pinchar en habilitar

> Hay que compartir datos desde tu telefono al ordenador/pantalla y luego mirar cual es su ip usando el comando ipconfig en la terminal

## Controles del Móvil

### Giroscopio
- **Inclinar izquierda/derecha** → Navegar izquierda/derecha
- **Inclinar adelante/atrás** → Navegar arriba/abajo
- **Inclinar hacia el techo el movil** → Salir de sección
- **Agitar el móvil** → ENTRAR en sección / ACCIÓN (encender/apagar/completar)

### Botones
- **▲▼◀▶** → Navegar
- **⚡ (centro)** → Acción
- **↩ Entrar** → Entrar en sección seleccionada
- **✕ Atrás** → Volver al menú principal

### Teclado (en la pantalla)
- **Flechas** → Navegar
- **Enter/Espacio** → Entrar / Acción
- **Escape/Backspace** → Volver

## Secciones

### 💡 Dispositivos
Muestra todos los dispositivos de la casa. Navega entre ellos y usa ACCIÓN para encender/apagar o subir/bajar.

### ✅ Tareas
Lista de tareas divididas por persona (Ana, Carlos, Sofía, Casa). Usa ACCIÓN para marcar como completada o no completada.

### 🏠 Objetos Perdidos
Objetos del hogar (zapatos, reloj, TV, papel higiénico...) con su localización actual.

### 💳 Pagos
Recibos y suscripciones del mes con su estado. Usa ACCIÓN para marcar como pagado o no pagado.
