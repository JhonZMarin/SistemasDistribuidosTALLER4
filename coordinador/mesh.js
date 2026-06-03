const { WebSocket } = require("ws");
const { 
  COORDINATOR_ID, AUTH_SERVICE_URLS, PUBLIC_WS_URL, PEER_WS_URL, 
  toHttpBaseUrl, readOptionalEnv 
} = require("./config");
const state = require("./state");

// Lazy-load game.js para evitar el problema de dependencia circular.
// game.js requiere mesh.js y mesh.js requiere game.js.
// Si ambos se cargan al mismo tiempo, uno de los dos recibe un objeto vacío.
// Con lazy-load, game.js se resuelve solo cuando se llama por primera vez,
// momento en el cual ambos módulos ya terminaron de inicializarse.
let _game = null;
function game() {
  if (!_game) _game = require("./game");
  return _game;
}

function broadcastToPeers(message) {
  const payload = JSON.stringify(message);
  for (const peerConnection of state.peerConnections.values()) {
    if (peerConnection.socket.readyState === WebSocket.OPEN) {
      peerConnection.socket.send(payload);
    }
  }
}

function syncLocalPlayersToPeer(socket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(game().buildPlayersSnapshotMessage()));
}

function broadcastSnapshotToPeers() {
  if (!state.peerConnections.size) return;
  broadcastToPeers(game().buildPlayersSnapshotMessage());
}

function listVisiblePeers() {
  return Array.from(state.peerDirectory.values())
    .map((peer) => {
      const peerConnection = state.peerConnections.get(peer.coordinatorId);
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
  const existing = state.peerConnections.get(peerId);

  if (existing && existing.socket !== socket) {
    if (existing.direction === preferredDirection) {
      socket.close(4003, "duplicate peer connection");
      return false;
    }
    existing.socket.close(4003, "peer connection replaced");
    state.peerConnections.delete(peerId);
  }

  state.peerConnections.set(peerId, {
    coordinatorId: peerId,
    peerUrl: socket._mesh.peerUrl || state.peerDirectory.get(peerId)?.peerUrl || "",
    direction, socket, connectedAt: Date.now()
  });

  socket._mesh.peerId = peerId;
  socket._mesh.established = true;
  state.pendingOutboundPeerIds.delete(peerId);
  syncLocalPlayersToPeer(socket);
  return true;
}

function cleanupPeerSocket(socket) {
  const peerId = socket._mesh?.peerId;
  if (socket._mesh?.expectedPeerId) state.pendingOutboundPeerIds.delete(socket._mesh.expectedPeerId);
  if (!peerId) return;

  const current = state.peerConnections.get(peerId);
  if (current && current.socket === socket) {
    state.peerConnections.delete(peerId);
    game().removePlayersOwnedBy(peerId);
  }
}

function sendPeerHello(socket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "hello", coordinatorId: COORDINATOR_ID }));
}

function handlePeerHello(socket, message) {
  const peerId = String(message?.coordinatorId || "").trim();
  if (!peerId || peerId === COORDINATOR_ID) { socket.close(4002, "invalid peer id"); return; }
  const direction = socket._mesh.direction;
  if (socket._mesh.expectedPeerId && socket._mesh.expectedPeerId !== peerId) { socket.close(4002, "unexpected peer id"); return; }
  if (direction === "inbound" && COORDINATOR_ID.localeCompare(peerId) < 0) { socket.close(4002, "outbound connection required"); return; }
  if (direction === "outbound" && COORDINATOR_ID.localeCompare(peerId) >= 0) { socket.close(4002, "inbound connection required"); return; }
  if (!registerPeerConnection(socket, peerId, direction)) return;

  if (direction === "inbound") {
    sendPeerHello(socket);
  }
}

function handlePeerReplicationMessage(socket, message) {
  if (!socket._mesh.established) return;
  if (String(message.origin || "").trim() === COORDINATOR_ID) return;

  switch (message.type) {
    case "player_joined":
      if (game().upsertRemotePlayer(message)) game().broadcastState();
      break;
    case "player_left":
      if (state.players.get(String(message.userId || "").trim())?.ownerCoordinatorId === String(message.origin || "").trim()) {
        state.players.delete(String(message.userId || "").trim());
        game().broadcastState();
        game().checkWinConditions();
      }
      break;
    case "intent_replicate":
      game().applyRemoteIntent(message);
      break;
    case "extras_replicate":
      if (game().applyRemoteExtras(message)) game().broadcastState();
      break;
    case "players_snapshot":
      if (game().applyRemotePlayersSnapshot(message)) game().broadcastState();
      break;
    case "global_state_replicate":
      if (message.state) {
        state.globalGameState = message.state;
        game().broadcastState();
      }
      break;
    case "eject_replicate":
      const ejectedPlayer = state.players.get(message.targetId);
      if (ejectedPlayer && ejectedPlayer.ownerCoordinatorId === COORDINATOR_ID) {
        ejectedPlayer.extras = { ...ejectedPlayer.extras, isGhost: true };
        broadcastToPeers({ type: "extras_replicate", origin: COORDINATOR_ID, userId: message.targetId, extras: { ...ejectedPlayer.extras } });
        game().broadcastState();
      }
      break;
    case "kill_replicate":
      const victim = state.players.get(message.targetId);
      if (victim && victim.ownerCoordinatorId === COORDINATOR_ID) {
        victim.extras = { ...victim.extras, isGhost: true };
        state.globalGameState.corpses.push({ id: victim.userId, x: victim.x, y: victim.y, breed: victim.extras.breed });
        broadcastToPeers({ type: "extras_replicate", origin: COORDINATOR_ID, userId: message.targetId, extras: { ...victim.extras } });
        broadcastToPeers({ type: "global_state_replicate", origin: COORDINATOR_ID, state: state.globalGameState });
        game().broadcastState();
      }
      break;
    case "chat_replicate":
      const payloadStr = JSON.stringify(message);
      for (const s of state.localSockets.values()) {
        if (s.readyState === WebSocket.OPEN) s.send(payloadStr);
      }
      break;
  }
}

function attachPeerSocket(socket, direction, expectedPeerId = "") {
  socket._mesh = {
    direction, expectedPeerId, peerId: "",
    peerUrl: expectedPeerId ? (state.peerDirectory.get(expectedPeerId)?.peerUrl || "") : "",
    established: false
  };

  socket.on("message", (rawMessage) => {
    let message;
    try { message = JSON.parse(String(rawMessage)); } catch (error) { return; }

    if (message.type === "game_over_broadcast") {
      const gameOverMsg = JSON.stringify({ type: "game_over", winner: message.winner });
      for (const ws of state.localSockets.values()) {
        if (ws.readyState === 1) ws.send(gameOverMsg);
      }
      return;
    }

    if (message.type === "hello") {
      handlePeerHello(socket, message);
      return;
    }

    handlePeerReplicationMessage(socket, message);
  });

  socket.on("close", () => cleanupPeerSocket(socket));
  socket.on("error", () => cleanupPeerSocket(socket));
}

function connectToPeer(peer) {
  if (!peer?.coordinatorId || state.pendingOutboundPeerIds.has(peer.coordinatorId) || state.peerConnections.has(peer.coordinatorId)) return;
  if (COORDINATOR_ID.localeCompare(peer.coordinatorId) >= 0) return;

  console.log(`[MESH] Connecting outbound to ${peer.coordinatorId} at ${peer.peerUrl}`);
  state.pendingOutboundPeerIds.add(peer.coordinatorId);
  const socket = new WebSocket(peer.peerUrl, {
    headers: { "ngrok-skip-browser-warning": "1" }
  });
  attachPeerSocket(socket, "outbound", peer.coordinatorId);

  socket.on("open", () => {
    console.log(`[MESH] WebSocket OPEN to ${peer.coordinatorId}`);
    socket._mesh.peerUrl = peer.peerUrl;
    sendPeerHello(socket);
  });

  socket.on("error", (err) => {
    console.error(`[MESH] WebSocket ERROR to ${peer.coordinatorId}:`, err.message);
  });

  socket.on("close", (code, reason) => {
    console.log(`[MESH] WebSocket CLOSED to ${peer.coordinatorId}: code=${code} reason=${String(reason)}`);
  });
}

let activeAuthIndex = 0;

async function fetchFromAuth(path, options) {
  for (let i = 0; i < AUTH_SERVICE_URLS.length; i++) {
    const url = AUTH_SERVICE_URLS[activeAuthIndex];
    try {
      const res = await fetch(`${url}${path}`, options);
      
      // If we hit a replica that is guarding writes, it will return 503 not_leader
      if (res.status === 503) {
        let data;
        try { data = await res.json(); } catch(e) {}
        if (data?.error === "not_leader" && data?.leader) {
          const leaderUrl = toHttpBaseUrl(data.leader);
          const leaderIndex = AUTH_SERVICE_URLS.findIndex(u => u === leaderUrl);
          if (leaderIndex !== -1) {
            activeAuthIndex = leaderIndex;
          } else {
            // Not in array? Add it and use it
            AUTH_SERVICE_URLS.push(leaderUrl);
            activeAuthIndex = AUTH_SERVICE_URLS.length - 1;
          }
          // Retry immediately with the new leader
          return await fetchFromAuth(path, options);
        }
        return res; // Some other 503 error
      }
      return res; // Success or normal error
    } catch (error) {
      // Network error, try next auth node
      activeAuthIndex = (activeAuthIndex + 1) % AUTH_SERVICE_URLS.length;
    }
  }
  throw new Error("All Auth Services are unreachable");
}

async function sendHeartbeat() {
  const payload = {
    coordinatorId: COORDINATOR_ID, publicUrl: PUBLIC_WS_URL, peerUrl: PEER_WS_URL,
    connectedPlayers: state.localSockets.size, uptime: Math.floor(process.uptime())
  };
  try {
    await fetchFromAuth(`/heartbeat`, {
      method: "POST", headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error("[MESH] Heartbeat failed:", error.message);
  }
}

async function refreshPeerDirectory() {
  try {
    const response = await fetchFromAuth(`/peers`, {
      headers: { "ngrok-skip-browser-warning": "1" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const peers = Array.isArray(data?.peers) ? data.peers : [];
    const visiblePeerIds = new Set();

    console.log(`[MESH] Discovered ${peers.length} peers from auth-service:`, peers.map(p => p.coordinatorId).join(', '));

    for (const peer of peers) {
      const peerId = String(peer?.coordinatorId || "").trim();
      const publicUrl = peer?.publicUrl;
      const peerUrl = peer?.peerUrl;
      if (!peerId || peerId === COORDINATOR_ID || !/^wss?:\/\//i.test(peerUrl)) continue;

      visiblePeerIds.add(peerId);
      state.peerDirectory.set(peerId, {
        coordinatorId: peerId, publicUrl, peerUrl,
        connectedPlayers: Number.isFinite(Number(peer?.connectedPlayers)) ? Math.max(0, Math.trunc(Number(peer.connectedPlayers))) : 0
      });
      connectToPeer({ coordinatorId: peerId, peerUrl });
    }

    for (const peerId of Array.from(state.peerDirectory.keys())) {
      if (visiblePeerIds.has(peerId)) continue;
      state.peerDirectory.delete(peerId);
      const peerConnection = state.peerConnections.get(peerId);
      if (peerConnection) peerConnection.socket.close(4004, "peer removed from directory");
    }
  } catch (error) {
    console.error("peer discovery failed:", error.message);
  }
}

module.exports = {
  broadcastToPeers, broadcastSnapshotToPeers, attachPeerSocket, sendHeartbeat, refreshPeerDirectory, listVisiblePeers
};
