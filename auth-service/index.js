// ═══════════════════════════════════════════════════════════════════════════
//  Auth Service — Single-Writer Replication (Taller 4)
//  Autor: Wilson Sebastian Moreno Sanchez — 55223016
// ═══════════════════════════════════════════════════════════════════════════

const path = require("path");
const { pbkdf2Sync, randomBytes, timingSafeEqual } = require("crypto");

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { DatabaseSync } = require("node:sqlite");
const { WebSocketServer, WebSocket } = require("ws");

// ── Env helpers ──────────────────────────────────────────────────────────

function readRequiredEnv(name, options = {}) {
  const value = String(process.env[name] || "").trim();
  const minLength = Number.isInteger(options.minLength) ? options.minLength : 1;

  if (value.length < minLength) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readOptionalEnv(name) {
  return String(process.env[name] || "").trim();
}

function readPort() {
  const rawPort = String(process.env.PORT || "4000").trim();
  const port = Number.parseInt(rawPort, 10);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  return port;
}

function readPositiveInteger(name, fallback) {
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

function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function isWebSocketUrl(url) {
  return /^wss?:\/\//i.test(url);
}

function toNonNegativeInteger(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

// ── Configuration ────────────────────────────────────────────────────────

const PORT = readPort();
const JWT_SECRET = readRequiredEnv("JWT_SECRET", { minLength: 32 });
const JWT_EXPIRES_IN = readOptionalEnv("JWT_EXPIRES_IN") || "1h";
const GOOGLE_CLIENT_ID = readOptionalEnv("GOOGLE_CLIENT_ID");
const PASSWORD_HASH_ITERATIONS = readPositiveInteger("PASSWORD_HASH_ITERATIONS", 120000);
const HEARTBEAT_TIMEOUT_MS = readPositiveInteger("HEARTBEAT_TIMEOUT_MS", 6000);
const PUBLIC_URL_PROBE_INTERVAL_MS = readPositiveInteger("PUBLIC_URL_PROBE_INTERVAL_MS", 3000);
const PUBLIC_URL_PROBE_TIMEOUT_MS = readPositiveInteger("PUBLIC_URL_PROBE_TIMEOUT_MS", 2000);
const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

// Auth mesh configuration
const AUTH_NODE_ID = readOptionalEnv("AUTH_NODE_ID") || `auth-${PORT}`;
const AUTH_ROLE_INITIAL = readOptionalEnv("AUTH_ROLE") || "leader";
const AUTH_PEERS_RAW = readOptionalEnv("AUTH_PEERS");
const AUTH_WS_PORT = readPositiveInteger("AUTH_WS_PORT", PORT + 500);
const AUTH_HEARTBEAT_MS = 2000;
const AUTH_ELECTION_TIMEOUT_MS = readPositiveInteger("AUTH_ELECTION_TIMEOUT_MS", 6000);
const AUTH_ELECTION_WAIT_MS = 3000;
const AUTH_PEER_RECONNECT_MS = 3000;
const AUTH_PUBLIC_URL = readOptionalEnv("AUTH_PUBLIC_URL") || `http://localhost:${PORT}`;

const AUTH_PEER_URLS = AUTH_PEERS_RAW
  ? AUTH_PEERS_RAW.split(",").map(u => u.trim()).filter(u => /^wss?:\/\//i.test(u))
  : [];
const IS_REPLICATED = AUTH_PEER_URLS.length > 0;

// ── Database ─────────────────────────────────────────────────────────────

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const coordinatorRegistry = new Map();
let publicUrlProbeInFlight = false;

// Each node gets its own DB file when running in replicated mode to avoid
// SQLite locking conflicts.  Standalone mode keeps the original "users.db".
const DB_FILENAME = IS_REPLICATED ? `users-${AUTH_NODE_ID}.db` : "users.db";
const db = new DatabaseSync(path.join(__dirname, DB_FILENAME));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('local', 'google')),
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    email TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── Auth Mesh State ──────────────────────────────────────────────────────

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

// ── Express App ──────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json({ limit: "8kb" }));

// ── Auth Helpers ─────────────────────────────────────────────────────────

function emitToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      provider: user.provider
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function validateUsername(username) {
  const cleanUsername = String(username || "").trim();

  if (!cleanUsername) {
    return { ok: false, message: "username debe existir" };
  }

  if (cleanUsername.length < 3 || cleanUsername.length > 32) {
    return { ok: false, message: "username 3-32 chars" };
  }

  if (!USERNAME_PATTERN.test(cleanUsername)) {
    return { ok: false, message: "username solo letras, numeros y _" };
  }

  return { ok: true, username: cleanUsername };
}

function validatePassword(password) {
  const cleanPassword = String(password || "");

  if (!cleanPassword) {
    return { ok: false, message: "password debe existir" };
  }

  if (cleanPassword.length < 6) {
    return { ok: false, message: "password debe tener al menos 6 caracteres" };
  }

  return { ok: true, password: cleanPassword };
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, PASSWORD_HASH_ITERATIONS, 32, "sha256");

  return `pbkdf2$${PASSWORD_HASH_ITERATIONS}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== "string" || !storedHash.startsWith("pbkdf2$")) {
    return false;
  }

  const parts = storedHash.split("$");
  if (parts.length !== 4) {
    return false;
  }

  const iterations = Number.parseInt(parts[1], 10);
  const salt = Buffer.from(parts[2], "base64url");
  const expectedHash = Buffer.from(parts[3], "base64url");

  if (!Number.isInteger(iterations) || iterations <= 0 || !salt.length || !expectedHash.length) {
    return false;
  }

  const hash = pbkdf2Sync(password, salt, iterations, expectedHash.length, "sha256");

  if (hash.length !== expectedHash.length) {
    return false;
  }

  return timingSafeEqual(hash, expectedHash);
}

function buildGoogleServiceUnavailable() {
  return {
    error: "google_auth_not_configured",
    message: "GOOGLE_CLIENT_ID no esta configurado en auth-service."
  };
}

function findUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

function findUserByGoogleSub(googleSub) {
  return db.prepare("SELECT * FROM users WHERE google_sub = ?").get(googleSub);
}

function insertLocalUser(username, passwordHash) {
  return db.prepare(
    "INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', ?)"
  ).run(username, passwordHash);
}

function insertGoogleUser(username, googleSub, email) {
  return db.prepare(
    "INSERT INTO users (username, provider, google_sub, email) VALUES (?, 'google', ?, ?)"
  ).run(username, googleSub, email);
}

function getAllUsers() {
  return db.prepare(
    "SELECT id, username, provider, password_hash, google_sub, email, created_at FROM users"
  ).all();
}

function upsertSyncedUser(userData) {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, provider, password_hash, google_sub, email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userData.id ?? null,
      userData.username,
      userData.provider || "local",
      userData.password_hash ?? null,
      userData.google_sub ?? null,
      userData.email ?? null,
      userData.created_at ?? null
    );
  } catch (error) {
    console.error("[AUTH-MESH] upsertSyncedUser failed:", error.message);
  }
}

// ── Coordinator Registry (unchanged) ─────────────────────────────────────

function pruneDeadCoordinators() {
  const now = Date.now();

  for (const [coordinatorId, entry] of coordinatorRegistry.entries()) {
    if ((now - entry.lastSeen) > HEARTBEAT_TIMEOUT_MS) {
      coordinatorRegistry.delete(coordinatorId);
    }
  }
}

function listAliveCoordinators() {
  pruneDeadCoordinators();
  return Array.from(coordinatorRegistry.values())
    .filter((entry) => entry.publicReachable !== false)
    .map((entry) => ({ ...entry }));
}

function toHttpProbeUrl(publicUrl) {
  const normalized = normalizeBaseUrl(publicUrl);

  if (normalized.startsWith("ws://")) {
    return `http://${normalized.slice(5)}`;
  }

  if (normalized.startsWith("wss://")) {
    return `https://${normalized.slice(6)}`;
  }

  return "";
}

async function probeCoordinatorPublicUrl(entry) {
  const probeUrl = toHttpProbeUrl(entry.publicUrl);

  if (!probeUrl) {
    return false;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PUBLIC_URL_PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(probeUrl, {
      headers: {
        Accept: "application/json",
        "ngrok-skip-browser-warning": "1"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return false;
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      return false;
    }

    const payload = await response.json();
    const coordinatorId = String(payload?.coordinatorId || "").trim();

    return payload?.service === "coordinador" && coordinatorId === entry.coordinatorId;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeCoordinatorDirectory() {
  if (publicUrlProbeInFlight) {
    return;
  }

  publicUrlProbeInFlight = true;

  try {
    pruneDeadCoordinators();

    const snapshots = Array.from(coordinatorRegistry.entries()).map(([coordinatorId, entry]) => ([
      coordinatorId,
      { ...entry }
    ]));

    await Promise.all(snapshots.map(async ([coordinatorId, snapshot]) => {
      const reachable = await probeCoordinatorPublicUrl(snapshot);
      const current = coordinatorRegistry.get(coordinatorId);

      if (!current) {
        return;
      }

      if (current.publicUrl !== snapshot.publicUrl || current.lastSeen !== snapshot.lastSeen) {
        return;
      }

      current.publicReachable = reachable;
      current.lastPublicCheck = Date.now();
    }));
  } finally {
    publicUrlProbeInFlight = false;
  }
}

function validateHeartbeatPayload(body) {
  const coordinatorId = String(body?.coordinatorId || "").trim();
  const publicUrl = normalizeBaseUrl(body?.publicUrl);
  const peerUrl = normalizeBaseUrl(body?.peerUrl);
  const connectedPlayers = toNonNegativeInteger(Number(body?.connectedPlayers));
  const uptime = toNonNegativeInteger(Number(body?.uptime));

  if (!coordinatorId) {
    return { ok: false, error: "coordinatorId requerido" };
  }

  if (!isWebSocketUrl(publicUrl)) {
    return { ok: false, error: "publicUrl invalida" };
  }

  if (!isWebSocketUrl(peerUrl)) {
    return { ok: false, error: "peerUrl invalida" };
  }

  if (connectedPlayers === null) {
    return { ok: false, error: "connectedPlayers invalido" };
  }

  if (uptime === null) {
    return { ok: false, error: "uptime invalido" };
  }

  return {
    ok: true,
    value: {
      coordinatorId,
      publicUrl,
      peerUrl,
      connectedPlayers,
      uptime
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  AUTH MESH — WebSocket Replication Layer
// ═══════════════════════════════════════════════════════════════════════════

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
// Returns 503 on replicas for endpoints that require writes.

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

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get("/", (_request, response) => {
  const coordinators = listAliveCoordinators();

  response.json({
    service: "auth-service",
    nodeId: AUTH_NODE_ID,
    role: currentRole,
    term: currentTerm,
    leader: currentLeaderId,
    status: "ok",
    googleAuthEnabled: Boolean(googleClient),
    registeredCoordinators: coordinators.length,
    routes: ["/register", "/login", "/auth/google", "/heartbeat", "/coordinator", "/peers", "/status"]
  });
});

app.get("/status", (_request, response) => {
  const authPeers = Array.from(authPeerConnections.values()).map((conn) => ({
    nodeId: conn.peerId,
    direction: conn.direction,
    peerUrl: conn.peerUrl || null,
    connectedAt: conn.connectedAt
  }));

  response.json({
    service: "auth-service",
    nodeId: AUTH_NODE_ID,
    role: currentRole,
    term: currentTerm,
    leader: currentLeaderId,
    leaderUrl: currentLeaderUrl,
    replicated: IS_REPLICATED,
    electionInProgress,
    connectedAuthPeers: authPeers.length,
    authPeers,
    dbFile: DB_FILENAME,
    uptime: Math.floor(process.uptime())
  });
});

app.post("/heartbeat", (request, response) => {
  const validation = validateHeartbeatPayload(request.body);

  if (!validation.ok) {
    return response.status(400).json({ error: validation.error });
  }

  const previous = coordinatorRegistry.get(validation.value.coordinatorId);
  const publicUrlChanged = previous?.publicUrl !== validation.value.publicUrl;

  coordinatorRegistry.set(validation.value.coordinatorId, {
    ...validation.value,
    pendingAssignments: 0,
    publicReachable: publicUrlChanged ? true : (previous?.publicReachable ?? true),
    lastPublicCheck: publicUrlChanged ? 0 : (previous?.lastPublicCheck ?? 0),
    lastSeen: Date.now()
  });

  return response.status(200).json({ ok: true });
});

app.get("/coordinator", (_request, response) => {
  const coordinators = listAliveCoordinators();

  if (!coordinators.length) {
    return response.status(503).json({ error: "no_coordinators_available" });
  }

  let selected = coordinators[0];

  for (const coordinator of coordinators) {
    const coordinatorLoad = coordinator.connectedPlayers + (coordinator.pendingAssignments || 0);
    const selectedLoad = selected.connectedPlayers + (selected.pendingAssignments || 0);

    if (coordinatorLoad < selectedLoad) {
      selected = coordinator;
    }
  }

  const registryEntry = coordinatorRegistry.get(selected.coordinatorId);
  if (registryEntry) {
    registryEntry.pendingAssignments = (registryEntry.pendingAssignments || 0) + 1;
  }

  return response.status(200).json({
    coordinatorId: selected.coordinatorId,
    publicUrl: selected.publicUrl
  });
});

app.get("/peers", (_request, response) => {
  const peers = listAliveCoordinators().map((coordinator) => ({
    coordinatorId: coordinator.coordinatorId,
    publicUrl: coordinator.publicUrl,
    peerUrl: coordinator.peerUrl,
    connectedPlayers: coordinator.connectedPlayers
  }));

  return response.status(200).json({ peers });
});

// ── /register — write-guarded ────────────────────────────────────────────

app.post("/register", writeGuard, async (request, response) => {
  try {
    const usernameValidation = validateUsername(request.body?.username);
    if (!usernameValidation.ok) {
      return response.status(400).json({ error: usernameValidation.message });
    }

    const passwordValidation = validatePassword(request.body?.password);
    if (!passwordValidation.ok) {
      return response.status(400).json({ error: passwordValidation.message });
    }

    if (findUserByUsername(usernameValidation.username)) {
      return response.status(409).json({ error: "El usuario ya existe" });
    }

    const passwordHash = await hashPassword(passwordValidation.password);
    const result = insertLocalUser(usernameValidation.username, passwordHash);

    // Propagate to replicas
    propagateWrite({
      id: Number(result.lastInsertRowid),
      username: usernameValidation.username,
      provider: "local",
      password_hash: passwordHash,
      google_sub: null,
      email: null
    });

    return response.status(201).json({
      userId: result.lastInsertRowid,
      username: usernameValidation.username
    });
  } catch (error) {
    console.error("register failed:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
});

// ── /login — read-only, works on any node ────────────────────────────────

app.post("/login", async (request, response) => {
  try {
    const usernameValidation = validateUsername(request.body?.username);
    if (!usernameValidation.ok) {
      return response.status(400).json({ error: usernameValidation.message });
    }

    const passwordValidation = validatePassword(request.body?.password);
    if (!passwordValidation.ok) {
      return response.status(400).json({ error: passwordValidation.message });
    }

    const user = findUserByUsername(usernameValidation.username);

    if (!user) {
      return response.status(401).json({ error: "Credenciales invalidas" });
    }

    if (user.provider !== "local") {
      return response.status(401).json({ error: "Este usuario debe iniciar sesion con Google" });
    }

    const validPassword = await verifyPassword(passwordValidation.password, user.password_hash);

    if (!validPassword) {
      return response.status(401).json({ error: "Credenciales invalidas" });
    }

    return response.status(200).json({
      token: emitToken(user),
      username: user.username
    });
  } catch (error) {
    console.error("login failed:", error);
    return response.status(500).json({ error: "Error interno del servidor" });
  }
});

// ── /auth/google — partially write-guarded (only new-user path) ──────────

app.post("/auth/google", async (request, response) => {
  if (!googleClient) {
    return response.status(503).json(buildGoogleServiceUnavailable());
  }

  const idToken = String(request.body?.idToken || "").trim();
  if (!idToken) {
    return response.status(400).json({ error: "idToken requerido" });
  }

  let payload;

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID
    });
    payload = ticket.getPayload();
  } catch (error) {
    return response.status(401).json({ error: "invalid_id_token" });
  }

  if (!payload?.email_verified) {
    return response.status(401).json({ error: "email_not_verified" });
  }

  const googleSub = String(payload.sub || "").trim();
  const email = String(payload.email || "").trim();

  if (!googleSub) {
    return response.status(401).json({ error: "invalid_id_token" });
  }

  // Existing Google user → read-only (replicas can handle this)
  const existingGoogleUser = findUserByGoogleSub(googleSub);
  if (existingGoogleUser) {
    return response.status(200).json({
      token: emitToken(existingGoogleUser),
      username: existingGoogleUser.username
    });
  }

  // ── From here on we need to INSERT → leader only ──

  const rawUsername = request.body?.username;
  const hasUsername = String(rawUsername || "").trim().length > 0;

  if (!hasUsername) {
    return response.status(409).json({
      error: "username_required",
      hint: "Primer login con Google. Debes elegir un username."
    });
  }

  // Block writes on replicas
  if (IS_REPLICATED && currentRole !== "leader") {
    return response.status(503).json({
      error: "not_leader",
      message: "Primer login con Google requiere escritura. Usa el lider.",
      leader: currentLeaderUrl || null,
      leaderId: currentLeaderId || null
    });
  }

  const usernameValidation = validateUsername(rawUsername);

  if (!usernameValidation.ok) {
    return response.status(400).json({ error: usernameValidation.message });
  }

  if (findUserByUsername(usernameValidation.username)) {
    return response.status(409).json({ error: "username_taken" });
  }

  try {
    const result = insertGoogleUser(usernameValidation.username, googleSub, email);
    const user = {
      id: result.lastInsertRowid,
      username: usernameValidation.username,
      provider: "google"
    };

    // Propagate to replicas
    propagateWrite({
      id: Number(result.lastInsertRowid),
      username: usernameValidation.username,
      provider: "google",
      password_hash: null,
      google_sub: googleSub,
      email
    });

    return response.status(200).json({
      token: emitToken(user),
      username: user.username
    });
  } catch (error) {
    console.error("google auth insert failed:", error);
    return response.status(500).json({ error: "internal" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  TIMERS & STARTUP
// ═══════════════════════════════════════════════════════════════════════════

const cleanupIntervalMs = Math.max(1000, Math.floor(HEARTBEAT_TIMEOUT_MS / 2));
setInterval(pruneDeadCoordinators, cleanupIntervalMs).unref();
setInterval(() => {
  probeCoordinatorDirectory().catch((error) => {
    console.error("coordinator probe failed:", error);
  });
}, PUBLIC_URL_PROBE_INTERVAL_MS).unref();

// ── HTTP server ──────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Auth service [${AUTH_NODE_ID}] HTTP listening on http://localhost:${PORT}`);
  console.log(`  Role: ${currentRole} | Term: ${currentTerm} | DB: ${DB_FILENAME}`);

  if (IS_REPLICATED) {
    console.log(`  Replicated mode: ${AUTH_PEER_URLS.length} peer(s) configured`);
  } else {
    console.log(`  Standalone mode (no AUTH_PEERS configured)`);
  }
});

// ── Auth mesh WebSocket server (only in replicated mode) ─────────────────

if (IS_REPLICATED) {
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
