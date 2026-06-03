// ═══════════════════════════════════════════════════════════════════════════
//  Auth Service — Entry Point (Orchestrator)
//  Autor: Wilson Sebastian Moreno Sanchez — 55223016
//  Taller 4 — Sistemas Distribuidos
// ═══════════════════════════════════════════════════════════════════════════

require("dotenv").config();

const {
  PORT,
  AUTH_NODE_ID,
  HEARTBEAT_TIMEOUT_MS,
  PUBLIC_URL_PROBE_INTERVAL_MS,
  IS_REPLICATED,
  AUTH_PEER_URLS
} = require("./config");

const { DB_FILENAME } = require("./db");

const { getRole, getTerm, startMesh } = require("./mesh");

const { pruneDeadCoordinators, probeCoordinatorDirectory } = require("./coordinator-registry");

const { app } = require("./routes");

// ═══════════════════════════════════════════════════════════════════════════
//  TIMERS
// ═══════════════════════════════════════════════════════════════════════════

const cleanupIntervalMs = Math.max(1000, Math.floor(HEARTBEAT_TIMEOUT_MS / 2));
setInterval(pruneDeadCoordinators, cleanupIntervalMs).unref();
setInterval(() => {
  probeCoordinatorDirectory().catch((error) => {
    console.error("coordinator probe failed:", error);
  });
}, PUBLIC_URL_PROBE_INTERVAL_MS).unref();

// ═══════════════════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`Auth service [${AUTH_NODE_ID}] HTTP listening on http://localhost:${PORT}`);
  console.log(`  Role: ${getRole()} | Term: ${getTerm()} | DB: ${DB_FILENAME}`);

  if (IS_REPLICATED) {
    console.log(`  Replicated mode: ${AUTH_PEER_URLS.length} peer(s) configured`);
  } else {
    console.log(`  Standalone mode (no AUTH_PEERS configured)`);
  }
});

// Start the Auth Mesh P2P layer (WebSocket server + peer connections)
startMesh();
