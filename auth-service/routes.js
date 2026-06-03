// ═══════════════════════════════════════════════════════════════════════════
//  routes.js — Express HTTP routes
//  Auth Service — Taller 4 (Sistemas Distribuidos)
// ═══════════════════════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const {
  AUTH_NODE_ID,
  GOOGLE_CLIENT_ID,
  IS_REPLICATED
} = require("./config");
const { DB_FILENAME, findUserByUsername, findUserByGoogleSub, insertLocalUser, insertGoogleUser } = require("./db");
const {
  googleClient,
  emitToken,
  validateUsername,
  validatePassword,
  hashPassword,
  verifyPassword,
  buildGoogleServiceUnavailable
} = require("./auth");
const {
  coordinatorRegistry,
  listAliveCoordinators,
  validateHeartbeatPayload
} = require("./coordinator-registry");
const {
  getRole,
  getTerm,
  getLeaderId,
  getLeaderUrl,
  getPeerConnections,
  propagateWrite,
  writeGuard
} = require("./mesh");

// ── Create app ───────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: "8kb" }));

// ── Info routes ──────────────────────────────────────────────────────────

app.get("/", (_request, response) => {
  const coordinators = listAliveCoordinators();

  response.json({
    service: "auth-service",
    nodeId: AUTH_NODE_ID,
    role: getRole(),
    term: getTerm(),
    leader: getLeaderId(),
    status: "ok",
    googleAuthEnabled: Boolean(googleClient),
    registeredCoordinators: coordinators.length,
    routes: ["/register", "/login", "/auth/google", "/heartbeat", "/coordinator", "/peers", "/status"]
  });
});

app.get("/status", (_request, response) => {
  const authPeers = Array.from(getPeerConnections().values()).map((conn) => ({
    nodeId: conn.peerId,
    direction: conn.direction,
    peerUrl: conn.peerUrl || null,
    connectedAt: conn.connectedAt
  }));

  response.json({
    service: "auth-service",
    nodeId: AUTH_NODE_ID,
    role: getRole(),
    term: getTerm(),
    leader: getLeaderId(),
    leaderUrl: getLeaderUrl(),
    replicated: IS_REPLICATED,
    electionInProgress: false,
    connectedAuthPeers: authPeers.length,
    authPeers,
    dbFile: DB_FILENAME,
    uptime: Math.floor(process.uptime())
  });
});

// ── Coordinator registry routes ──────────────────────────────────────────

app.post("/heartbeat", writeGuard, (request, response) => {
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

app.get("/coordinator", writeGuard, (_request, response) => {
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

app.get("/peers", writeGuard, (_request, response) => {
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
  if (IS_REPLICATED && getRole() !== "leader") {
    return response.status(503).json({
      error: "not_leader",
      message: "Primer login con Google requiere escritura. Usa el lider.",
      leader: getLeaderUrl() || null,
      leaderId: getLeaderId() || null
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

module.exports = { app };
