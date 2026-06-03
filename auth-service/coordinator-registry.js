// ═══════════════════════════════════════════════════════════════════════════
//  coordinator-registry.js — Coordinator heartbeat tracking & load balancing
//  Auth Service — Taller 4 (Sistemas Distribuidos)
// ═══════════════════════════════════════════════════════════════════════════

const {
  HEARTBEAT_TIMEOUT_MS,
  PUBLIC_URL_PROBE_TIMEOUT_MS,
  normalizeBaseUrl,
  isWebSocketUrl,
  toNonNegativeInteger
} = require("./config");

const coordinatorRegistry = new Map();
let publicUrlProbeInFlight = false;

// ── Pruning ──────────────────────────────────────────────────────────────

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

// ── Public URL probing ───────────────────────────────────────────────────

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

// ── Heartbeat validation ─────────────────────────────────────────────────

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

module.exports = {
  coordinatorRegistry,
  pruneDeadCoordinators,
  listAliveCoordinators,
  probeCoordinatorDirectory,
  validateHeartbeatPayload
};
