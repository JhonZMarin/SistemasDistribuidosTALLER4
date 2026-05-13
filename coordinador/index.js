require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Constantes del mundo y físicas
const WORLD_WIDTH = 800;
const WORLD_HEIGHT = 600;
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 200; // px/seg
const TICK_RATE = 20;     // Hz
const TICK_MS = 1000 / TICK_RATE;

// userId -> { username, socket, connectedAt, x, y, intent, extras }
const players = new Map(); 

// Broadcast para notificar cuando alguien entra o sale de la sala
function broadcastPlayers() {
  const list = Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username
  }));

  const msg = JSON.stringify({ type: 'players_update', players: list });

  for (const { socket } of players.values()) {
    if (socket.readyState === socket.OPEN) {
      socket.send(msg);
    }
  }
}

// Validación centralizada en el upgrade
server.on('upgrade', (req, socket, head) => {
  const { query } = url.parse(req.url, true);
  const token = query.token;

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, payload);
    });
  } catch (err) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws, payload) => {
  const userId = payload.userId;
  const username = payload.username;

  // Manejo de pestañas duplicadas
  if (players.has(userId)) {
    const oldPlayer = players.get(userId);
    oldPlayer.socket.close(4001, 'invalid token - connection replaced');
  }

  // Inicialización del jugador (Posición random dentro del mundo)
  players.set(userId, {
    username: username,
    socket: ws,
    connectedAt: new Date().toISOString(),
    x: PLAYER_RADIUS + Math.random() * (WORLD_WIDTH - 2 * PLAYER_RADIUS),
    y: PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS),
    intent: { x: 0, y: 0 },
    extras: {}
  });

  // Mensaje Welcome para cliente
  ws.send(JSON.stringify({ 
    type: 'welcome', 
    you: { userId, username }, 
    world: { 
      width: WORLD_WIDTH, 
      height: WORLD_HEIGHT, 
      playerRadius: PLAYER_RADIUS, 
      tickRate: TICK_RATE 
    } 
  }));

  broadcastPlayers();

  // Recepción y validación de mensajes del cliente
  ws.on('message', (raw) => {
    let msg;
    try { 
      msg = JSON.parse(raw.toString()); 
    } catch (e) { 
      return; 
    }

    const p = players.get(userId);
    if (!p) return;

    // Manejo de intenciones de movimiento
    if (msg.type === 'intent') {
      const dir = msg.intent && msg.intent.dir;
      if (!dir || typeof dir.x !== 'number' || typeof dir.y !== 'number') return;
      
      // Evita trampas de teletransportación
      p.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y) };
      return;
    }

    // Manejo de variables extra 
    if (msg.type === 'extras_update') {
      if (!msg.extras || typeof msg.extras !== 'object' || Array.isArray(msg.extras)) return;
      // Límite anti-abuso de memoria
      if (JSON.stringify(msg.extras).length > 1024) return; 
      
      p.extras = msg.extras;
      return;
    }
  });

  // Detección de desconexiones
  ws.on('close', () => {
    const currentPlayer = players.get(userId);
    if (currentPlayer && currentPlayer.socket === ws) {
      players.delete(userId);
      broadcastPlayers();
    }
  });
});

// ==========================================
// GAME LOOP AUTORITATIVO
// ==========================================

let lastTick = Date.now();

// Genera un snapshot limpio 
function getSnapshot() {
  return Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
    x: p.x,
    y: p.y,
    extras: p.extras
  }));
}

function tick() {
  const now = Date.now();
  const dt = (now - lastTick) / 1000; // Delta time en segundos
  lastTick = now;

  for (const p of players.values()) {
    // Normalizar diagonales para evitar el incremento del 41% en la velocidad
    const ix = p.intent.x;
    const iy = p.intent.y;
    const mag = Math.hypot(ix, iy);
    
    if (mag > 0) {
      p.x += (ix / mag) * PLAYER_SPEED * dt;
      p.y += (iy / mag) * PLAYER_SPEED * dt;
    }

    // Mantener al jugador dentro de los límites del mundo
    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
  }

  // Empaquetar y hacer broadcast del estado del juego
  const stateMsg = JSON.stringify({ type: 'state', t: now, players: getSnapshot() });
  
  for (const { socket } of players.values()) {
    if (socket.readyState === socket.OPEN) {
      socket.send(stateMsg);
    }
  }
}

// Iniciar el Game Loop
setInterval(tick, TICK_MS);

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Coordinador escuchando en el puerto ${PORT} a ${TICK_RATE} ticks por segundo`);
});