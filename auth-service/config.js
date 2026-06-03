// ═══════════════════════════════════════════════════════════════════════════
//  config.js — Environment helpers & configuration constants
//  Auth Service — Taller 4 (Sistemas Distribuidos)
// ═══════════════════════════════════════════════════════════════════════════

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

// ── Build configuration object ───────────────────────────────────────────

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

module.exports = {
  PORT,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  GOOGLE_CLIENT_ID,
  PASSWORD_HASH_ITERATIONS,
  HEARTBEAT_TIMEOUT_MS,
  PUBLIC_URL_PROBE_INTERVAL_MS,
  PUBLIC_URL_PROBE_TIMEOUT_MS,
  USERNAME_PATTERN,
  AUTH_NODE_ID,
  AUTH_ROLE_INITIAL,
  AUTH_WS_PORT,
  AUTH_HEARTBEAT_MS,
  AUTH_ELECTION_TIMEOUT_MS,
  AUTH_ELECTION_WAIT_MS,
  AUTH_PEER_RECONNECT_MS,
  AUTH_PUBLIC_URL,
  AUTH_PEER_URLS,
  IS_REPLICATED,
  // Utility functions exported for other modules
  normalizeBaseUrl,
  isWebSocketUrl,
  toNonNegativeInteger
};
