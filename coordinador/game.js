const { WebSocket } = require("ws");
const { 
  WORLD, PLAYER_RADIUS, PLAYER_SPEED, COORDINATOR_ID, TICK_RATE 
} = require("./config");
const state = require("./state");
const mesh = require("./mesh"); // Will use mesh.broadcastToPeers

function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

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
  return { x: 1450 + (hash % 100), y: 1450 + (Math.floor(hash / 97) % 100) };
}

function normalizeDirection(rawDirection) {
  return { 
    x: Math.sign(Number(rawDirection?.x) || 0), 
    y: Math.sign(Number(rawDirection?.y) || 0) 
  };
}

function sanitizeExtraValue(value) {
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  const text = String(value || "").trim();
  return text ? Array.from(text).slice(0, 32).join("") : "";
}

function sanitizeExtras(extras, baseExtras = {}) {
  const safeExtras = { ...baseExtras };
  if (!extras || typeof extras !== "object" || Array.isArray(extras)) return safeExtras;
  for (const [key, value] of Object.entries(extras)) {
    const cleanKey = String(key || "").trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(cleanKey)) continue;
    const cleanValue = sanitizeExtraValue(value);
    if (cleanValue === "") { delete safeExtras[cleanKey]; continue; }
    safeExtras[cleanKey] = cleanValue;
  }
  return safeExtras;
}

function areDirectionsEqual(left, right) {
  return left?.x === right?.x && left?.y === right?.y;
}

function areExtrasEqual(left, right) {
  const leftEntries = Object.entries(left || {}).sort(([l], [r]) => l.localeCompare(r));
  const rightEntries = Object.entries(right || {}).sort(([l], [r]) => l.localeCompare(r));
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([lk, lv], i) => lk === rightEntries[i][0] && lv === rightEntries[i][1]);
}

function serializePlayer(player) {
  return {
    userId: player.userId, username: player.username, provider: player.provider,
    x: player.x, y: player.y, extras: { ...player.extras }, coordinatorId: player.ownerCoordinatorId,
    intent: { dir: { ...player.intent } }
  };
}

function serializePlayerForPeer(player) {
  return serializePlayer(player);
}

function buildStatePayload() {
  return JSON.stringify({
    type: "state",
    players: Array.from(state.players.values()).map(serializePlayer),
    gameState: state.globalGameState
  });
}

function broadcastState() {
  const payload = buildStatePayload();
  for (const [userId, socket] of state.localSockets.entries()) {
    if (socket.readyState !== WebSocket.OPEN) {
      state.localSockets.delete(userId);
      continue;
    }
    socket.send(payload);
  }
}

function sendWelcome(player) {
  if (!player.localSocket || player.localSocket.readyState !== WebSocket.OPEN) return;
  player.localSocket.send(JSON.stringify({
    type: "welcome", coordinatorId: COORDINATOR_ID,
    you: { userId: player.userId, username: player.username, provider: player.provider },
    world: WORLD
  }));
}

function buildPlayerJoinedMessage(player) {
  return { type: "player_joined", origin: COORDINATOR_ID, ...serializePlayerForPeer(player) };
}

function buildPlayersSnapshotMessage() {
  return {
    type: "players_snapshot", origin: COORDINATOR_ID,
    players: Array.from(state.players.values())
      .filter((p) => p.ownerCoordinatorId === COORDINATOR_ID)
      .map(serializePlayerForPeer)
  };
}

function removePlayersOwnedBy(ownerCoordinatorId) {
  let changed = false;
  for (const [userId, player] of state.players.entries()) {
    if (player.ownerCoordinatorId === ownerCoordinatorId) {
      if (player.localSocket) state.localSockets.delete(userId);
      state.players.delete(userId);
      changed = true;
    }
  }
  if (changed) broadcastState();
}

function checkWinConditions() {
  if (state.globalGameState.status !== "playing" && state.globalGameState.status !== "meeting") return;
  const allPlayers = Array.from(state.players.values());
  if (allPlayers.length < 2) return; // Permitir probar el juego en solitario sin que termine instantáneamente
  
  const impostors = state.globalGameState.impostors || [];
  let aliveCrewmates = 0, aliveImpostors = 0;

  for (const p of allPlayers) {
    if (p.extras?.isGhost || p.extras?.disconnected) continue;
    if (impostors.includes(p.userId)) { aliveImpostors++; } 
    else { aliveCrewmates++; }
  }

  let winner = null;
  if (aliveImpostors === 0 || (state.globalGameState.globalTasksTotal && state.globalGameState.globalTasksCompleted >= state.globalGameState.globalTasksTotal)) {
    winner = "crewmates";
  } else if (aliveCrewmates <= aliveImpostors && aliveImpostors > 0) {
    winner = "impostors";
  }

  if (winner) {
    state.globalGameState.status = "lobby";
    state.globalGameState.impostors = [];
    state.globalGameState.globalTasksCompleted = 0;
    state.globalGameState.globalTasksTotal = 0;
    state.globalGameState.meeting = null;

    for (const p of state.players.values()) {
      if (p.ownerCoordinatorId === COORDINATOR_ID) {
        p.extras = { ...p.extras, isGhost: false, inVent: false };
        mesh.broadcastToPeers({ type: "extras_replicate", origin: COORDINATOR_ID, userId: p.userId, extras: p.extras });
      }
    }
    mesh.broadcastToPeers({ type: "global_state_replicate", origin: COORDINATOR_ID, state: state.globalGameState });
    mesh.broadcastToPeers({ type: "game_over_broadcast", origin: COORDINATOR_ID, winner });
    broadcastState();
    const gameOverMsg = JSON.stringify({ type: "game_over", winner });
    for (const ws of state.localSockets.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(gameOverMsg);
    }
  }
}

function removeLocalPlayerIfCurrent(userId, socket) {
  const currentSocket = state.localSockets.get(userId);
  const currentPlayer = state.players.get(userId);
  if (currentSocket !== socket || !currentPlayer || currentPlayer.localSocket !== socket) return;
  
  state.localSockets.delete(userId);
  currentPlayer.localSocket = null;

  if (state.globalGameState.status !== "lobby") {
    currentPlayer.extras = { ...currentPlayer.extras, disconnected: true };
    currentPlayer.intent = { x: 0, y: 0 };
    mesh.broadcastToPeers({ type: "extras_replicate", origin: COORDINATOR_ID, userId: currentPlayer.userId, extras: currentPlayer.extras });
    mesh.broadcastToPeers({ type: "intent_replicate", origin: COORDINATOR_ID, userId: currentPlayer.userId, intent: { dir: { x: 0, y: 0 } } });
  } else {
    state.players.delete(userId);
    mesh.broadcastToPeers({ type: "player_left", origin: COORDINATOR_ID, userId });
  }
  
  broadcastState();
  checkWinConditions();
}

function upsertRemotePlayer(message) {
  const userId = String(message.userId || "").trim();
  const username = String(message.username || "").trim();
  const ownerCoordinatorId = String(message.origin || "").trim();

  if (!userId || !username || !ownerCoordinatorId || ownerCoordinatorId === COORDINATOR_ID) return false;

  const existing = state.players.get(userId);
  const nextPlayer = {
    userId, username, provider: String(message.provider || existing?.provider || "local").trim() || "local",
    x: Number.isFinite(Number(message.x)) ? Number(message.x) : existing?.x ?? createSpawnPoint(userId).x,
    y: Number.isFinite(Number(message.y)) ? Number(message.y) : existing?.y ?? createSpawnPoint(userId).y,
    extras: sanitizeExtras(message.extras, existing?.extras || {}),
    intent: normalizeDirection(message.intent?.dir || existing?.intent),
    ownerCoordinatorId, localSocket: null
  };

  if (existing && existing.userId === nextPlayer.userId && existing.username === nextPlayer.username &&
      existing.provider === nextPlayer.provider && existing.x === nextPlayer.x && existing.y === nextPlayer.y &&
      existing.ownerCoordinatorId === nextPlayer.ownerCoordinatorId && areDirectionsEqual(existing.intent, nextPlayer.intent) &&
      areExtrasEqual(existing.extras, nextPlayer.extras)) {
    return false;
  }
  state.players.set(userId, nextPlayer);
  return true;
}

function applyRemoteIntent(message) {
  const player = state.players.get(String(message.userId || "").trim());
  if (!player) return false;
  const nextIntent = normalizeDirection(message.intent?.dir);
  if (areDirectionsEqual(player.intent, nextIntent)) return false;
  player.intent = nextIntent;
  return true;
}

function applyRemoteExtras(message) {
  const player = state.players.get(String(message.userId || "").trim());
  if (!player) return false;
  const nextExtras = sanitizeExtras(message.extras, player.extras);
  if (areExtrasEqual(player.extras, nextExtras)) return false;
  player.extras = nextExtras;
  return true;
}

function applyRemotePlayersSnapshot(message) {
  const ownerCoordinatorId = String(message.origin || "").trim();
  if (!ownerCoordinatorId || ownerCoordinatorId === COORDINATOR_ID) return false;
  const remotePlayers = Array.isArray(message.players) ? message.players : [];
  const visibleUserIds = new Set();
  let changed = false;

  for (const remotePlayer of remotePlayers) {
    const userId = String(remotePlayer?.userId || "").trim();
    if (!userId) continue;
    visibleUserIds.add(userId);
    if (upsertRemotePlayer({ ...remotePlayer, origin: ownerCoordinatorId })) changed = true;
  }

  for (const [userId, player] of state.players.entries()) {
    if (player.ownerCoordinatorId !== ownerCoordinatorId) continue;
    if (visibleUserIds.has(userId)) continue;
    state.players.delete(userId);
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
    if ((distX * distX) + (distY * distY) < radius * radius) return true;
  }
  return false;
}

function updatePlayerPosition(player, deltaMs) {
  if (player.extras?.isGhost || player.extras?.inVent || state.globalGameState.status !== "playing") {
    if (!player.extras?.isGhost && (player.extras?.inVent || state.globalGameState.status !== "playing")) return false;
    if (state.globalGameState.status === "meeting") return false;
  }

  const direction = player.intent;
  if (!direction || (!direction.x && !direction.y)) return false;

  const vectorLength = Math.hypot(direction.x, direction.y);
  if (!vectorLength) return false;

  const distance = PLAYER_SPEED * (deltaMs / 1000);
  let nextX = player.x + ((direction.x / vectorLength) * distance);
  let nextY = player.y + ((direction.y / vectorLength) * distance);

  nextX = clamp(nextX, PLAYER_RADIUS, WORLD.width - PLAYER_RADIUS);
  nextY = clamp(nextY, PLAYER_RADIUS, WORLD.height - PLAYER_RADIUS);

  if (!player.extras?.isGhost) {
    if (checkWallCollision(nextX, player.y, PLAYER_RADIUS)) nextX = player.x;
    if (checkWallCollision(player.x, nextY, PLAYER_RADIUS)) nextY = player.y;
    if (checkWallCollision(nextX, nextY, PLAYER_RADIUS)) { nextX = player.x; nextY = player.y; }
  }

  if (nextX === player.x && nextY === player.y) return false;
  player.x = nextX;
  player.y = nextY;
  return true;
}

function endMeeting() {
  if (state.globalGameState.status !== "meeting") return;
  const votes = state.globalGameState.meeting.votes;
  const voteCounts = {};
  for (const v of Object.values(votes)) voteCounts[v] = (voteCounts[v] || 0) + 1;

  let maxVotes = 0, maxTarget = null, tie = false;
  for (const [target, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) { maxVotes = count; maxTarget = target; tie = false; } 
    else if (count === maxVotes) { tie = true; }
  }

  if (!tie && maxTarget && maxTarget !== "skip") {
     const ejected = state.players.get(maxTarget);
     if (ejected) {
       if (ejected.ownerCoordinatorId === COORDINATOR_ID) {
         ejected.extras = { ...ejected.extras, isGhost: true };
         mesh.broadcastToPeers({ type: "extras_replicate", origin: COORDINATOR_ID, userId: maxTarget, extras: { ...ejected.extras } });
       } else {
         mesh.broadcastToPeers({ type: "eject_replicate", origin: COORDINATOR_ID, targetId: maxTarget });
       }
     }
  }

  state.globalGameState.status = "playing";
  state.globalGameState.meeting = null;
  mesh.broadcastToPeers({ type: "global_state_replicate", origin: COORDINATOR_ID, state: state.globalGameState });
  broadcastState();
  checkWinConditions();
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const deltaMs = now - lastTick;
  lastTick = now;

  if (state.globalGameState.status === "meeting" && state.globalGameState.meeting && now > state.globalGameState.meeting.endsAt) {
     endMeeting();
  }

  let changed = false;
  for (const player of state.players.values()) {
    if (updatePlayerPosition(player, deltaMs)) changed = true;
  }
  if (changed) broadcastState();
}, Math.max(16, Math.floor(1000 / TICK_RATE))).unref();

module.exports = {
  clamp, hashString, createSpawnPoint, normalizeDirection, sanitizeExtras,
  broadcastState, sendWelcome, buildPlayerJoinedMessage, buildPlayersSnapshotMessage,
  removePlayersOwnedBy, checkWinConditions, removeLocalPlayerIfCurrent, upsertRemotePlayer,
  applyRemoteIntent, applyRemoteExtras, applyRemotePlayersSnapshot, endMeeting
};
