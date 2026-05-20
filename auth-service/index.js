const path = require("path");
const { pbkdf2Sync, randomBytes, timingSafeEqual } = require("crypto");

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { DatabaseSync } = require("node:sqlite");

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

const PORT = readPort();
const JWT_SECRET = readRequiredEnv("JWT_SECRET", { minLength: 32 });
const JWT_EXPIRES_IN = readOptionalEnv("JWT_EXPIRES_IN") || "1h";
const GOOGLE_CLIENT_ID = readOptionalEnv("GOOGLE_CLIENT_ID");
const PASSWORD_HASH_ITERATIONS = readPositiveInteger("PASSWORD_HASH_ITERATIONS", 120000);
const HEARTBEAT_TIMEOUT_MS = readPositiveInteger("HEARTBEAT_TIMEOUT_MS", 6000);
const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const coordinatorRegistry = new Map();
const db = new DatabaseSync(path.join(__dirname, "users.db"));

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

const app = express();

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
  return Array.from(coordinatorRegistry.values()).map((entry) => ({ ...entry }));
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
  const coordinators = listAliveCoordinators();

  response.json({
    service: "auth-service",
    status: "ok",
    googleAuthEnabled: Boolean(googleClient),
    registeredCoordinators: coordinators.length,
    routes: ["/register", "/login", "/auth/google", "/heartbeat", "/coordinator", "/peers"]
  });
});

app.post("/heartbeat", (request, response) => {
  const validation = validateHeartbeatPayload(request.body);

  if (!validation.ok) {
    return response.status(400).json({ error: validation.error });
  }

  coordinatorRegistry.set(validation.value.coordinatorId, {
    ...validation.value,
    pendingAssignments: 0,
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
    peerUrl: coordinator.peerUrl
  }));

  return response.status(200).json({ peers });
});

app.post("/register", async (request, response) => {
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
    return response.status(200).json({
      token: emitToken(existingGoogleUser),
      username: existingGoogleUser.username
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

const cleanupIntervalMs = Math.max(1000, Math.floor(HEARTBEAT_TIMEOUT_MS / 2));
setInterval(pruneDeadCoordinators, cleanupIntervalMs).unref();

app.listen(PORT, () => {
  console.log(`Auth service listening on http://localhost:${PORT}`);
});
