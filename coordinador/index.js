require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// userId -> { username, socket, connectedAt }
const players = new Map(); //

function broadcastPlayers() {
  // Se mapean los jugadores omitiendo el objeto 'socket' completo
  const list = Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username
  }));

  // Se prepara el payload requerido por el cliente
  const msg = JSON.stringify({ type: 'players_update', players: list });

  // Broadcast a todos los usuarios conectados
  for (const { socket } of players.values()) {
    if (socket.readyState === socket.OPEN) {
      socket.send(msg);
    }
  }
}

// Validación centralizada en el upgrade
server.on('upgrade', (req, socket, head) => {
  const { query } = url.parse(req.url, true);
  const token = query.token; //[cite: 1]

  try {
    // Se verifica el JWT usando la clave de entorno[cite: 1]
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, payload);
    });
  } catch (err) {
    // Rechazar la conexión inmediatamente si el token falla[cite: 1]
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws, payload) => {
  const userId = payload.userId;

  // Manejo de pestañas duplicadas: Cierra la sesión anterior para priorizar la nueva conexión[cite: 1]
  if (players.has(userId)) {
    const oldPlayer = players.get(userId);
    oldPlayer.socket.close(4001, 'invalid token - connection replaced');
  }

  // Se agrega al jugador en memoria[cite: 1]
  players.set(userId, {
    username: payload.username,
    socket: ws,
    connectedAt: new Date().toISOString()
  });

  // Notificar a todos que alguien entró[cite: 1]
  broadcastPlayers();

  // Detección de desconexiones[cite: 1]
  ws.on('close', () => {
    // Verificar que el socket que se cerró es realmente el de este cliente
    const currentPlayer = players.get(userId);
    if (currentPlayer && currentPlayer.socket === ws) {
      players.delete(userId); // Se elimina al jugador del Map[cite: 1]
      broadcastPlayers(); // Se notifica a los demás que el jugador salió[cite: 1]
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Coordinador escuchando en el puerto ${PORT}`);
});