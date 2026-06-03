// ═══════════════════════════════════════════════════════════════════════════
//  state.js — Shared state for Coordinator
//  Coordinador — Taller 4
// ═══════════════════════════════════════════════════════════════════════════

const players = new Map();
const localSockets = new Map();
const peerDirectory = new Map();
const peerConnections = new Map();
const pendingOutboundPeerIds = new Set();

let globalGameState = {
  status: "lobby", // 'lobby' | 'playing' | 'meeting'
  impostors: [],
  globalTasksCompleted: 0,
  globalTasksTotal: 0,
  corpses: [],
  meeting: null // { caller: userId, votes: { [voterId]: targetId }, endsAt: timestamp }
};

module.exports = {
  players,
  localSockets,
  peerDirectory,
  peerConnections,
  pendingOutboundPeerIds,
  globalGameState
};
