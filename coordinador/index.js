require("dotenv").config();

const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");
const { WebSocketServer, WebSocket } = require("ws");
const { parse } = require("url");

function readRequiredEnv(name, options = {}) {
  const value = String(process.env[name] || "").trim();
  const minLength = Number.isInteger(options.minLength) ? options.minLength : 1;

  if (value.length < minLength) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readIntegerEnv(name, fallback) {
  const rawValue = String(process.env[name] || "").trim();

  if (!rawValue) {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

const PORT = readIntegerEnv("PORT", 5000);
const JWT_SECRET = readRequiredEnv("JWT_SECRET", { minLength: 32 });
const WORLD_WIDTH = readIntegerEnv("WORLD_WIDTH", 800);
const WORLD_HEIGHT = readIntegerEnv("WORLD_HEIGHT", 600);
const PLAYER_RADIUS = readIntegerEnv("PLAYER_RADIUS", 20);
const PLAYER_SPEED = readIntegerEnv("PLAYER_SPEED", 220);
const TICK_RATE = readIntegerEnv("TICK_RATE", 20);

const WORLD = Object.freeze({
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  playerRadius: PLAYER_RADIUS
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const players = new Map();

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hashString(value) {
  const text = String(value || "");
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function createSpawnPoint(userId) {
  const hash = hashString(userId);
  const horizontalSpan = Math.max(1, WORLD.width - (PLAYER_RADIUS * 2));
  const verticalSpan = Math.max(1, WORLD.height - (PLAYER_RADIUS * 2));

  return {
    x: PLAYER_RADIUS + (hash % horizontalSpan),
    y: PLAYER_RADIUS + (Math.floor(hash / 97) % verticalSpan)
  };
}

function normalizeDirection(rawDirection) {
  const x = Math.sign(Number(rawDirection?.x) || 0);
  const y = Math.sign(Number(rawDirection?.y) || 0);

  return { x, y };
}

function sanitizeMood(value) {
  const mood = String(value || "").trim();

  if (!mood) {
    return "";
  }

  return Array.from(mood).slice(0, 8).join("");
}

function serializePlayer(player) {
  return {
    userId: player.userId,
    username: player.username,
    provider: player.provider,
    x: player.x,
    y: player.y,
    extras: { ...player.extras }
  };
}

function buildStateMessage() {
  return JSON.stringify({
    type: "state",
    players: Array.from(players.values()).map(serializePlayer)
  });
}

function broadcastState() {
  const payload = buildStateMessage();

  for (const player of players.values()) {
    if (player.socket.readyState === WebSocket.OPEN) {
      player.socket.send(payload);
    }
  }
}

function sendWelcome(player) {
  if (player.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  player.socket.send(JSON.stringify({
    type: "welcome",
    you: {
      userId: player.userId,
      username: player.username,
      provider: player.provider
    },
    world: WORLD
  }));
}

function removePlayerIfCurrent(userId, socket) {
  const currentPlayer = players.get(userId);

  if (!currentPlayer || currentPlayer.socket !== socket) {
    return;
  }

  players.delete(userId);
  broadcastState();
}

function updatePlayerPosition(player, deltaMs) {
  const direction = player.intent;

  if (!direction || (!direction.x && !direction.y)) {
    return false;
  }

  const vectorLength = Math.hypot(direction.x, direction.y);
  if (!vectorLength) {
    return false;
  }

  const distance = PLAYER_SPEED * (deltaMs / 1000);
  const nextX = player.x + ((direction.x / vectorLength) * distance);
  const nextY = player.y + ((direction.y / vectorLength) * distance);

  const boundedX = clamp(nextX, PLAYER_RADIUS, WORLD.width - PLAYER_RADIUS);
  const boundedY = clamp(nextY, PLAYER_RADIUS, WORLD.height - PLAYER_RADIUS);

  if (boundedX === player.x && boundedY === player.y) {
    return false;
  }

  player.x = boundedX;
  player.y = boundedY;
  return true;
}

app.get("/", (_request, response) => {
  response.json({
    service: "coordinador",
    status: "ok",
    connectedPlayers: players.size,
    world: WORLD
  });
});

server.on("upgrade", (request, socket, head) => {
  const { pathname, query } = parse(request.url || "", true);

  if (pathname !== "/connect") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const token = String(query.token || "").trim();

  if (!token) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  let payload;

  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (webSocket) => {
    wss.emit("connection", webSocket, request, payload);
  });
});

wss.on("connection", (socket, _request, payload) => {
  const userId = String(payload.userId || "").trim();
  const username = String(payload.username || "").trim();
  const provider = String(payload.provider || "local").trim() || "local";

  if (!userId || !username) {
    socket.close(4000, "invalid token payload");
    return;
  }

  const existingPlayer = players.get(userId);
  if (existingPlayer) {
    existingPlayer.socket.close(4001, "connection replaced");
  }

  const spawn = createSpawnPoint(userId);
  const player = {
    userId,
    username,
    provider,
    x: spawn.x,
    y: spawn.y,
    extras: {},
    intent: { x: 0, y: 0 },
    socket
  };

  players.set(userId, player);
  sendWelcome(player);
  broadcastState();

  socket.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(String(rawMessage));
    } catch (error) {
      return;
    }

    const currentPlayer = players.get(userId);
    if (!currentPlayer || currentPlayer.socket !== socket) {
      return;
    }

    if (message.type === "intent" && message.intent?.type === "move") {
      currentPlayer.intent = normalizeDirection(message.intent.dir);
      return;
    }

    if (message.type === "extras_update") {
      currentPlayer.extras = {
        ...currentPlayer.extras,
        mood: sanitizeMood(message.extras?.mood)
      };
      broadcastState();
    }
  });

  socket.on("close", () => {
    removePlayerIfCurrent(userId, socket);
  });

  socket.on("error", () => {
    removePlayerIfCurrent(userId, socket);
  });
});

let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const deltaMs = now - lastTick;
  lastTick = now;

  let hasMovement = false;

  for (const player of players.values()) {
    if (updatePlayerPosition(player, deltaMs)) {
      hasMovement = true;
    }
  }

  if (hasMovement) {
    broadcastState();
  }
}, Math.max(16, Math.floor(1000 / TICK_RATE)));

server.listen(PORT, () => {
  console.log(`Coordinator listening on http://localhost:${PORT}`);
});
