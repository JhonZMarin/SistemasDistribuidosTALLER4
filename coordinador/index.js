require("dotenv").config();

const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");
const { WebSocketServer, WebSocket } = require("ws");
const { parse } = require("url");

function readOptionalEnv(name) {
  return String(process.env[name] || "").trim();
}

function readRequiredEnv(name, options = {}) {
  const value = readOptionalEnv(name);
  const minLength = Number.isInteger(options.minLength) ? options.minLength : 1;

  if (value.length < minLength) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readIntegerEnv(name, fallback) {
  const rawValue = readOptionalEnv(name);

  if (!rawValue) {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function normalizeHttpBaseUrl(url) {
  const normalized = normalizeBaseUrl(url);

  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error(`Invalid HTTP URL: ${url}`);
  }

  return normalized;
}

function normalizeWebSocketBaseUrl(url) {
  const normalized = normalizeBaseUrl(url);

  if (!/^wss?:\/\//i.test(normalized)) {
    throw new Error(`Invalid WebSocket URL: ${url}`);
  }

  return normalized;
}

function buildPeerWebSocketUrl(publicWsUrl) {
  return `${normalizeWebSocketBaseUrl(publicWsUrl)}/peer`;
}

function toHttpBaseUrl(url) {
  const normalized = normalizeBaseUrl(url);

  if (normalized.startsWith("ws://")) {
    return `http://${normalized.slice(5)}`;
  }

  if (normalized.startsWith("wss://")) {
    return `https://${normalized.slice(6)}`;
  }

  return normalized;
}

const PUBLIC_PORT = readIntegerEnv("PORT", 5000);
const PEER_PORT = readIntegerEnv("PEER_PORT", PUBLIC_PORT + 1000);
const JWT_SECRET = readRequiredEnv("JWT_SECRET", { minLength: 32 });
const COORDINATOR_ID = readOptionalEnv("COORDINATOR_ID") || `coord-${PUBLIC_PORT}`;
const AUTH_SERVICE_URL = normalizeHttpBaseUrl(
  readOptionalEnv("AUTH_SERVICE_URL") || "http://localhost:4000"
);
const PUBLIC_WS_URL = normalizeWebSocketBaseUrl(
  readOptionalEnv("PUBLIC_WS_URL") || `ws://localhost:${PUBLIC_PORT}`
);
const PEER_WS_URL = normalizeWebSocketBaseUrl(
  readOptionalEnv("PEER_WS_URL") || buildPeerWebSocketUrl(PUBLIC_WS_URL)
);
const WORLD_WIDTH = readIntegerEnv("WORLD_WIDTH", 800);
const WORLD_HEIGHT = readIntegerEnv("WORLD_HEIGHT", 600);
const PLAYER_RADIUS = readIntegerEnv("PLAYER_RADIUS", 20);
const PLAYER_SPEED = readIntegerEnv("PLAYER_SPEED", 220);
const TICK_RATE = readIntegerEnv("TICK_RATE", 20);
const HEARTBEAT_INTERVAL_MS = readIntegerEnv("HEARTBEAT_INTERVAL_MS", 2000);
const PEER_DISCOVERY_INTERVAL_MS = readIntegerEnv("PEER_DISCOVERY_INTERVAL_MS", 2000);
const PEER_SNAPSHOT_INTERVAL_MS = readIntegerEnv("PEER_SNAPSHOT_INTERVAL_MS", 2000);
const KILL_DISTANCE = 80;

const WORLD = Object.freeze({
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  playerRadius: PLAYER_RADIUS,
  walls: [
    { x: 100, y: 150, w: 250, h: 40 },
    { x: 450, y: 150, w: 250, h: 40 },
    { x: 100, y: 400, w: 250, h: 40 },
    { x: 450, y: 400, w: 250, h: 40 },
    { x: 380, y: 190, w: 40, h: 210 }
  ],
  vents: [
    { id: 'vent1', x: 60, y: 60 },
    { id: 'vent2', x: 740, y: 60 },
    { id: 'vent3', x: 60, y: 540 },
    { id: 'vent4', x: 740, y: 540 }
  ],
  vitals: { x: 380, y: 250, w: 80, h: 40 },
  tasks: [
    { id: 'task1', x: 150, y: 100, w: 40, h: 40 },
    { id: 'task2', x: 600, y: 100, w: 40, h: 40 },
    { id: 'task3', x: 150, y: 450, w: 40, h: 40 },
    { id: 'task4', x: 600, y: 450, w: 40, h: 40 }
  ],
  emergencyButton: { x: 380, y: 150, w: 40, h: 40 }
});

const publicApp = express();
const publicServer = http.createServer(publicApp);
const publicWss = new WebSocketServer({ noServer: true });

const peerApp = express();
const peerServer = http.createServer(peerApp);
const peerWss = new WebSocketServer({ noServer: true });

const players = new Map();
const localSockets = new Map();
const peerDirectory = new Map();
const peerConnections = new Map();
const pendingOutboundPeerIds = new Set();

let globalGameState = {
  status: "lobby", // 'lobby' | 'playing' | 'meeting'
  impostorId: null,
  globalTasksCompleted: 0,
  meeting: null // { caller: userId, votes: { [voterId]: targetId }, endsAt: timestamp }
};

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
  // Zona segura: Cafetería (arriba, x: 300 a 500, y: 50 a 120)
  return {
    x: 300 + (hash % 200),
    y: 50 + (Math.floor(hash / 97) % 70)
  };
}

function normalizeDirection(rawDirection) {
  const x = Math.sign(Number(rawDirection?.x) || 0);
  const y = Math.sign(Number(rawDirection?.y) || 0);

  return { x, y };
}

function sanitizeExtraValue(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const text = String(value || "").trim();
  return text ? Array.from(text).slice(0, 32).join("") : "";
}

function sanitizeExtras(extras, baseExtras = {}) {
  const safeExtras = { ...baseExtras };

  if (!extras || typeof extras !== "object" || Array.isArray(extras)) {
    return safeExtras;
  }

  for (const [key, value] of Object.entries(extras)) {
    const cleanKey = String(key || "").trim();

    if (!/^[A-Za-z0-9_-]{1,32}$/.test(cleanKey)) {
      continue;
    }

    const cleanValue = sanitizeExtraValue(value);

    if (cleanValue === "") {
      delete safeExtras[cleanKey];
      continue;
    }

    safeExtras[cleanKey] = cleanValue;
  }

  return safeExtras;
}

function getLocalPlayerCount() {
  return localSockets.size;
}

function areDirectionsEqual(left, right) {
  return left?.x === right?.x && left?.y === right?.y;
}

function areExtrasEqual(left, right) {
  const leftEntries = Object.entries(left || {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right || {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([leftKey, leftValue], index) => {
    const [rightKey, rightValue] = rightEntries[index];
    return leftKey === rightKey && leftValue === rightValue;
  });
}

function serializePlayer(player) {
  return {
    userId: player.userId,
    username: player.username,
    provider: player.provider,
    x: player.x,
    y: player.y,
    extras: { ...player.extras },
    coordinatorId: player.ownerCoordinatorId
  };
}

function serializePlayerForPeer(player) {
  return {
    userId: player.userId,
    username: player.username,
    provider: player.provider,
    x: player.x,
    y: player.y,
    extras: { ...player.extras },
    intent: {
      dir: { ...player.intent }
    }
  };
}

function buildStatePayload() {
  return JSON.stringify({
    type: "state",
    players: Array.from(players.values()).map(serializePlayer),
    gameState: globalGameState
  });
}

function broadcastState() {
  const payload = buildStatePayload();

  for (const [userId, socket] of localSockets.entries()) {
    if (socket.readyState !== WebSocket.OPEN) {
      localSockets.delete(userId);
      continue;
    }

    socket.send(payload);
  }
}

function broadcastToPeers(message) {
  const payload = JSON.stringify(message);

  for (const peerConnection of peerConnections.values()) {
    if (peerConnection.socket.readyState === WebSocket.OPEN) {
      peerConnection.socket.send(payload);
    }
  }
}

function sendWelcome(player) {
  if (!player.localSocket || player.localSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  player.localSocket.send(JSON.stringify({
    type: "welcome",
    coordinatorId: COORDINATOR_ID,
    you: {
      userId: player.userId,
      username: player.username,
      provider: player.provider
    },
    world: WORLD
  }));
}

function buildPlayerJoinedMessage(player) {
  return {
    type: "player_joined",
    origin: COORDINATOR_ID,
    ...serializePlayerForPeer(player)
  };
}

function buildPlayersSnapshotMessage() {
  return {
    type: "players_snapshot",
    origin: COORDINATOR_ID,
    players: Array.from(players.values())
      .filter((player) => player.ownerCoordinatorId === COORDINATOR_ID)
      .map(serializePlayerForPeer)
  };
}

function removePlayersOwnedBy(ownerCoordinatorId) {
  let changed = false;

  for (const [userId, player] of players.entries()) {
    if (player.ownerCoordinatorId === ownerCoordinatorId) {
      if (player.localSocket) {
        localSockets.delete(userId);
      }
      players.delete(userId);
      changed = true;
    }
  }

  if (changed) {
    broadcastState();
  }
}

function removeLocalPlayerIfCurrent(userId, socket) {
  const currentSocket = localSockets.get(userId);
  const currentPlayer = players.get(userId);

  if (currentSocket !== socket || !currentPlayer || currentPlayer.localSocket !== socket) {
    return;
  }

  localSockets.delete(userId);
  players.delete(userId);

  broadcastToPeers({
    type: "player_left",
    origin: COORDINATOR_ID,
    userId
  });

  broadcastState();
}

function upsertRemotePlayer(message) {
  const userId = String(message.userId || "").trim();
  const username = String(message.username || "").trim();
  const ownerCoordinatorId = String(message.origin || "").trim();

  if (!userId || !username || !ownerCoordinatorId || ownerCoordinatorId === COORDINATOR_ID) {
    return false;
  }

  const existing = players.get(userId);
  const nextPlayer = {
    userId,
    username,
    provider: String(message.provider || existing?.provider || "local").trim() || "local",
    x: Number.isFinite(Number(message.x)) ? Number(message.x) : existing?.x ?? createSpawnPoint(userId).x,
    y: Number.isFinite(Number(message.y)) ? Number(message.y) : existing?.y ?? createSpawnPoint(userId).y,
    extras: sanitizeExtras(message.extras, existing?.extras || {}),
    intent: normalizeDirection(message.intent?.dir || existing?.intent),
    ownerCoordinatorId,
    localSocket: null
  };

  if (
    existing
    && existing.userId === nextPlayer.userId
    && existing.username === nextPlayer.username
    && existing.provider === nextPlayer.provider
    && existing.x === nextPlayer.x
    && existing.y === nextPlayer.y
    && existing.ownerCoordinatorId === nextPlayer.ownerCoordinatorId
    && areDirectionsEqual(existing.intent, nextPlayer.intent)
    && areExtrasEqual(existing.extras, nextPlayer.extras)
  ) {
    return false;
  }

  players.set(userId, nextPlayer);
  return true;
}

function applyRemoteIntent(message) {
  const userId = String(message.userId || "").trim();
  const player = players.get(userId);

  if (!player) {
    return false;
  }

  const nextIntent = normalizeDirection(message.intent?.dir);

  if (areDirectionsEqual(player.intent, nextIntent)) {
    return false;
  }

  player.intent = nextIntent;
  return true;
}

function applyRemoteExtras(message) {
  const userId = String(message.userId || "").trim();
  const player = players.get(userId);

  if (!player) {
    return false;
  }

  const nextExtras = sanitizeExtras(message.extras, player.extras);

  if (areExtrasEqual(player.extras, nextExtras)) {
    return false;
  }

  player.extras = nextExtras;

  return true;
}

function applyRemotePlayersSnapshot(message) {
  const ownerCoordinatorId = String(message.origin || "").trim();

  if (!ownerCoordinatorId || ownerCoordinatorId === COORDINATOR_ID) {
    return false;
  }

  const remotePlayers = Array.isArray(message.players) ? message.players : [];
  const visibleUserIds = new Set();
  let changed = false;

  for (const remotePlayer of remotePlayers) {
    const userId = String(remotePlayer?.userId || "").trim();

    if (!userId) {
      continue;
    }

    visibleUserIds.add(userId);

    if (upsertRemotePlayer({
      ...remotePlayer,
      origin: ownerCoordinatorId
    })) {
      changed = true;
    }
  }

  for (const [userId, player] of players.entries()) {
    if (player.ownerCoordinatorId !== ownerCoordinatorId) {
      continue;
    }

    if (visibleUserIds.has(userId)) {
      continue;
    }

    players.delete(userId);
    changed = true;
  }

  return changed;
}

function checkWallCollision(cx, cy, radius) {
  for (const wall of WORLD.walls) {
    const testX = clamp(cx, wall.x, wall.x + wall.w);
    const testY = clamp(cy, wall.y, wall.y + wall.h);
    const distX = cx - testX;
    const distY = cy - testY;
    if ((distX * distX) + (distY * distY) < radius * radius) {
      return true;
    }
  }
  return false;
}

function updatePlayerPosition(player, deltaMs) {
  // Solo se puede mover si está en playing
  if (player.extras?.isGhost || player.extras?.inVent || globalGameState.status !== "playing") {
    // Ghosts might be able to move through walls, or we restrict them. 
    // In Taller 4, ghosts are usually silenced but can move freely. Let's allow them to move.
    if (!player.extras?.isGhost && (player.extras?.inVent || globalGameState.status !== "playing")) {
       return false;
    }
    // Si hay reunión, ni los fantasmas se mueven
    if (globalGameState.status === "meeting") {
       return false;
    }
  }

  const direction = player.intent;

  if (!direction || (!direction.x && !direction.y)) {
    return false;
  }

  const vectorLength = Math.hypot(direction.x, direction.y);
  if (!vectorLength) {
    return false;
  }

  const distance = PLAYER_SPEED * (deltaMs / 1000);
  let nextX = player.x + ((direction.x / vectorLength) * distance);
  let nextY = player.y + ((direction.y / vectorLength) * distance);

  nextX = clamp(nextX, PLAYER_RADIUS, WORLD.width - PLAYER_RADIUS);
  nextY = clamp(nextY, PLAYER_RADIUS, WORLD.height - PLAYER_RADIUS);

  // If not a ghost, check collisions
  if (!player.extras?.isGhost) {
    if (checkWallCollision(nextX, player.y, PLAYER_RADIUS)) {
      nextX = player.x;
    }
    if (checkWallCollision(player.x, nextY, PLAYER_RADIUS)) {
      nextY = player.y;
    }
    if (checkWallCollision(nextX, nextY, PLAYER_RADIUS)) {
      nextX = player.x;
      nextY = player.y;
    }
  }

  if (nextX === player.x && nextY === player.y) {
    return false;
  }

  player.x = nextX;
  player.y = nextY;
  return true;
}

function syncLocalPlayersToPeer(socket) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(buildPlayersSnapshotMessage()));
}

function broadcastSnapshotToPeers() {
  if (!peerConnections.size) {
    return;
  }

  broadcastToPeers(buildPlayersSnapshotMessage());
}

function listVisiblePeers() {
  return Array.from(peerDirectory.values())
    .map((peer) => {
      const peerConnection = peerConnections.get(peer.coordinatorId);

      return {
        coordinatorId: peer.coordinatorId,
        publicUrl: peer.publicUrl,
        directoryUrl: `${toHttpBaseUrl(peer.publicUrl)}/peers`,
        peerUrl: peer.peerUrl,
        connectedPlayers: peer.connectedPlayers,
        connected: Boolean(peerConnection),
        connectedAt: peerConnection?.connectedAt || null
      };
    })
    .sort((left, right) => left.coordinatorId.localeCompare(right.coordinatorId));
}

function registerPeerConnection(socket, peerId, direction) {
  const preferredDirection = COORDINATOR_ID.localeCompare(peerId) < 0 ? "outbound" : "inbound";
  const existing = peerConnections.get(peerId);

  if (existing && existing.socket !== socket) {
    if (existing.direction === preferredDirection) {
      socket.close(4003, "duplicate peer connection");
      return false;
    }

    existing.socket.close(4003, "peer connection replaced");
    peerConnections.delete(peerId);
  }

  peerConnections.set(peerId, {
    coordinatorId: peerId,
    peerUrl: socket._mesh.peerUrl || peerDirectory.get(peerId)?.peerUrl || "",
    direction,
    socket,
    connectedAt: Date.now()
  });

  socket._mesh.peerId = peerId;
  socket._mesh.established = true;
  pendingOutboundPeerIds.delete(peerId);
  syncLocalPlayersToPeer(socket);
  return true;
}

function cleanupPeerSocket(socket) {
  const peerId = socket._mesh?.peerId;

  if (socket._mesh?.expectedPeerId) {
    pendingOutboundPeerIds.delete(socket._mesh.expectedPeerId);
  }

  if (!peerId) {
    return;
  }

  const current = peerConnections.get(peerId);
  if (current && current.socket === socket) {
    peerConnections.delete(peerId);
    removePlayersOwnedBy(peerId);
  }
}

function sendPeerHello(socket) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: "hello",
    coordinatorId: COORDINATOR_ID
  }));
}

function handlePeerHello(socket, message) {
  const peerId = String(message?.coordinatorId || "").trim();

  if (!peerId || peerId === COORDINATOR_ID) {
    socket.close(4002, "invalid peer id");
    return;
  }

  const direction = socket._mesh.direction;

  if (socket._mesh.expectedPeerId && socket._mesh.expectedPeerId !== peerId) {
    socket.close(4002, "unexpected peer id");
    return;
  }

  if (direction === "inbound" && COORDINATOR_ID.localeCompare(peerId) < 0) {
    socket.close(4002, "outbound connection required");
    return;
  }

  if (direction === "outbound" && COORDINATOR_ID.localeCompare(peerId) >= 0) {
    socket.close(4002, "inbound connection required");
    return;
  }

  if (!registerPeerConnection(socket, peerId, direction)) {
    return;
  }
}

function handlePeerReplicationMessage(socket, message) {
  if (!socket._mesh.established) {
    return;
  }

  if (String(message.origin || "").trim() === COORDINATOR_ID) {
    return;
  }

  switch (message.type) {
    case "player_joined":
      if (upsertRemotePlayer(message)) {
        broadcastState();
      }
      break;
    case "player_left":
      if (players.get(String(message.userId || "").trim())?.ownerCoordinatorId === String(message.origin || "").trim()) {
        players.delete(String(message.userId || "").trim());
        broadcastState();
      }
      break;
    case "intent_replicate":
      applyRemoteIntent(message);
      break;
    case "extras_replicate":
      if (applyRemoteExtras(message)) {
        broadcastState();
      }
      break;
    case "players_snapshot":
      if (applyRemotePlayersSnapshot(message)) {
        broadcastState();
      }
      break;
    case "global_state_replicate":
      if (message.state) {
        globalGameState = message.state;
        broadcastState();
      }
      break;
    case "eject_replicate":
      const ejectedPlayer = players.get(message.targetId);
      if (ejectedPlayer && ejectedPlayer.ownerCoordinatorId === COORDINATOR_ID) {
        ejectedPlayer.extras = { ...ejectedPlayer.extras, isGhost: true };
        broadcastToPeers({
          type: "extras_replicate",
          origin: COORDINATOR_ID,
          userId: message.targetId,
          extras: { ...ejectedPlayer.extras }
        });
        broadcastState();
      }
      break;
    case "kill_replicate":
      const victim = players.get(message.targetId);
      if (victim && victim.ownerCoordinatorId === COORDINATOR_ID) {
        victim.extras = { ...victim.extras, isGhost: true };
        broadcastToPeers({
          type: "extras_replicate",
          origin: COORDINATOR_ID,
          userId: message.targetId,
          extras: { ...victim.extras }
        });
        broadcastState();
      }
      break;
    case "chat_replicate":
      const payloadStr = JSON.stringify(message);
      for (const socket of localSockets.values()) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payloadStr);
        }
      }
      break;
    default:
      break;
  }
}

function attachPeerSocket(socket, direction, expectedPeerId = "") {
  socket._mesh = {
    direction,
    expectedPeerId,
    peerId: "",
    peerUrl: expectedPeerId ? (peerDirectory.get(expectedPeerId)?.peerUrl || "") : "",
    established: false
  };

  socket.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(String(rawMessage));
    } catch (error) {
      return;
    }

    if (message.type === "hello") {
      handlePeerHello(socket, message);
      return;
    }

    handlePeerReplicationMessage(socket, message);
  });

  socket.on("close", () => {
    cleanupPeerSocket(socket);
  });

  socket.on("error", () => {
    cleanupPeerSocket(socket);
  });
}

function connectToPeer(peer) {
  if (!peer?.coordinatorId || pendingOutboundPeerIds.has(peer.coordinatorId) || peerConnections.has(peer.coordinatorId)) {
    return;
  }

  if (COORDINATOR_ID.localeCompare(peer.coordinatorId) >= 0) {
    return;
  }

  pendingOutboundPeerIds.add(peer.coordinatorId);

  const socket = new WebSocket(peer.peerUrl);
  attachPeerSocket(socket, "outbound", peer.coordinatorId);

  socket.on("open", () => {
    socket._mesh.peerUrl = peer.peerUrl;
    sendPeerHello(socket);
  });
}

async function sendHeartbeat() {
  const payload = {
    coordinatorId: COORDINATOR_ID,
    publicUrl: PUBLIC_WS_URL,
    peerUrl: PEER_WS_URL,
    connectedPlayers: getLocalPlayerCount(),
    uptime: Math.floor(process.uptime())
  };

  try {
    await fetch(`${AUTH_SERVICE_URL}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error("heartbeat failed:", error.message);
  }
}

async function refreshPeerDirectory() {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/peers`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const peers = Array.isArray(data?.peers) ? data.peers : [];
    const visiblePeerIds = new Set();

    for (const peer of peers) {
      const peerId = String(peer?.coordinatorId || "").trim();
      const publicUrl = normalizeBaseUrl(peer?.publicUrl);
      const peerUrl = normalizeBaseUrl(peer?.peerUrl);

      if (!peerId || peerId === COORDINATOR_ID || !/^wss?:\/\//i.test(peerUrl)) {
        continue;
      }

      visiblePeerIds.add(peerId);
      peerDirectory.set(peerId, {
        coordinatorId: peerId,
        publicUrl,
        peerUrl,
        connectedPlayers: Number.isFinite(Number(peer?.connectedPlayers))
          ? Math.max(0, Math.trunc(Number(peer.connectedPlayers)))
          : 0
      });

      connectToPeer({ coordinatorId: peerId, peerUrl });
    }

    for (const peerId of Array.from(peerDirectory.keys())) {
      if (visiblePeerIds.has(peerId)) {
        continue;
      }

      peerDirectory.delete(peerId);

      const peerConnection = peerConnections.get(peerId);
      if (peerConnection) {
        peerConnection.socket.close(4004, "peer removed from directory");
      }
    }
  } catch (error) {
    console.error("peer discovery failed:", error.message);
  }
}

publicApp.get("/", (_request, response) => {
  response.json({
    service: "coordinador",
    coordinatorId: COORDINATOR_ID,
    status: "ok",
    connectedPlayers: getLocalPlayerCount(),
    replicatedPlayers: players.size,
    peerConnections: Array.from(peerConnections.keys()),
    peerUrl: PEER_WS_URL,
    routes: ["/", "/connect", "/peer", "/peers"],
    world: WORLD
  });
});

publicApp.get("/peers", (_request, response) => {
  response.json({
    service: "coordinador",
    coordinatorId: COORDINATOR_ID,
    peers: listVisiblePeers()
  });
});

peerApp.get("/", (_request, response) => {
  response.json({
    service: "coordinador-peer",
    coordinatorId: COORDINATOR_ID,
    status: "ok",
    peers: Array.from(peerConnections.keys())
  });
});

publicServer.on("upgrade", (request, socket, head) => {
  const { pathname, query } = parse(request.url || "", true);

  if (pathname === "/peer") {
    peerWss.handleUpgrade(request, socket, head, (webSocket) => {
      peerWss.emit("connection", webSocket, request);
    });
    return;
  }

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

  publicWss.handleUpgrade(request, socket, head, (webSocket) => {
    publicWss.emit("connection", webSocket, request, payload);
  });
});

peerServer.on("upgrade", (request, socket, head) => {
  peerWss.handleUpgrade(request, socket, head, (webSocket) => {
    peerWss.emit("connection", webSocket, request);
  });
});

publicWss.on("connection", (socket, _request, payload) => {
  const userId = String(payload.userId || "").trim();
  const username = String(payload.username || "").trim();
  const provider = String(payload.provider || "local").trim() || "local";

  if (!userId || !username) {
    socket.close(4000, "invalid token payload");
    return;
  }

  const previousSocket = localSockets.get(userId);
  if (previousSocket) {
    previousSocket.close(4001, "connection replaced");
  }

  const existing = players.get(userId);
  const spawn = existing ? { x: existing.x, y: existing.y } : createSpawnPoint(userId);
  const player = {
    userId,
    username,
    provider,
    x: spawn.x,
    y: spawn.y,
    extras: { ...(existing?.extras || {}) },
    intent: normalizeDirection(existing?.intent),
    ownerCoordinatorId: COORDINATOR_ID,
    localSocket: socket
  };

  players.set(userId, player);
  localSockets.set(userId, socket);

  sendWelcome(player);
  broadcastToPeers(buildPlayerJoinedMessage(player));
  broadcastState();

  socket.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(String(rawMessage));
    } catch (error) {
      return;
    }

    const currentPlayer = players.get(userId);
    if (!currentPlayer || currentPlayer.localSocket !== socket) {
      return;
    }

    if (message.type === "intent") {
      if (message.intent?.type === "move") {
        currentPlayer.intent = normalizeDirection(message.intent.dir);
        broadcastToPeers({
          type: "intent_replicate",
          origin: COORDINATOR_ID,
          userId,
          intent: {
            dir: { ...currentPlayer.intent }
          }
        });
        return;
      }

      if (message.intent?.type === "start_game" && globalGameState.status === "lobby") {
        const allIds = Array.from(players.keys());
        if (allIds.length > 0) {
          globalGameState.status = "playing";
          globalGameState.impostorId = allIds[Math.floor(Math.random() * allIds.length)];
          globalGameState.globalTasksCompleted = 0;

          // Reset everyone to cafeteria / middle
          for (const p of players.values()) {
             const hash = hashString(p.userId);
             p.x = 300 + (hash % 200);
             p.y = 50 + (Math.floor(hash / 97) % 70);
             p.extras = { ...p.extras, isGhost: false, inVent: false };
             if (p.ownerCoordinatorId === COORDINATOR_ID) {
                broadcastToPeers({
                  type: "extras_replicate",
                  origin: COORDINATOR_ID,
                  userId: p.userId,
                  extras: { ...p.extras }
                });
             }
          }

          broadcastToPeers({
            type: "global_state_replicate",
            origin: COORDINATOR_ID,
            state: globalGameState
          });
          broadcastState();
        }
        return;
      }

      if (message.intent?.type === "kill" && globalGameState.status === "playing" && globalGameState.impostorId === userId && !currentPlayer.extras?.isGhost) {
        // Find nearest crewmate
        let nearest = null;
        let minDist = KILL_DISTANCE;
        for (const target of players.values()) {
          if (target.userId !== userId && !target.extras?.isGhost) {
            const dist = Math.hypot(target.x - currentPlayer.x, target.y - currentPlayer.y);
            if (dist <= minDist) {
              minDist = dist;
              nearest = target;
            }
          }
        }

        if (nearest) {
          if (nearest.ownerCoordinatorId === COORDINATOR_ID) {
            nearest.extras = { ...nearest.extras, isGhost: true };
            broadcastToPeers({
              type: "extras_replicate",
              origin: COORDINATOR_ID,
              userId: nearest.userId,
              extras: { ...nearest.extras }
            });
          } else {
            broadcastToPeers({
              type: "kill_replicate",
              origin: COORDINATOR_ID,
              targetId: nearest.userId
            });
          }
          currentPlayer.x = nearest.x; // teleport to victim
          currentPlayer.y = nearest.y;
          broadcastState();
        }
        return;
      }

      if (message.intent?.type === "vent" && globalGameState.status === "playing" && globalGameState.impostorId === userId && !currentPlayer.extras?.isGhost) {
        if (currentPlayer.extras?.inVent) {
          currentPlayer.extras.inVent = false;
        } else {
          // Check if near vent
          for (const vent of WORLD.vents) {
            const dist = Math.hypot(vent.x - currentPlayer.x, vent.y - currentPlayer.y);
            if (dist <= 40) {
              currentPlayer.extras.inVent = true;
              break;
            }
          }
        }
        broadcastToPeers({
          type: "extras_replicate",
          origin: COORDINATOR_ID,
          userId,
          extras: { ...currentPlayer.extras }
        });
        broadcastState();
        return;
      }

      if (message.intent?.type === "do_task" && globalGameState.status === "playing" && globalGameState.impostorId !== userId && !currentPlayer.extras?.isGhost) {
        const isNearTask = WORLD.tasks.some(task => {
          const cx = task.x + task.w/2;
          const cy = task.y + task.h/2;
          return Math.hypot(cx - currentPlayer.x, cy - currentPlayer.y) <= 60;
        });

        if (isNearTask) {
          globalGameState.globalTasksCompleted = (globalGameState.globalTasksCompleted || 0) + 1;
          broadcastToPeers({
            type: "global_state_replicate",
            origin: COORDINATOR_ID,
            state: globalGameState
          });
          broadcastState();
        }
        return;
      }

      if (message.intent?.type === "call_meeting" && globalGameState.status === "playing" && !currentPlayer.extras?.isGhost) {
        const btn = WORLD.emergencyButton;
        const isNearButton = Math.hypot((btn.x + btn.w/2) - currentPlayer.x, (btn.y + btn.h/2) - currentPlayer.y) <= 60;
        
        if (isNearButton) {
          globalGameState.status = "meeting";
          globalGameState.meeting = {
            caller: userId,
            votes: {},
            endsAt: Date.now() + 30000 // 30 seconds max
          };
          
          // Reset everyone to cafeteria / middle
          for (const p of players.values()) {
             const hash = hashString(p.userId);
             p.x = 300 + (hash % 200);
             p.y = 50 + (Math.floor(hash / 97) % 70);
             if (p.extras?.inVent) {
               p.extras.inVent = false;
               if (p.ownerCoordinatorId === COORDINATOR_ID) {
                 broadcastToPeers({
                   type: "extras_replicate",
                   origin: COORDINATOR_ID,
                   userId: p.userId,
                   extras: { ...p.extras }
                 });
               }
             }
          }

          broadcastToPeers({
            type: "global_state_replicate",
            origin: COORDINATOR_ID,
            state: globalGameState
          });
          broadcastState();
        }
        return;
      }

      if (message.intent?.type === "vote" && globalGameState.status === "meeting" && !currentPlayer.extras?.isGhost) {
        const targetId = message.intent.targetId || "skip";
        
        if (!globalGameState.meeting.votes[userId]) {
          globalGameState.meeting.votes[userId] = targetId;
          
          // Check if all alive players voted
          const alivePlayersCount = Array.from(players.values()).filter(p => !p.extras?.isGhost).length;
          const votesCount = Object.keys(globalGameState.meeting.votes).length;

          if (votesCount >= alivePlayersCount) {
             endMeeting();
          } else {
             broadcastToPeers({
               type: "global_state_replicate",
               origin: COORDINATOR_ID,
               state: globalGameState
             });
             broadcastState();
          }
        }
        return;
      }

      if (message.intent?.type === "chat" && globalGameState.status === "meeting" && !currentPlayer.extras?.isGhost) {
        const text = String(message.intent.text || "").trim().slice(0, 100);
        if (!text) return;

        const now = Date.now();
        const lastChat = currentPlayer.extras?.lastChatTime || 0;
        if (now - lastChat < 2000) {
           return; // Rate limited
        }

        currentPlayer.extras.lastChatTime = now;

        const chatMessage = {
          type: "chat_replicate",
          origin: COORDINATOR_ID,
          userId: currentPlayer.userId,
          username: currentPlayer.username,
          text,
          timestamp: now
        };

        const payloadStr = JSON.stringify(chatMessage);
        for (const socket of localSockets.values()) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(payloadStr);
          }
        }
        
        broadcastToPeers(chatMessage);
        return;
      }
    }

    if (message.type === "extras_update") {
      currentPlayer.extras = sanitizeExtras(message.extras, currentPlayer.extras);

      broadcastToPeers({
        type: "extras_replicate",
        origin: COORDINATOR_ID,
        userId,
        extras: { ...currentPlayer.extras }
      });

      broadcastState();
    }
  });

  socket.on("close", () => {
    removeLocalPlayerIfCurrent(userId, socket);
  });

  socket.on("error", () => {
    removeLocalPlayerIfCurrent(userId, socket);
  });
});

peerWss.on("connection", (socket) => {
  attachPeerSocket(socket, "inbound");
  sendPeerHello(socket);
});

let lastTick = Date.now();

function endMeeting() {
  if (globalGameState.status !== "meeting") return;

  const votes = globalGameState.meeting.votes;
  const voteCounts = {};
  for (const v of Object.values(votes)) {
    voteCounts[v] = (voteCounts[v] || 0) + 1;
  }

  let maxVotes = 0;
  let maxTarget = null;
  let tie = false;

  for (const [target, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      maxTarget = target;
      tie = false;
    } else if (count === maxVotes) {
      tie = true;
    }
  }

  if (!tie && maxTarget && maxTarget !== "skip") {
     const ejected = players.get(maxTarget);
     if (ejected) {
       if (ejected.ownerCoordinatorId === COORDINATOR_ID) {
         ejected.extras = { ...ejected.extras, isGhost: true };
         broadcastToPeers({
           type: "extras_replicate",
           origin: COORDINATOR_ID,
           userId: maxTarget,
           extras: { ...ejected.extras }
         });
       } else {
         broadcastToPeers({
           type: "eject_replicate",
           origin: COORDINATOR_ID,
           targetId: maxTarget
         });
       }
     }
  }

  globalGameState.status = "playing";
  globalGameState.meeting = null;

  broadcastToPeers({
    type: "global_state_replicate",
    origin: COORDINATOR_ID,
    state: globalGameState
  });
  broadcastState();
}

setInterval(() => {
  const now = Date.now();
  const deltaMs = now - lastTick;
  lastTick = now;

  // Auto-end meeting if timer expires
  if (globalGameState.status === "meeting" && globalGameState.meeting && now > globalGameState.meeting.endsAt) {
     endMeeting();
  }

  let changed = false;

  for (const player of players.values()) {
    if (updatePlayerPosition(player, deltaMs)) {
      changed = true;
    }
  }

  if (changed) {
    broadcastState();
  }
}, Math.max(16, Math.floor(1000 / TICK_RATE))).unref();

setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS).unref();
setInterval(refreshPeerDirectory, PEER_DISCOVERY_INTERVAL_MS).unref();
setInterval(broadcastSnapshotToPeers, PEER_SNAPSHOT_INTERVAL_MS).unref();

publicServer.listen(PUBLIC_PORT, async () => {
  console.log(`Coordinator ${COORDINATOR_ID} public WS listening on http://localhost:${PUBLIC_PORT}`);
  await sendHeartbeat();
});

peerServer.listen(PEER_PORT, async () => {
  console.log(`Coordinator ${COORDINATOR_ID} peer WS listening on http://localhost:${PEER_PORT}`);
  await refreshPeerDirectory();
});
