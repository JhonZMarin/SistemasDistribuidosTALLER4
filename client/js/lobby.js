import { createGame } from "./game.js";

window.currentGameState = { players: [] };

let socket = null;
let game = null;
let myUserId = null;
let reconnectTimerId = null;
let manualLogout = false;
let currentCoordinator = null;

function setConnectionStatus(message, variant) {
    const element = document.getElementById("connection-status");
    if (!element) return;

    element.textContent = message;
    element.className = "status-badge";
    element.classList.add(`status-badge--${variant}`);
}

function setCoordinatorMeta(coordinator) {
    const idElement = document.getElementById("coordinator-id");
    const urlElement = document.getElementById("coordinator-url");

    if (idElement) {
        idElement.textContent = coordinator?.coordinatorId || "Sin asignar";
    }

    if (urlElement) {
        urlElement.textContent = coordinator?.publicUrl || "Esperando asignacion...";
    }
}

function clearReconnectTimer() {
    if (reconnectTimerId !== null) {
        clearTimeout(reconnectTimerId);
        reconnectTimerId = null;
    }
}

function destroyGame() {
    if (!game) return;
    game.destroy();
    game = null;
}

function detachSocket() {
    if (!socket) return;

    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket = null;
}

function closeSocketSilently() {
    if (!socket) return;

    const previousSocket = socket;
    detachSocket();

    if (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING) {
        previousSocket.close();
    }
}

function scheduleReconnect(delayMs = 1500) {
    if (manualLogout) return;

    clearReconnectTimer();
    reconnectTimerId = window.setTimeout(() => {
        connectThroughDirectory().catch(() => {
            scheduleReconnect(2000);
        });
    }, delayMs);
}

async function resolveCoordinator() {
    setConnectionStatus("Resolviendo coordinador...", "connecting");

    const assignment = await window.requestCoordinatorAssignment();

    if (!assignment.ok) {
        currentCoordinator = null;
        setCoordinatorMeta(null);

        if (assignment.status === 503 || assignment.error === "no_coordinators_available") {
            setConnectionStatus("No hay coordinadores vivos disponibles.", "error");
        } else {
            setConnectionStatus("No se pudo consultar el coordinador.", "error");
        }

        return null;
    }

    currentCoordinator = assignment;
    setCoordinatorMeta(assignment);
    return assignment;
}

function ensureGame(worldConfig) {
    destroyGame();

    game = createGame({
        canvas: document.getElementById("gameCanvas"),
        localPlayerId: myUserId,
        options: {
            worldWidth: worldConfig.width,
            worldHeight: worldConfig.height,
            playerRadius: worldConfig.playerRadius
        },
        onIntent: (intent) => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "intent", intent }));
            }
        },
        getRenderState: () => window.currentGameState
    });

    game.start();
}

async function connectThroughDirectory() {
    clearReconnectTimer();

    const token = window.getStoredToken?.();
    if (!token) {
        window.location.href = "login.html";
        return;
    }

    closeSocketSilently();
    window.currentGameState = { players: [] };
    updatePlayersUI([]);

    const coordinator = await resolveCoordinator();
    if (!coordinator) {
        scheduleReconnect(2000);
        return;
    }

    const targetUrl = `${coordinator.publicUrl}/connect?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(targetUrl);
    socket = ws;

    setConnectionStatus(`Conectando a ${coordinator.coordinatorId}...`, "connecting");

    ws.onopen = () => {
        if (socket !== ws) return;
        setConnectionStatus(`Conectado a ${coordinator.coordinatorId}`, "connected");
    };

    ws.onmessage = (event) => {
        if (socket !== ws) return;

        const msg = JSON.parse(event.data);

        if (msg.type === "welcome") {
            myUserId = msg.you.userId;
            setCoordinatorMeta({
                coordinatorId: msg.coordinatorId || coordinator.coordinatorId,
                publicUrl: coordinator.publicUrl
            });
            ensureGame(msg.world);
            return;
        }

        if (msg.type === "state") {
            window.currentGameState = msg;
            updatePlayersUI(msg.players);
        }
    };

    ws.onerror = () => {
        if (socket !== ws) return;
        setConnectionStatus(`Error conectando a ${coordinator.coordinatorId}`, "error");
    };

    ws.onclose = () => {
        if (socket !== ws) return;

        detachSocket();
        destroyGame();
        setConnectionStatus("Conexion perdida. Reasignando coordinador...", "connecting");
        scheduleReconnect(1200);
    };
}

window.updateMood = (emoji) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
        const currentExtras = window.currentGameState.players.find((player) => player.userId === myUserId)?.extras || {};

        socket.send(JSON.stringify({
            type: "extras_update",
            extras: { ...currentExtras, mood: emoji }
        }));
    }
};

function updatePlayersUI(players) {
    const list = document.getElementById("players-list");
    if (!list) return;

    if (!Array.isArray(players) || !players.length) {
        list.innerHTML = '<li class="players-list__empty">Esperando jugadores en el radar...</li>';
        return;
    }

    list.innerHTML = players.map((player) => {
        const badge = player.provider === "google" ? "G" : "L";
        const mood = player.extras?.mood || "";
        const isCurrent = player.userId === myUserId;

        return `
            <li class="players-list__item ${isCurrent ? "players-list__item--current" : ""}">
                <div class="players-list__avatar">${badge}</div>
                <div class="players-list__content">
                    <span class="players-list__name">${player.username} ${mood} ${isCurrent ? "(Tu)" : ""}</span>
                    <span class="players-list__meta">Auth: ${player.provider} | Coord: ${player.coordinatorId || "n/a"}</span>
                </div>
            </li>
        `;
    }).join("");
}

function handleLogout() {
    manualLogout = true;
    clearReconnectTimer();
    closeSocketSilently();
    destroyGame();
    window.clearStoredSession?.();
    localStorage.removeItem("username");
    window.location.href = "login.html";
}

function initLobbyPage() {
    const logoutButton = document.getElementById("logout-button");
    if (logoutButton) {
        logoutButton.onclick = handleLogout;
    }

    connectThroughDirectory().catch(() => {
        scheduleReconnect(2000);
    });
}

document.addEventListener("DOMContentLoaded", initLobbyPage);
