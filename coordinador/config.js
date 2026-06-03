// ═══════════════════════════════════════════════════════════════════════════
//  config.js — Environment helpers & configuration constants
//  Coordinador — Taller 4
// ═══════════════════════════════════════════════════════════════════════════

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

const WORLD_WIDTH = readIntegerEnv("WORLD_WIDTH", 3000);
const WORLD_HEIGHT = readIntegerEnv("WORLD_HEIGHT", 3000);
const PLAYER_RADIUS = readIntegerEnv("PLAYER_RADIUS", 40);
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
    { x: 500, y: 1000, w: 800, h: 100 },
    { x: 1700, y: 1000, w: 800, h: 100 },
    { x: 500, y: 2000, w: 800, h: 100 },
    { x: 1700, y: 2000, w: 800, h: 100 },
    { x: 1450, y: 1100, w: 100, h: 300 }, // Pared vertical superior (deja hueco en el centro)
    { x: 1450, y: 1700, w: 100, h: 300 }  // Pared vertical inferior (deja hueco en el centro)
  ],
  vents: [
    { id: 'vent1', x: 200, y: 200 },
    { id: 'vent2', x: 2800, y: 200 },
    { id: 'vent3', x: 200, y: 2800 },
    { id: 'vent4', x: 2800, y: 2800 }
  ],
  vitals: { x: 1450, y: 1400, w: 100, h: 100 },
  tasks: [
    { id: 'task1', x: 600, y: 500, w: 80, h: 80 },
    { id: 'task2', x: 2400, y: 500, w: 80, h: 80 },
    { id: 'task3', x: 600, y: 2500, w: 80, h: 80 },
    { id: 'task4', x: 2400, y: 2500, w: 80, h: 80 },
    { id: 'task5', x: 1500, y: 200, w: 80, h: 80 },
    { id: 'task6', x: 1500, y: 2800, w: 80, h: 80 }
  ],
  emergencyButton: { x: 1460, y: 1550, w: 80, h: 80 }
});

module.exports = {
  PUBLIC_PORT,
  PEER_PORT,
  JWT_SECRET,
  COORDINATOR_ID,
  AUTH_SERVICE_URL,
  PUBLIC_WS_URL,
  PEER_WS_URL,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  TICK_RATE,
  HEARTBEAT_INTERVAL_MS,
  PEER_DISCOVERY_INTERVAL_MS,
  PEER_SNAPSHOT_INTERVAL_MS,
  KILL_DISTANCE,
  WORLD,
  toHttpBaseUrl,
  readOptionalEnv
};
