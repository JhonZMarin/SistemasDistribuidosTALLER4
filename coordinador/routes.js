const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const jwt = require("jsonwebtoken");
const { parse } = require("url");

const { 
  COORDINATOR_ID, JWT_SECRET, WORLD, PEER_WS_URL, KILL_DISTANCE 
} = require("./config");
const state = require("./state");
const game = require("./game");
const mesh = require("./mesh");

const publicApp = express();
const publicServer = http.createServer(publicApp);
const publicWss = new WebSocketServer({ noServer: true });

const peerApp = express();
const peerServer = http.createServer(peerApp);
const peerWss = new WebSocketServer({ noServer: true });

publicApp.get("/", (_request, response) => {
  response.json({
    service: "coordinador",
    coordinatorId: COORDINATOR_ID,
    status: "ok",
    connectedPlayers: state.localSockets.size,
    replicatedPlayers: state.players.size,
    peerConnections: Array.from(state.peerConnections.keys()),
    peerUrl: PEER_WS_URL,
    routes: ["/", "/connect", "/peer", "/peers"],
    world: WORLD
  });
});

publicApp.get("/peers", (_request, response) => {
  response.json({
    service: "coordinador",
    coordinatorId: COORDINATOR_ID,
    peers: mesh.listVisiblePeers()
  });
});

peerApp.get("/", (_request, response) => {
  response.json({
    service: "coordinador-peer",
    coordinatorId: COORDINATOR_ID,
    status: "ok",
    peers: Array.from(state.peerConnections.keys())
  });
});

publicServer.on("upgrade", (request, socket, head) => {
  const { pathname, query } = parse(request.url || "", true);

  if (pathname === "/peer") {
    peerWss.handleUpgrade(request, socket, head, (webSocket) => {
      peerWss.emit("connection", webSocket, request);
    });
    return;
  }

  if (pathname !== "/connect") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const token = String(query.token || "").trim();
  if (!token) {
    console.error("Connection rejected: No token provided");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    console.error("Connection rejected: Invalid token", error.message);
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  publicWss.handleUpgrade(request, socket, head, (webSocket) => {
    publicWss.emit("connection", webSocket, request, payload);
  });
});

peerServer.on("upgrade", (request, socket, head) => {
  peerWss.handleUpgrade(request, socket, head, (webSocket) => {
    peerWss.emit("connection", webSocket, request);
  });
});

publicWss.on("connection", (socket, _request, payload) => {
  const userId = String(payload.userId || "").trim();
  const username = String(payload.username || "").trim();
  const provider = String(payload.provider || "local").trim() || "local";

  if (!userId || !username) {
    socket.close(4000, "invalid token payload");
    return;
  }

  const previousSocket = state.localSockets.get(userId);
  if (previousSocket) previousSocket.close(4001, "connection replaced");

  const existing = state.players.get(userId);
  const spawn = existing ? { x: existing.x, y: existing.y } : game.createSpawnPoint(userId);
  const player = {
    userId, username, provider,
    x: spawn.x, y: spawn.y,
    extras: { ...(existing?.extras || {}) },
    intent: game.normalizeDirection(existing?.intent),
    ownerCoordinatorId: COORDINATOR_ID,
    localSocket: socket
  };
  
  delete player.extras.disconnected;

  state.players.set(userId, player);
  state.localSockets.set(userId, socket);

  game.sendWelcome(player);
  mesh.broadcastToPeers(game.buildPlayerJoinedMessage(player));
  game.broadcastState();

  socket.on("message", (rawMessage) => {
    let message;
    try { message = JSON.parse(String(rawMessage)); } catch (error) { return; }

    const currentPlayer = state.players.get(userId);
    if (!currentPlayer || currentPlayer.localSocket !== socket) return;

    if (message.type === "intent") {
      if (message.intent?.type === "move" && state.globalGameState.status === "playing") {
        currentPlayer.intent = game.normalizeDirection(message.intent.dir);
        mesh.broadcastToPeers({
          type: "intent_replicate", origin: COORDINATOR_ID, userId,
          intent: { dir: { ...currentPlayer.intent } }
        });
        game.broadcastState();
        return;
      }

      if (message.intent?.type === "update_extras") {
        const nextExtras = game.sanitizeExtras(message.intent.extras, currentPlayer.extras);
        currentPlayer.extras = nextExtras;
        mesh.broadcastToPeers({
          type: "extras_replicate", origin: COORDINATOR_ID, userId,
          extras: { ...currentPlayer.extras }
        });
        game.broadcastState();
        return;
      }

      if (message.intent?.type === "start_game" && state.globalGameState.status === "lobby") {
        const allIds = Array.from(state.players.keys());
        if (allIds.length > 0) {
          const numImpostors = Math.max(1, Math.min(allIds.length - 1, message.intent.config?.impostors || 1));
          const numTasks = Math.max(1, message.intent.config?.tasks || 4);
          
          state.globalGameState.status = "playing";
          const shuffled = [...allIds].sort(() => 0.5 - Math.random());
          state.globalGameState.impostors = shuffled.slice(0, numImpostors);
          state.globalGameState.globalTasksCompleted = 0;
          state.globalGameState.globalTasksTotal = allIds.length * numTasks;
          state.globalGameState.corpses = [];

          for (const p of state.players.values()) {
             const hash = game.hashString(p.userId);
             p.x = 1450 + (hash % 100); p.y = 1450 + (Math.floor(hash / 97) % 100);
             p.extras = { ...p.extras, isGhost: false, inVent: false };
             if (p.ownerCoordinatorId === COORDINATOR_ID) {
                mesh.broadcastToPeers({ type: "extras_replicate", origin: COORDINATOR_ID, userId: p.userId, extras: { ...p.extras } });
             }
          }

          mesh.broadcastToPeers({ type: "global_state_replicate", origin: COORDINATOR_ID, state: state.globalGameState });
          game.broadcastState();
        }
        return;
      }

      if (message.intent?.type === "kill" && state.globalGameState.status === "playing" && state.globalGameState.impostors?.includes(userId) && !currentPlayer.extras?.isGhost) {
        let nearest = null;
        let minDist = KILL_DISTANCE;
        for (const target of state.players.values()) {
          if (target.userId !== userId && !target.extras?.isGhost) {
            const dist = Math.hypot(target.x - currentPlayer.x, target.y - currentPlayer.y);
            if (dist <= minDist) { minDist = dist; nearest = target; }
          }
        }

        if (nearest) {
          if (nearest.ownerCoordinatorId === COORDINATOR_ID) {
            nearest.extras = { ...nearest.extras, isGhost: true };
            state.globalGameState.corpses.push({ id: nearest.userId, x: nearest.x, y: nearest.y, breed: nearest.extras.breed });
            mesh.broadcastToPeers({ type: "extras_replicate", origin: COORDINATOR_ID, userId: nearest.userId, extras: { ...nearest.extras } });
            mesh.broadcastToPeers({ type: "global_state_replicate", origin: COORDINATOR_ID, state: state.globalGameState });
            game.broadcastState();
            game.checkWinConditions();
          } else {
            mesh.broadcastToPeers({ type: "kill_replicate", origin: COORDINATOR_ID, targetId: nearest.userId });
          }
        }
        return;
      }

      if (message.intent?.type === "vent" && state.globalGameState.status === "playing" && state.globalGameState.impostors?.includes(userId) && !currentPlayer.extras?.isGhost) {
        if (currentPlayer.extras?.inVent) {
          currentPlayer.extras.inVent = false;
        } else {
          for (const vent of WORLD.vents) {
            const dist = Math.hypot(vent.x - currentPlayer.x, vent.y - currentPlayer.y);
            if (dist <= 40) {
              currentPlayer.extras = { ...currentPlayer.extras, inVent: true };
              currentPlayer.x = vent.x; currentPlayer.y = vent.y;
              break;
            }
          }
        }
        mesh.broadcastToPeers({ type: "extras_replicate", origin: COORDINATOR_ID, userId, extras: currentPlayer.extras });
        game.broadcastState();
        return;
      }

      if (message.intent?.type === "do_task" && state.globalGameState.status === "playing" && !state.globalGameState.impostors?.includes(userId) && !currentPlayer.extras?.isGhost) {
        const isNearTask = WORLD.tasks.some(task => {
          const cx = task.x + task.w/2; const cy = task.y + task.h/2;
          return Math.hypot(cx - currentPlayer.x, cy - currentPlayer.y) <= 60;
        });

        if (isNearTask) {
          state.globalGameState.globalTasksCompleted = (state.globalGameState.globalTasksCompleted || 0) + 1;
          mesh.broadcastToPeers({ type: "global_state_replicate", origin: COORDINATOR_ID, state: state.globalGameState });
          game.broadcastState();
          game.checkWinConditions();
        }
        return;
      }

      if (message.intent?.type === "call_meeting" && state.globalGameState.status === "playing" && !currentPlayer.extras?.isGhost) {
        const btn = WORLD.emergencyButton;
        const isNearButton = Math.hypot((btn.x + btn.w/2) - currentPlayer.x, (btn.y + btn.h/2) - currentPlayer.y) <= 60;
        
        let isNearCorpse = false;
        if (!isNearButton) {
           for (const p of state.players.values()) {
             if (p.extras?.isGhost && p.userId !== currentPlayer.userId) {
               if (Math.hypot(p.x - currentPlayer.x, p.y - currentPlayer.y) <= 80) { isNearCorpse = true; break; }
             }
           }
        }

        if (isNearButton || isNearCorpse) {
          state.globalGameState.status = "meeting";
          state.globalGameState.meeting = { caller: userId, votes: {}, endsAt: Date.now() + 30000 };
          state.globalGameState.corpses = [];
          
          for (const p of state.players.values()) {
            const hash = game.hashString(p.userId);
            p.x = 700 + (hash % 200); p.y = 150 + (Math.floor(hash / 97) % 70);
            if (p.ownerCoordinatorId === COORDINATOR_ID && p.extras?.inVent) {
               p.extras = { ...p.extras, inVent: false };
               mesh.broadcastToPeers({ type: "extras_replicate", origin: COORDINATOR_ID, userId: p.userId, extras: p.extras });
            }
          }
          mesh.broadcastToPeers({ type: "global_state_replicate", origin: COORDINATOR_ID, state: state.globalGameState });
          game.broadcastState();
        }
        return;
      }

      if (message.intent?.type === "vote" && state.globalGameState.status === "meeting" && !currentPlayer.extras?.isGhost) {
        if (state.globalGameState.meeting && !state.globalGameState.meeting.votes[userId]) {
          state.globalGameState.meeting.votes[userId] = message.intent.targetId || "skip";
          
          let alivePlayersCount = 0;
          for (const p of state.players.values()) { if (!p.extras?.isGhost) alivePlayersCount++; }
          const votesCount = Object.keys(state.globalGameState.meeting.votes).length;

          if (votesCount >= alivePlayersCount) {
             game.endMeeting();
          } else {
             mesh.broadcastToPeers({ type: "global_state_replicate", origin: COORDINATOR_ID, state: state.globalGameState });
             game.broadcastState();
          }
        }
        game.checkWinConditions();
        return;
      }

      if (message.intent?.type === "chat" && state.globalGameState.status === "meeting" && !currentPlayer.extras?.isGhost) {
        const text = String(message.intent.text || "").trim().slice(0, 100);
        if (!text) return;
        const now = Date.now();
        const lastChat = currentPlayer.extras?.lastChatTime || 0;
        if (now - lastChat < 2000) return;

        currentPlayer.extras.lastChatTime = now;
        const chatMessage = { type: "chat_replicate", origin: COORDINATOR_ID, userId: currentPlayer.userId, username: currentPlayer.username, text };
        mesh.broadcastToPeers(chatMessage);
        
        const payloadStr = JSON.stringify(chatMessage);
        for (const ws of state.localSockets.values()) {
          if (ws.readyState === WebSocket.OPEN) ws.send(payloadStr);
        }
        return;
      }
    }
  });

  socket.on("close", () => game.removeLocalPlayerIfCurrent(userId, socket));
  socket.on("error", () => game.removeLocalPlayerIfCurrent(userId, socket));
});

peerWss.on("connection", (socket) => {
  mesh.attachPeerSocket(socket, "inbound");
});

module.exports = { publicServer, peerServer };
