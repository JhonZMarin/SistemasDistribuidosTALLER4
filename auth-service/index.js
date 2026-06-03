const path = require("path");
const http = require("http");
const { pbkdf2Sync, randomBytes, timingSafeEqual } = require("crypto");

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { DatabaseSync } = require("node:sqlite");
const { WebSocketServer, WebSocket } = require("ws");

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

function parseUrlList(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => normalizeBaseUrl(item));
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

const PORT = readPort();
const JWT_SECRET = readRequiredEnv("JWT_SECRET", { minLength: 32 });
const JWT_EXPIRES_IN = readOptionalEnv("JWT_EXPIRES_IN") || "1h";
const GOOGLE_CLIENT_ID = readOptionalEnv("GOOGLE_CLIENT_ID");
const PASSWORD_HASH_ITERATIONS = readPositiveInteger("PASSWORD_HASH_ITERATIONS", 120000);
const HEARTBEAT_TIMEOUT_MS = readPositiveInteger("HEARTBEAT_TIMEOUT_MS", 6000);
const AUTH_ELECTION_TIMEOUT_MS = readPositiveInteger("AUTH_ELECTION_TIMEOUT_MS", 2500);
const AUTH_READ_STALENESS_TOLERANCE = readPositiveInteger("AUTH_READ_STALENESS_TOLERANCE", 10);
const PUBLIC_URL_PROBE_INTERVAL_MS = readPositiveInteger("PUBLIC_URL_PROBE_INTERVAL_MS", 3000);
const PUBLIC_URL_PROBE_TIMEOUT_MS = readPositiveInteger("PUBLIC_URL_PROBE_TIMEOUT_MS", 2000);
const AUTH_ID = readOptionalEnv("AUTH_ID") || `auth-${PORT}`;
const PUBLIC_URL = normalizeBaseUrl(readOptionalEnv("PUBLIC_URL") || `http://localhost:${PORT}`);
const PEER_PORT = readPositiveInteger("PEER_PORT", PORT + 1000);
const PEER_URL = normalizeBaseUrl(readOptionalEnv("PEER_URL") || `ws://localhost:${PEER_PORT}`);
const AUTH_URLS = Array.from(new Set([
  ...parseUrlList(readOptionalEnv("AUTH_URLS")),
  PUBLIC_URL
])).filter(Boolean);
const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;
const AUTH_DB_SUFFIX = AUTH_ID.replace(/[^a-zA-Z0-9_-]/g, "_");

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const authPeerDirectory = new Map();
const authPeerConnections = new Map();
const pendingOutboundAuthPeerIds = new Set();
const pendingWriteAcks = new Map();
const coordinatorRegistry = new Map();
const db = new DatabaseSync(path.join(__dirname, `users-${AUTH_DB_SUFFIX}.db`));
let publicUrlProbeInFlight = false;
let authRole = "replica";
let authTerm = 0;
let leaderAuthId = null;
let leaderPublicUrl = null;
let leaderPeerUrl = null;
let leaderLastAppliedSeq = 0;
let lastLeaderHeartbeatAt = 0;
let electionTimerId = null;
let lastAppliedSeq = 0;
const authStartedAt = Date.now();

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

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    term INTEGER NOT NULL,
    op TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

const app = express();
const authPeerServer = http.createServer();
const authPeerWss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json({ limit: "8kb" }));

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

function getUsersCount() {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users").get();
  return Number(row?.count || 0);
}

function parseLogData(rawData) {
  if (rawData && typeof rawData === "object") {
    return rawData;
  }

  if (typeof rawData !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(rawData);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function upsertCoordinatorState(data, seqOverride = lastAppliedSeq) {
  const coordinatorId = String(data?.coordinatorId || "").trim();

  if (!coordinatorId) {
    return false;
  }

  coordinatorRegistry.set(coordinatorId, {
    coordinatorId,
    publicUrl: normalizeBaseUrl(data?.publicUrl),
    peerUrl: normalizeBaseUrl(data?.peerUrl),
    connectedPlayers: toNonNegativeInteger(Number(data?.connectedPlayers)) ?? 0,
    uptime: toNonNegativeInteger(Number(data?.uptime)) ?? 0,
    lastSeen: toNonNegativeInteger(Number(data?.lastSeen)) ?? Date.now(),
    updatedSeq: toNonNegativeInteger(Number(data?.updatedSeq)) ?? seqOverride,
    pendingAssignments: 0,
    publicReachable: true,
    lastPublicCheck: Date.now()
  });

  return true;
}

function applyOperationEntry(entry, options = {}) {
  const { persistLog = false } = options;
  const seq = toNonNegativeInteger(Number(entry?.seq));
  const term = toNonNegativeInteger(Number(entry?.term)) ?? authTerm;
  const op = String(entry?.op || "").trim();
  const data = parseLogData(entry?.data);

  if (seq === null || !op) {
    return false;
  }

  if (seq <= lastAppliedSeq) {
    return false;
  }

  if (persistLog) {
    db.prepare(
      "INSERT OR IGNORE INTO auth_log (seq, term, op, data) VALUES (?, ?, ?, ?)"
    ).run(seq, term, op, JSON.stringify(data));
  }

  switch (op) {
    case "register":
      db.prepare(
        "INSERT OR IGNORE INTO users (id, username, provider, password_hash, google_sub, email) VALUES (?, ?, 'local', ?, NULL, NULL)"
      ).run(
        toNonNegativeInteger(Number(data.userId)) || seq,
        String(data.username || "").trim(),
        String(data.passwordHash || "")
      );
      break;
    case "register_google":
      db.prepare(
        "INSERT OR IGNORE INTO users (id, username, provider, password_hash, google_sub, email) VALUES (?, ?, 'google', NULL, ?, ?)"
      ).run(
        toNonNegativeInteger(Number(data.userId)) || seq,
        String(data.username || "").trim(),
        String(data.googleSub || ""),
        String(data.email || "")
      );
      break;
    case "coordinator_heartbeat":
      upsertCoordinatorState(data, seq);
      break;
    default:
      break;
  }

  lastAppliedSeq = seq;
  authTerm = Math.max(authTerm, term);
  if (authRole === "leader") {
    leaderLastAppliedSeq = Math.max(leaderLastAppliedSeq, seq);
  }

  return true;
}

function recordOperation(op, data) {
  const result = db.prepare(
    "INSERT INTO auth_log (term, op, data) VALUES (?, ?, ?)"
  ).run(authTerm, op, JSON.stringify(data));
  const seq = toNonNegativeInteger(Number(result.lastInsertRowid)) || lastAppliedSeq + 1;
  applyOperationEntry({ seq, term: authTerm, op, data }, { persistLog: false });
  return { seq, term: authTerm, op, data };
}

function replayAuthLog() {
  const entries = db.prepare(
    "SELECT seq, term, op, data FROM auth_log ORDER BY seq ASC"
  ).all();

  for (const entry of entries) {
    applyOperationEntry(entry, { persistLog: false });
  }

  lastAppliedSeq = entries.length
    ? toNonNegativeInteger(Number(entries[entries.length - 1].seq)) || 0
    : 0;
  leaderLastAppliedSeq = lastAppliedSeq;
}

function listAliveAuthPeers() {
  return Array.from(authPeerDirectory.values())
    .filter((peer) => peer.authId && peer.authId !== AUTH_ID)
    .map((peer) => ({
      authId: peer.authId,
      publicUrl: peer.publicUrl,
      peerUrl: peer.peerUrl,
      role: peer.role
    }))
    .sort((left, right) => left.authId.localeCompare(right.authId));
}

function getKnownAuthIds() {
  return Array.from(new Set([
    AUTH_ID,
    ...authPeerDirectory.keys(),
    ...authPeerConnections.keys()
  ])).sort((left, right) => left.localeCompare(right));
}

function getLiveAuthIds() {
  const live = new Set([AUTH_ID]);

  for (const [peerId, connection] of authPeerConnections.entries()) {
    if (connection.socket.readyState === WebSocket.OPEN) {
      live.add(peerId);
    }
  }

  return Array.from(live).sort((left, right) => left.localeCompare(right));
}

function isLeaderAlive() {
  if (authRole === "leader" && leaderAuthId === AUTH_ID) {
    return true;
  }

  if (!leaderAuthId) {
    return false;
  }

  const leaderConnection = authPeerConnections.get(leaderAuthId);
  if (leaderConnection && leaderConnection.socket.readyState === WebSocket.OPEN) {
    return true;
  }

  return (Date.now() - lastLeaderHeartbeatAt) <= HEARTBEAT_TIMEOUT_MS;
}

function becomeLeader(nextTerm = authTerm + 1) {
  authTerm = Math.max(authTerm, nextTerm);
  authRole = "leader";
  leaderAuthId = AUTH_ID;
  leaderPublicUrl = PUBLIC_URL;
  leaderPeerUrl = PEER_URL;
  leaderLastAppliedSeq = lastAppliedSeq;
  lastLeaderHeartbeatAt = Date.now();
}

function adoptLeader(nextLeader) {
  if (!nextLeader) {
    authRole = "replica";
    leaderAuthId = null;
    leaderPublicUrl = null;
    leaderPeerUrl = null;
    return;
  }

  authRole = nextLeader.authId === AUTH_ID ? "leader" : "replica";
  leaderAuthId = nextLeader.authId;
  leaderPublicUrl = nextLeader.publicUrl || null;
  leaderPeerUrl = nextLeader.peerUrl || null;
  if (authRole === "leader") {
    leaderLastAppliedSeq = lastAppliedSeq;
    lastLeaderHeartbeatAt = Date.now();
  }
}

function evaluateLeadership(force = false) {
  const currentLeaderAlive = isLeaderAlive();

  if (!force && currentLeaderAlive) {
    return;
  }

  if (!force && !leaderAuthId && (Date.now() - authStartedAt) < AUTH_ELECTION_TIMEOUT_MS) {
    return;
  }

  const liveIds = getLiveAuthIds();
  if (!liveIds.length) {
    authRole = "replica";
    leaderAuthId = null;
    leaderPublicUrl = null;
    leaderPeerUrl = null;
    return;
  }

  const nextLeaderId = liveIds[0];

  if (nextLeaderId === AUTH_ID) {
    if (authRole !== "leader") {
      becomeLeader(authTerm + 1);
      broadcastToAuthPeers({
        type: "new_leader",
        authId: AUTH_ID,
        term: authTerm,
        leaderUrl: PUBLIC_URL
      });
      sendLeaderHeartbeat();
    }
    return;
  }

  const nextLeader = authPeerDirectory.get(nextLeaderId) || {
    authId: nextLeaderId,
    publicUrl: null,
    peerUrl: null,
    role: "leader"
  };

  if (leaderAuthId !== nextLeaderId || authRole === "leader") {
    authRole = "replica";
    leaderAuthId = nextLeaderId;
    leaderPublicUrl = nextLeader.publicUrl || null;
    leaderPeerUrl = nextLeader.peerUrl || null;
  }
}

function requireLeaderOrRedirect(response) {
  if (authRole === "leader") {
    return true;
  }

  if (!leaderPublicUrl) {
    return response.status(503).json({ error: "no_leader" });
  }

  return response.status(503).json({
    error: "not_leader",
    leaderUrl: leaderPublicUrl
  });
}

function canServeReadLocally() {
  if (authRole === "leader") {
    return true;
  }

  if (!leaderAuthId) {
    return false;
  }

  return (leaderLastAppliedSeq - lastAppliedSeq) < AUTH_READ_STALENESS_TOLERANCE;
}

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

function broadcastToAuthPeers(message) {
  const payload = JSON.stringify(message);

  for (const peerConnection of authPeerConnections.values()) {
    if (peerConnection.socket.readyState === WebSocket.OPEN) {
      peerConnection.socket.send(payload);
    }
  }
}

function sendAuthPeerHello(socket) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: "hello",
    authId: AUTH_ID,
    role: authRole,
    term: authTerm,
    lastAppliedSeq,
    leaderId: leaderAuthId,
    leaderUrl: leaderPublicUrl,
    publicUrl: PUBLIC_URL,
    peerUrl: PEER_URL
  }));
}

function registerAuthPeerConnection(socket, peerId, direction, peerSnapshot = {}) {
  const preferredDirection = AUTH_ID.localeCompare(peerId) < 0 ? "outbound" : "inbound";
  const existing = authPeerConnections.get(peerId);

  if (existing && existing.socket !== socket) {
    if (existing.direction === preferredDirection) {
      socket.close(4003, "duplicate peer connection");
      return false;
    }

    existing.socket.close(4003, "peer connection replaced");
    authPeerConnections.delete(peerId);
  }

  authPeerConnections.set(peerId, {
    authId: peerId,
    publicUrl: normalizeBaseUrl(peerSnapshot.publicUrl || authPeerDirectory.get(peerId)?.publicUrl),
    peerUrl: normalizeBaseUrl(peerSnapshot.peerUrl || authPeerDirectory.get(peerId)?.peerUrl),
    role: String(peerSnapshot.role || authPeerDirectory.get(peerId)?.role || "replica"),
    socket,
    direction,
    connectedAt: Date.now(),
    lastSeen: Date.now()
  });

  socket._mesh.authId = peerId;
  socket._mesh.established = true;
  pendingOutboundAuthPeerIds.delete(peerId);
  return true;
}

function cleanupAuthPeerSocket(socket) {
  const peerId = socket._mesh?.authId;

  if (socket._mesh?.expectedAuthId) {
    pendingOutboundAuthPeerIds.delete(socket._mesh.expectedAuthId);
  }

  if (!peerId) {
    evaluateLeadership();
    return;
  }

  const current = authPeerConnections.get(peerId);
  if (current && current.socket === socket) {
    authPeerConnections.delete(peerId);
    authPeerDirectory.delete(peerId);
  }

  if (peerId === leaderAuthId) {
    lastLeaderHeartbeatAt = 0;
    evaluateLeadership(true);
  } else {
    evaluateLeadership();
  }
}

function maybeRequestSyncFromPeer(peerId, peerLastAppliedSeq) {
  if (peerLastAppliedSeq <= lastAppliedSeq) {
    return;
  }

  const peerConnection = authPeerConnections.get(peerId);
  if (!peerConnection || peerConnection.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  peerConnection.socket.send(JSON.stringify({
    type: "request_sync",
    fromSeq: lastAppliedSeq
  }));
}

function handlePeerHello(socket, message) {
  const peerId = String(message?.authId || "").trim();

  if (!peerId || peerId === AUTH_ID) {
    socket.close(4002, "invalid peer id");
    return;
  }

  const direction = socket._mesh.direction;

  if (socket._mesh.expectedAuthId && socket._mesh.expectedAuthId !== peerId) {
    socket.close(4002, "unexpected peer id");
    return;
  }

  if (direction === "inbound" && AUTH_ID.localeCompare(peerId) < 0) {
    socket.close(4002, "outbound connection required");
    return;
  }

  if (direction === "outbound" && AUTH_ID.localeCompare(peerId) >= 0) {
    socket.close(4002, "inbound connection required");
    return;
  }

  const accepted = registerAuthPeerConnection(socket, peerId, direction, {
    publicUrl: message?.publicUrl,
    peerUrl: message?.peerUrl,
    role: message?.role
  });

  if (!accepted) {
    return;
  }

  authPeerDirectory.set(peerId, {
    authId: peerId,
    publicUrl: normalizeBaseUrl(message?.publicUrl),
    peerUrl: normalizeBaseUrl(message?.peerUrl),
    role: String(message?.role || "replica"),
    term: toNonNegativeInteger(Number(message?.term)) ?? authTerm,
    lastAppliedSeq: toNonNegativeInteger(Number(message?.lastAppliedSeq)) ?? 0,
    lastSeen: Date.now()
  });

  if (String(message?.role || "").trim() === "leader") {
    authTerm = Math.max(authTerm, toNonNegativeInteger(Number(message?.term)) ?? authTerm);
    leaderAuthId = peerId;
    leaderPublicUrl = normalizeBaseUrl(message?.publicUrl) || leaderPublicUrl;
    leaderPeerUrl = normalizeBaseUrl(message?.peerUrl) || leaderPeerUrl;
    lastLeaderHeartbeatAt = Date.now();
    leaderLastAppliedSeq = Math.max(leaderLastAppliedSeq, toNonNegativeInteger(Number(message?.lastAppliedSeq)) ?? 0);
  }

  maybeRequestSyncFromPeer(peerId, toNonNegativeInteger(Number(message?.lastAppliedSeq)) ?? 0);
}

function handlePeerHeartbeat(message) {
  const peerId = String(message?.authId || "").trim();
  const peerConnection = authPeerConnections.get(peerId);

  if (!peerId || !peerConnection) {
    return;
  }

  peerConnection.lastSeen = Date.now();
  authPeerDirectory.set(peerId, {
    authId: peerId,
    publicUrl: peerConnection.publicUrl,
    peerUrl: peerConnection.peerUrl,
    role: peerConnection.role,
    term: toNonNegativeInteger(Number(message?.term)) ?? authTerm,
    lastAppliedSeq: toNonNegativeInteger(Number(message?.lastSeq)) ?? 0,
    lastSeen: Date.now()
  });

  const incomingTerm = toNonNegativeInteger(Number(message?.term)) ?? authTerm;
  const incomingSeq = toNonNegativeInteger(Number(message?.lastSeq)) ?? 0;

  if (peerId === leaderAuthId || String(message?.role || "") === "leader") {
    authTerm = Math.max(authTerm, incomingTerm);
    leaderAuthId = peerId;
    leaderPublicUrl = normalizeBaseUrl(message?.leaderUrl) || peerConnection.publicUrl;
    leaderPeerUrl = peerConnection.peerUrl;
    lastLeaderHeartbeatAt = Date.now();
    leaderLastAppliedSeq = Math.max(leaderLastAppliedSeq, incomingSeq);
    if (incomingSeq > lastAppliedSeq) {
      maybeRequestSyncFromPeer(peerId, incomingSeq);
    }
  }
}

function handlePeerWritePropagation(message) {
  const seq = toNonNegativeInteger(Number(message?.seq));
  const term = toNonNegativeInteger(Number(message?.term)) ?? authTerm;

  if (seq === null || seq <= lastAppliedSeq) {
    return;
  }

  if (seq > lastAppliedSeq + 1) {
    const leaderConnection = leaderAuthId ? authPeerConnections.get(leaderAuthId) : null;
    if (leaderConnection && leaderConnection.socket.readyState === WebSocket.OPEN) {
      leaderConnection.socket.send(JSON.stringify({
        type: "request_sync",
        fromSeq: lastAppliedSeq
      }));
    }
    return;
  }

  applyOperationEntry({
    seq,
    term,
    op: message?.op,
    data: message?.data
  }, { persistLog: true });

  const sender = String(message?.authId || "").trim();
  const senderConnection = authPeerConnections.get(sender);
  if (senderConnection && senderConnection.socket.readyState === WebSocket.OPEN) {
    senderConnection.socket.send(JSON.stringify({
      type: "write_ack",
      authId: AUTH_ID,
      seq,
      term
    }));
  }
}

function handlePeerSyncRequest(socket, message) {
  if (authRole !== "leader") {
    return;
  }

  const fromSeq = toNonNegativeInteger(Number(message?.fromSeq)) ?? 0;
  const entries = db.prepare(
    "SELECT seq, term, op, data FROM auth_log WHERE seq > ? ORDER BY seq ASC"
  ).all(fromSeq).map((entry) => ({
    seq: toNonNegativeInteger(Number(entry.seq)) || 0,
    term: toNonNegativeInteger(Number(entry.term)) || authTerm,
    op: entry.op,
    data: parseLogData(entry.data)
  }));

  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: "sync_response",
    entries
  }));
}

function handlePeerSyncResponse(message) {
  const entries = Array.isArray(message?.entries) ? message.entries : [];

  for (const entry of entries) {
    applyOperationEntry(entry, { persistLog: true });
  }
}

function handlePeerNewLeader(message) {
  const peerId = String(message?.authId || "").trim();
  const term = toNonNegativeInteger(Number(message?.term)) ?? authTerm;
  const leaderUrl = normalizeBaseUrl(message?.leaderUrl) || null;

  if (!peerId || peerId === AUTH_ID) {
    return;
  }

  if (term >= authTerm) {
    authTerm = term;
    authRole = "replica";
    leaderAuthId = peerId;
    leaderPublicUrl = leaderUrl;
    lastLeaderHeartbeatAt = Date.now();
  }
}

function handleAuthPeerMessage(socket, rawMessage) {
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

  if (message.type === "heartbeat") {
    handlePeerHeartbeat(message);
    return;
  }

  if (message.type === "write_propagate") {
    handlePeerWritePropagation(message);
    return;
  }

  if (message.type === "request_sync") {
    handlePeerSyncRequest(socket, message);
    return;
  }

  if (message.type === "sync_response") {
    handlePeerSyncResponse(message);
    return;
  }

  if (message.type === "new_leader") {
    handlePeerNewLeader(message);
    return;
  }
}

function attachAuthPeerSocket(socket, direction, expectedAuthId = "") {
  socket._mesh = {
    direction,
    expectedAuthId,
    authId: "",
    peerUrl: expectedAuthId ? (authPeerDirectory.get(expectedAuthId)?.peerUrl || "") : "",
    established: false
  };

  socket.on("message", (rawMessage) => {
    handleAuthPeerMessage(socket, rawMessage);
  });

  socket.on("close", () => {
    cleanupAuthPeerSocket(socket);
  });

  socket.on("error", () => {
    cleanupAuthPeerSocket(socket);
  });
}

function connectToAuthPeer(peer) {
  if (!peer?.authId || peer.authId === AUTH_ID) {
    return;
  }

  if (pendingOutboundAuthPeerIds.has(peer.authId) || authPeerConnections.has(peer.authId)) {
    return;
  }

  if (AUTH_ID.localeCompare(peer.authId) >= 0) {
    return;
  }

  pendingOutboundAuthPeerIds.add(peer.authId);

  const socket = new WebSocket(peer.peerUrl);
  attachAuthPeerSocket(socket, "outbound", peer.authId);

  socket.on("open", () => {
    socket._mesh.peerUrl = peer.peerUrl;
    sendAuthPeerHello(socket);
  });
}

async function refreshAuthPeerDirectory() {
  const visibleAuthIds = new Set([AUTH_ID]);

  for (const authUrl of AUTH_URLS) {
    try {
      if (normalizeBaseUrl(authUrl) === PUBLIC_URL) {
        continue;
      }

      const response = await fetch(`${normalizeBaseUrl(authUrl)}/status`, {
        headers: {
          Accept: "application/json",
          "ngrok-skip-browser-warning": "1"
        }
      });

      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      const authId = String(data?.authId || "").trim();
      const peerUrl = normalizeBaseUrl(data?.peerUrl);
      const publicUrl = normalizeBaseUrl(data?.publicUrl);

      if (!authId || authId === AUTH_ID || !/^wss?:\/\//i.test(peerUrl)) {
        continue;
      }

      visibleAuthIds.add(authId);
      authPeerDirectory.set(authId, {
        authId,
        publicUrl,
        peerUrl,
        role: String(data?.role || "replica"),
        term: toNonNegativeInteger(Number(data?.term)) ?? authTerm,
        lastAppliedSeq: toNonNegativeInteger(Number(data?.lastAppliedSeq)) ?? 0,
        lastSeen: Date.now()
      });

      if (String(data?.role || "") === "leader") {
        authTerm = Math.max(authTerm, toNonNegativeInteger(Number(data?.term)) ?? authTerm);
        leaderAuthId = authId;
        leaderPublicUrl = publicUrl;
        leaderPeerUrl = peerUrl;
        lastLeaderHeartbeatAt = Date.now();
        leaderLastAppliedSeq = Math.max(leaderLastAppliedSeq, toNonNegativeInteger(Number(data?.lastAppliedSeq)) ?? 0);
      }

      connectToAuthPeer({ authId, peerUrl });
    } catch (error) {
      continue;
    }
  }

  for (const authId of Array.from(authPeerDirectory.keys())) {
    if (visibleAuthIds.has(authId)) {
      continue;
    }

    authPeerDirectory.delete(authId);
    const connection = authPeerConnections.get(authId);
    if (connection) {
      connection.socket.close(4004, "peer removed from directory");
    }
  }

  evaluateLeadership();
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

app.get("/", (_request, response) => {
  response.json({
    service: "auth-service",
    authId: AUTH_ID,
    role: authRole,
    leaderId: leaderAuthId,
    leaderUrl: leaderPublicUrl,
    publicUrl: PUBLIC_URL,
    peerUrl: PEER_URL,
    users: getUsersCount(),
    lastAppliedSeq,
    routes: ["/status", "/peers", "/register", "/login", "/auth/google", "/heartbeat", "/coordinator"]
  });
});

app.get("/status", (_request, response) => {
  response.json({
    authId: AUTH_ID,
    role: authRole,
    publicUrl: PUBLIC_URL,
    peerUrl: PEER_URL,
    leaderUrl: leaderPublicUrl || PUBLIC_URL,
    leaderId: leaderAuthId || AUTH_ID,
    knownPeers: getKnownAuthIds().filter((authId) => authId !== AUTH_ID),
    lastAppliedSeq,
    users: getUsersCount(),
    term: authTerm
  });
});

app.get("/peers", (request, response) => {
  if (String(request.query?.kind || "").trim() === "coordinators") {
    if (authRole !== "leader") {
      return response.status(503).json({
        error: "not_leader",
        leaderUrl: leaderPublicUrl || PUBLIC_URL
      });
    }

    const peers = listAliveCoordinators().map((coordinator) => ({
      coordinatorId: coordinator.coordinatorId,
      publicUrl: coordinator.publicUrl,
      peerUrl: coordinator.peerUrl,
      connectedPlayers: coordinator.connectedPlayers
    }));

    return response.status(200).json({ peers });
  }

  const peers = listAliveAuthPeers();
  return response.status(200).json({ peers });
});

app.post("/heartbeat", (request, response) => {
  if (authRole !== "leader") {
    return response.status(503).json({
      error: "not_leader",
      leaderUrl: leaderPublicUrl || PUBLIC_URL
    });
  }

  const validation = validateHeartbeatPayload(request.body);

  if (!validation.ok) {
    return response.status(400).json({ error: validation.error });
  }

  const payload = {
    ...validation.value,
    lastSeen: Date.now()
  };

  const entry = recordOperation("coordinator_heartbeat", payload);
  broadcastToAuthPeers({
    type: "write_propagate",
    authId: AUTH_ID,
    seq: entry.seq,
    term: entry.term,
    op: entry.op,
    data: entry.data
  });

  return response.status(200).json({ ok: true, seq: entry.seq });
});

app.get("/coordinator", (_request, response) => {
  if (authRole !== "leader") {
    return response.status(503).json({
      error: "not_leader",
      leaderUrl: leaderPublicUrl || PUBLIC_URL
    });
  }

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

app.post("/register", async (request, response) => {
  try {
    if (authRole !== "leader") {
      return response.status(503).json({
        error: "not_leader",
        leaderUrl: leaderPublicUrl || PUBLIC_URL
      });
    }

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
    const entry = recordOperation("register", {
      userId: result.lastInsertRowid,
      username: usernameValidation.username,
      passwordHash
    });
    broadcastToAuthPeers({
      type: "write_propagate",
      authId: AUTH_ID,
      seq: entry.seq,
      term: entry.term,
      op: entry.op,
      data: entry.data
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

    if (!canServeReadLocally()) {
      return response.status(503).json({
        error: authRole === "leader" ? "no_leader" : "not_leader",
        leaderUrl: leaderPublicUrl || PUBLIC_URL
      });
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

  const existingGoogleUser = findUserByGoogleSub(googleSub);
  if (existingGoogleUser) {
    if (!canServeReadLocally()) {
      return response.status(503).json({
        error: authRole === "leader" ? "no_leader" : "not_leader",
        leaderUrl: leaderPublicUrl || PUBLIC_URL
      });
    }

    return response.status(200).json({
      token: emitToken(existingGoogleUser),
      username: existingGoogleUser.username
    });
  }

  if (authRole !== "leader") {
    return response.status(503).json({
      error: "not_leader",
      leaderUrl: leaderPublicUrl || PUBLIC_URL
    });
  }

  const rawUsername = request.body?.username;
  const hasUsername = String(rawUsername || "").trim().length > 0;

  if (!hasUsername) {
    return response.status(409).json({
      error: "username_required",
      hint: "Primer login con Google. Debes elegir un username."
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
    const entry = recordOperation("register_google", {
      userId: result.lastInsertRowid,
      username: usernameValidation.username,
      googleSub,
      email
    });
    broadcastToAuthPeers({
      type: "write_propagate",
      authId: AUTH_ID,
      seq: entry.seq,
      term: entry.term,
      op: entry.op,
      data: entry.data
    });

    const user = {
      id: result.lastInsertRowid,
      username: usernameValidation.username,
      provider: "google"
    };

    return response.status(200).json({
      token: emitToken(user),
      username: user.username
    });
  } catch (error) {
    console.error("google auth insert failed:", error);
    return response.status(500).json({ error: "internal" });
  }
});

function sendLeaderHeartbeat() {
  if (authRole !== "leader") {
    return;
  }

  broadcastToAuthPeers({
    type: "heartbeat",
    authId: AUTH_ID,
    term: authTerm,
    lastSeq: lastAppliedSeq,
    leaderUrl: PUBLIC_URL,
    leaderPeerUrl: PEER_URL,
    role: "leader"
  });
}

authPeerWss.on("connection", (socket) => {
  attachAuthPeerSocket(socket, "inbound");
  sendAuthPeerHello(socket);
});

authPeerServer.on("upgrade", (request, socket, head) => {
  authPeerWss.handleUpgrade(request, socket, head, (webSocket) => {
    authPeerWss.emit("connection", webSocket, request);
  });
});

replayAuthLog();
evaluateLeadership();

const cleanupIntervalMs = Math.max(1000, Math.floor(HEARTBEAT_TIMEOUT_MS / 2));
setInterval(pruneDeadCoordinators, cleanupIntervalMs).unref();
setInterval(() => {
  probeCoordinatorDirectory().catch((error) => {
    console.error("coordinator probe failed:", error);
  });
}, PUBLIC_URL_PROBE_INTERVAL_MS).unref();
setInterval(sendLeaderHeartbeat, HEARTBEAT_TIMEOUT_MS / 2).unref();
setInterval(refreshAuthPeerDirectory, Math.max(1000, Math.floor(HEARTBEAT_TIMEOUT_MS / 2))).unref();
setInterval(() => {
  if (authRole !== "leader" && !isLeaderAlive()) {
    evaluateLeadership();
  }
}, Math.max(1000, Math.floor(HEARTBEAT_TIMEOUT_MS / 3))).unref();

app.listen(PORT, () => {
  console.log(`Auth service listening on http://localhost:${PORT}`);
});

authPeerServer.listen(PEER_PORT, () => {
  console.log(`Auth peer mesh listening on ws://localhost:${PEER_PORT}`);
});
