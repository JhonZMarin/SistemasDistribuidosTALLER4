// ═══════════════════════════════════════════════════════════════════════════
//  mesh.js — Auth Mesh P2P: connections, Bully election, heartbeat,
//            write propagation, full sync, reconnection
//  Auth Service — Taller 4 (Sistemas Distribuidos)
// ═══════════════════════════════════════════════════════════════════════════

const { WebSocketServer, WebSocket } = require("ws");
const {
  AUTH_NODE_ID,
  AUTH_ROLE_INITIAL,
  AUTH_WS_PORT,
  AUTH_HEARTBEAT_MS,
  AUTH_ELECTION_TIMEOUT_MS,
  AUTH_ELECTION_WAIT_MS,
  AUTH_PEER_RECONNECT_MS,
  AUTH_PUBLIC_URL,
  AUTH_PEER_URLS,
  IS_REPLICATED
} = require("./config");
const { getAllUsers, upsertSyncedUser, db } = require("./db");

// ── State ────────────────────────────────────────────────────────────────

let currentRole = IS_REPLICATED ? AUTH_ROLE_INITIAL : "leader";
let currentTerm = 0;
let currentLeaderId = currentRole === "leader" ? AUTH_NODE_ID : null;
let currentLeaderUrl = currentRole === "leader" ? AUTH_PUBLIC_URL : null;
let lastLeaderHeartbeat = Date.now();
let electionInProgress = false;
let electionTimeoutId = null;
let leaderHeartbeatIntervalId = null;
let replicaWatchdogIntervalId = null;

const authPeerConnections = new Map();   // peerId -> { peerId, socket, direction, peerUrl }
const pendingAuthOutbound = new Set();   // peerUrl strings
const authPeerUrlToId = new Map();       // peerUrl -> peerId (for reconnection)

// ── Getters (for routes and other modules) ───────────────────────────────

function getRole() { return currentRole; }
function getTerm() { return currentTerm; }
function getLeaderId() { return currentLeaderId; }
function getLeaderUrl() { return currentLeaderUrl; }
function getPeerConnections() { return authPeerConnections; }

// ── Low-level helpers ────────────────────────────────────────────────────

function sendToAuthSocket(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastToAuthPeers(message) {
  const payload = JSON.stringify(message);

  for (const conn of authPeerConnections.values()) {
    if (conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(payload);
    }
  }
}

function sendAuthHello(socket) {
  sendToAuthSocket(socket, {
    type: "hello",
    nodeId: AUTH_NODE_ID,
    role: currentRole,
    term: currentTerm,
    httpUrl: AUTH_PUBLIC_URL
  });
}

// ── Connection management ────────────────────────────────────────────────

function registerAuthPeerConnection(socket, peerId, direction, peerUrl) {
  const preferred = AUTH_NODE_ID.localeCompare(peerId) < 0 ? "outbound" : "inbound";
  const existing = authPeerConnections.get(peerId);

  if (existing && existing.socket !== socket) {
    if (existing.direction === preferred) {
      socket.close(4003, "duplicate auth peer");
      return false;
    }

    existing.socket.close(4003, "auth peer replaced");
    authPeerConnections.delete(peerId);
  }

  authPeerConnections.set(peerId, {
    peerId,
    socket,
    direction,
    peerUrl: peerUrl || "",
    connectedAt: Date.now()
  });

  socket._authMesh = socket._authMesh || {};
  socket._authMesh.peerId = peerId;
  socket._authMesh.established = true;

  return true;
}

function cleanupAuthPeerSocket(socket) {
  const peerUrl = socket._authMesh?.peerUrl;
  if (peerUrl) {
    pendingAuthOutbound.delete(peerUrl);
  }

  const peerId = socket._authMesh?.peerId;
  if (!peerId) {
    return;
  }

  const current = authPeerConnections.get(peerId);
  if (current && current.socket === socket) {
    authPeerConnections.delete(peerId);
    console.log(`[AUTH-MESH] Peer disconnected: ${peerId}`);
  }
}

function connectToAuthPeer(peerUrl) {
  if (pendingAuthOutbound.has(peerUrl)) {
    return;
  }

  for (const conn of authPeerConnections.values()) {
    if (conn.peerUrl === peerUrl) {
      return;
    }
  }

  pendingAuthOutbound.add(peerUrl);

  let socket;

  try {
    socket = new WebSocket(peerUrl);
  } catch (error) {
    pendingAuthOutbound.delete(peerUrl);
    return;
  }

  socket._authMesh = {
    direction: "outbound",
    peerUrl,
    peerId: "",
    established: false
  };

  socket.on("open", () => {
    sendAuthHello(socket);
  });

  socket.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    handleAuthPeerMessage(socket, msg);
  });

  socket.on("close", () => {
    pendingAuthOutbound.delete(peerUrl);
    cleanupAuthPeerSocket(socket);
  });

  socket.on("error", () => {
    pendingAuthOutbound.delete(peerUrl);
  });
}

function connectToAllAuthPeers() {
  for (const peerUrl of AUTH_PEER_URLS) {
    connectToAuthPeer(peerUrl);
  }
}

function reconnectAuthPeers() {
  for (const peerUrl of AUTH_PEER_URLS) {
    const knownPeerId = authPeerUrlToId.get(peerUrl);
    if (knownPeerId && authPeerConnections.has(knownPeerId)) {
      continue;
    }
    connectToAuthPeer(peerUrl);
  }
}

// ── Role transitions ─────────────────────────────────────────────────────

function becomeReplica(leaderId, leaderUrl, term) {
  const wasLeader = currentRole === "leader";
  currentRole = "replica";
  currentLeaderId = leaderId;
  currentLeaderUrl = leaderUrl;
  currentTerm = term;
  lastLeaderHeartbeat = Date.now();
  electionInProgress = false;

  if (electionTimeoutId) {
    clearTimeout(electionTimeoutId);
    electionTimeoutId = null;
  }

  stopLeaderHeartbeat();
  startReplicaWatchdog();

  if (wasLeader) {
    console.log(`[AUTH-MESH] Stepped down to REPLICA. Leader: ${leaderId} (term ${term})`);
  } else {
    console.log(`[AUTH-MESH] Accepted leader: ${leaderId} (term ${term})`);
  }
}

function becomeLeader() {
  currentRole = "leader";
  currentLeaderId = AUTH_NODE_ID;
  currentLeaderUrl = AUTH_PUBLIC_URL;
  electionInProgress = false;

  if (electionTimeoutId) {
    clearTimeout(electionTimeoutId);
    electionTimeoutId = null;
  }

  stopReplicaWatchdog();
  startLeaderHeartbeat();

  console.log(`[AUTH-MESH] Became LEADER (term ${currentTerm})`);

  broadcastToAuthPeers({
    type: "election_won",
    nodeId: AUTH_NODE_ID,
    term: currentTerm,
    httpUrl: AUTH_PUBLIC_URL
  });
}

// ── Leader heartbeat ─────────────────────────────────────────────────────

function sendLeaderHeartbeatNow() {
  broadcastToAuthPeers({
    type: "heartbeat",
    nodeId: AUTH_NODE_ID,
    term: currentTerm,
    httpUrl: AUTH_PUBLIC_URL
  });
}

function startLeaderHeartbeat() {
  stopLeaderHeartbeat();
  sendLeaderHeartbeatNow();

  leaderHeartbeatIntervalId = setInterval(() => {
    if (currentRole !== "leader") {
      return;
    }
    sendLeaderHeartbeatNow();
  }, AUTH_HEARTBEAT_MS);
}

function stopLeaderHeartbeat() {
  if (leaderHeartbeatIntervalId) {
    clearInterval(leaderHeartbeatIntervalId);
    leaderHeartbeatIntervalId = null;
  }
}

// ── Replica watchdog ─────────────────────────────────────────────────────

function startReplicaWatchdog() {
  stopReplicaWatchdog();

  replicaWatchdogIntervalId = setInterval(() => {
    if (currentRole !== "replica") {
      return;
    }

    const elapsed = Date.now() - lastLeaderHeartbeat;

    if (elapsed >= AUTH_ELECTION_TIMEOUT_MS) {
      console.log(`[AUTH-MESH] Leader heartbeat timeout (${elapsed}ms). Starting election.`);
      startElection();
    }
  }, 1000);
}

function stopReplicaWatchdog() {
  if (replicaWatchdogIntervalId) {
    clearInterval(replicaWatchdogIntervalId);
    replicaWatchdogIntervalId = null;
  }
}

// ── Election — Bully algorithm ───────────────────────────────────────────

function startElection() {
  if (electionInProgress) {
    return;
  }

  electionInProgress = true;
  currentTerm += 1;

  console.log(`[AUTH-MESH] Starting election for term ${currentTerm}`);

  broadcastToAuthPeers({
    type: "election_start",
    nodeId: AUTH_NODE_ID,
    term: currentTerm
  });

  // If no higher-priority node responds within AUTH_ELECTION_WAIT_MS, I win
  electionTimeoutId = setTimeout(() => {
    if (!electionInProgress) {
      return;
    }
    becomeLeader();
  }, AUTH_ELECTION_WAIT_MS);
}

function handleElectionStart(socket, message) {
  const senderId = String(message.nodeId || "").trim();
  const senderTerm = Number(message.term) || 0;

  if (senderTerm < currentTerm) {
    return;
  }

  if (senderTerm > currentTerm) {
    currentTerm = senderTerm;
  }

  if (AUTH_NODE_ID > senderId) {
    // I have higher priority — tell the sender to back off
    sendToAuthSocket(socket, {
      type: "election_alive",
      nodeId: AUTH_NODE_ID,
      term: currentTerm
    });

    // Start my own election if not already running
    if (!electionInProgress) {
      startElection();
    }
  }
}

function handleElectionAlive(_message) {
  // A higher-priority node is alive — cancel my election
  if (electionTimeoutId) {
    clearTimeout(electionTimeoutId);
    electionTimeoutId = null;
  }

  electionInProgress = false;
}

function handleElectionWon(message) {
  const winnerId = String(message.nodeId || "").trim();
  const winnerTerm = Number(message.term) || 0;
  const winnerHttpUrl = String(message.httpUrl || "").trim();

  if (winnerTerm < currentTerm) {
    return;
  }

  if (winnerId === AUTH_NODE_ID) {
    return;
  }

  // If I'm also leader, only step down if the winner outranks me
  if (currentRole === "leader") {
    const theyWin = winnerTerm > currentTerm
      || (winnerTerm === currentTerm && winnerId > AUTH_NODE_ID);

    if (!theyWin) {
      return;
    }
  }

  becomeReplica(winnerId, winnerHttpUrl, winnerTerm);

  // Request a full sync from the new leader
  const conn = authPeerConnections.get(winnerId);
  if (conn) {
    sendToAuthSocket(conn.socket, { type: "request_sync", nodeId: AUTH_NODE_ID });
  }
}

// ── Write propagation ────────────────────────────────────────────────────

function propagateWrite(userData) {
  if (currentRole !== "leader" || !IS_REPLICATED) {
    return;
  }

  broadcastToAuthPeers({
    type: "write_propagate",
    term: currentTerm,
    data: userData
  });
}

function handleWritePropagate(message) {
  if (currentRole !== "replica") {
    return;
  }

  const data = message.data;
  if (!data || !data.username) {
    return;
  }

  upsertSyncedUser(data);
}

// ── Sync ─────────────────────────────────────────────────────────────────

function handleRequestSync(socket) {
  if (currentRole !== "leader") {
    return;
  }

  const users = getAllUsers();

  sendToAuthSocket(socket, {
    type: "sync_response",
    term: currentTerm,
    users
  });

  console.log(`[AUTH-MESH] Sent sync_response with ${users.length} users`);
}

function handleSyncResponse(message) {
  const users = Array.isArray(message.users) ? message.users : [];
  let count = 0;

  for (const user of users) {
    if (!user.username) {
      continue;
    }

    try {
      const result = db.prepare(
        `INSERT OR IGNORE INTO users (id, username, provider, password_hash, google_sub, email, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        user.id ?? null,
        user.username,
        user.provider || "local",
        user.password_hash ?? null,
        user.google_sub ?? null,
        user.email ?? null,
        user.created_at ?? null
      );

      if (result.changes > 0) {
        count++;
      }
    } catch (error) {
      // skip individual failures (e.g. constraint conflict)
    }
  }

  console.log(`[AUTH-MESH] Sync complete: ${count} new users from leader`);
}

// ── Hello handler ────────────────────────────────────────────────────────

function handleAuthHello(socket, message) {
  const peerId = String(message.nodeId || "").trim();
  const peerRole = message.role;
  const peerTerm = Number(message.term) || 0;
  const peerHttpUrl = String(message.httpUrl || "").trim();

  if (!peerId || peerId === AUTH_NODE_ID) {
    socket.close(4002, "invalid auth peer id");
    return;
  }

  const direction = socket._authMesh?.direction || "inbound";
  const peerUrl = socket._authMesh?.peerUrl || "";

  if (!registerAuthPeerConnection(socket, peerId, direction, peerUrl)) {
    return;
  }

  // Store URL → ID mapping for reconnection logic
  if (peerUrl) {
    authPeerUrlToId.set(peerUrl, peerId);
  }

  // ── Resolve leader conflicts ──

  if (peerRole === "leader" && currentRole === "leader") {
    // Two leaders: higher term wins, tie-break by nodeId
    const iWin = (currentTerm > peerTerm)
      || (currentTerm === peerTerm && AUTH_NODE_ID > peerId);

    if (!iWin) {
      becomeReplica(peerId, peerHttpUrl, Math.max(currentTerm, peerTerm));
      // Request sync from the peer we just accepted as leader
      sendToAuthSocket(socket, { type: "request_sync", nodeId: AUTH_NODE_ID });
    }
  } else if (peerRole === "leader" && peerTerm >= currentTerm) {
    // Peer is leader and has valid term — accept them
    currentLeaderId = peerId;
    currentLeaderUrl = peerHttpUrl;
    currentTerm = peerTerm;
    lastLeaderHeartbeat = Date.now();

    if (currentRole === "replica") {
      sendToAuthSocket(socket, { type: "request_sync", nodeId: AUTH_NODE_ID });
    }
  }

  // Always keep our term up to date
  if (peerTerm > currentTerm) {
    currentTerm = peerTerm;
  }
}

// ── Heartbeat handler ────────────────────────────────────────────────────

function handleAuthHeartbeat(message) {
  const senderId = String(message.nodeId || "").trim();
  const senderTerm = Number(message.term) || 0;
  const senderHttpUrl = String(message.httpUrl || "").trim();

  if (senderTerm < currentTerm) {
    return;
  }

  if (senderTerm > currentTerm) {
    currentTerm = senderTerm;
  }

  // If I'm leader and someone else is heartbeating with >= term, resolve
  if (currentRole === "leader" && senderId !== AUTH_NODE_ID) {
    const theyWin = senderTerm > currentTerm
      || (senderTerm === currentTerm && senderId > AUTH_NODE_ID);

    if (theyWin) {
      becomeReplica(senderId, senderHttpUrl, Math.max(currentTerm, senderTerm));
    }
    return;
  }

  // I'm a replica — reset watchdog timer
  if (currentRole === "replica") {
    currentLeaderId = senderId;
    currentLeaderUrl = senderHttpUrl || currentLeaderUrl;
    lastLeaderHeartbeat = Date.now();
  }
}

// ── Message router ───────────────────────────────────────────────────────

function handleAuthPeerMessage(socket, message) {
  switch (message.type) {
    case "hello":
      handleAuthHello(socket, message);
      break;
    case "heartbeat":
      handleAuthHeartbeat(message);
      break;
    case "write_propagate":
      handleWritePropagate(message);
      break;
    case "request_sync":
      handleRequestSync(socket);
      break;
    case "sync_response":
      handleSyncResponse(message);
      break;
    case "election_start":
      handleElectionStart(socket, message);
      break;
    case "election_alive":
      handleElectionAlive(message);
      break;
    case "election_won":
      handleElectionWon(message);
      break;
    default:
      break;
  }
}

// ── Write guard middleware ────────────────────────────────────────────────

function writeGuard(_request, response, next) {
  if (!IS_REPLICATED || currentRole === "leader") {
    return next();
  }

  return response.status(503).json({
    error: "not_leader",
    message: "Este nodo es una replica de solo lectura. Las escrituras van al lider.",
    leader: currentLeaderUrl || null,
    leaderId: currentLeaderId || null
  });
}

// ── Start mesh (called from index.js) ────────────────────────────────────

function startMesh() {
  if (!IS_REPLICATED) {
    return;
  }

  const authWss = new WebSocketServer({ port: AUTH_WS_PORT }, () => {
    console.log(`Auth service [${AUTH_NODE_ID}] WS mesh on ws://localhost:${AUTH_WS_PORT}`);
  });

  authWss.on("connection", (socket) => {
    socket._authMesh = {
      direction: "inbound",
      peerUrl: "",
      peerId: "",
      established: false
    };

    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      handleAuthPeerMessage(socket, msg);
    });

    socket.on("close", () => cleanupAuthPeerSocket(socket));
    socket.on("error", () => cleanupAuthPeerSocket(socket));

    sendAuthHello(socket);
  });

  // Connect to peers after a short delay so the WS server is ready
  setTimeout(connectToAllAuthPeers, 500);

  // Periodic reconnection for dropped peers
  setInterval(reconnectAuthPeers, AUTH_PEER_RECONNECT_MS).unref();

  // Start role-specific timers
  if (currentRole === "leader") {
    startLeaderHeartbeat();
  } else {
    startReplicaWatchdog();
  }
}

module.exports = {
  getRole,
  getTerm,
  getLeaderId,
  getLeaderUrl,
  getPeerConnections,
  propagateWrite,
  writeGuard,
  startMesh,
  IS_REPLICATED
};
