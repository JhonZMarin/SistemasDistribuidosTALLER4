import { createGame } from "./game.js";

window.currentGameState = { players: [] };

let socket = null;
let game = null;
let myUserId = null;
let reconnectTimerId = null;
let manualLogout = false;
let currentCoordinator = null;
const COORDINATOR_FAILOVER_DELAY_MS = 7000;
const FAILED_COORDINATOR_AVOID_MS = 12000;
let lastFailedCoordinator = null;

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

function rememberFailedCoordinator(coordinator) {
    if (!coordinator?.coordinatorId || !coordinator?.publicUrl) {
        return;
    }

    lastFailedCoordinator = {
        coordinatorId: coordinator.coordinatorId,
        publicUrl: coordinator.publicUrl,
        failedAt: Date.now()
    };
}

function shouldAvoidCoordinator(coordinator) {
    if (!coordinator || !lastFailedCoordinator) {
        return false;
    }

    if (
        coordinator.coordinatorId !== lastFailedCoordinator.coordinatorId
        && coordinator.publicUrl !== lastFailedCoordinator.publicUrl
    ) {
        return false;
    }

    return (Date.now() - lastFailedCoordinator.failedAt) < FAILED_COORDINATOR_AVOID_MS;
}

function clearFailedCoordinator(coordinator) {
    if (!lastFailedCoordinator || !coordinator) {
        return;
    }

    if (
        coordinator.coordinatorId === lastFailedCoordinator.coordinatorId
        || coordinator.publicUrl === lastFailedCoordinator.publicUrl
    ) {
        lastFailedCoordinator = null;
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

    if (typeof window.requestCoordinatorAssignment !== "function") {
        currentCoordinator = null;
        setCoordinatorMeta(null);
        setConnectionStatus("El cliente cargo una version vieja. Recarga la pagina.", "error");
        return null;
    }

    const assignment = await window.requestCoordinatorAssignment();

    if (!assignment.ok) {
        currentCoordinator = null;
        setCoordinatorMeta(null);

        if (assignment.status === 503 || assignment.error === "no_coordinators_available") {
            setConnectionStatus("No hay coordinadores vivos disponibles.", "error");
        } else if (assignment.error === "coordinator_lookup_timeout") {
            setConnectionStatus("La consulta al auth expiro. Intenta de nuevo.", "error");
        } else {
            setConnectionStatus("No se pudo consultar el coordinador.", "error");
        }

        return null;
    }

    currentCoordinator = assignment;
    setCoordinatorMeta(assignment);

    if (shouldAvoidCoordinator(assignment)) {
        currentCoordinator = null;
        setConnectionStatus("Esperando que el auth retire el coordinador caido...", "connecting");
        return null;
    }

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
            playerRadius: worldConfig.playerRadius,
            walls: worldConfig.walls || [],
            vents: worldConfig.vents || [],
            vitals: worldConfig.vitals || null,
            tasks: worldConfig.tasks || [],
            emergencyButton: worldConfig.emergencyButton || null
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

    let coordinator;

    try {
        coordinator = await resolveCoordinator();
    } catch (error) {
        setConnectionStatus("Error interno del lobby. Recargando asignacion...", "error");
        scheduleReconnect(2000);
        return;
    }

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
            window.currentWorldConfig = msg.world; // Guardar config para distance checks
            clearFailedCoordinator(coordinator);
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
            updateGameStateUI();
            return;
        }

        if (msg.type === "chat_replicate") {
            const chatBox = document.getElementById("chat-messages");
            if (chatBox) {
                const isMe = msg.userId === myUserId;
                const nameStr = isMe ? 'Tú' : (msg.username || 'Desconocido');
                const color = isMe ? 'var(--amber)' : 'var(--cyan)';
                chatBox.innerHTML += `<div style="margin-bottom: 4px;"><strong style="color: ${color};">${nameStr}:</strong> ${msg.text}</div>`;
                chatBox.scrollTop = chatBox.scrollHeight;
            }
            return;
        }
    };

    ws.onerror = () => {
        if (socket !== ws) return;
        setConnectionStatus(`Error conectando a ${coordinator.coordinatorId}`, "error");
    };

    ws.onclose = () => {
        if (socket !== ws) return;

        rememberFailedCoordinator(coordinator);
        detachSocket();
        destroyGame();
        setConnectionStatus("Conexion perdida. Esperando failover del coordinador...", "connecting");
        scheduleReconnect(COORDINATOR_FAILOVER_DELAY_MS);
    };
}

document.addEventListener("DOMContentLoaded", () => {
    const btnStart = document.getElementById("btn-start-game");
    const btnKill = document.getElementById("btn-kill");
    const btnVent = document.getElementById("btn-vent");
    const btnTask = document.getElementById("btn-task");
    const btnVitals = document.getElementById("btn-vitals");
    const btnCallMeeting = document.getElementById("btn-call-meeting");
    const btnVoteSkip = document.getElementById("btn-vote-skip");
    const btnSendChat = document.getElementById("btn-send-chat");
    const chatInput = document.getElementById("chat-input");

    if (btnStart) {
        btnStart.onclick = () => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "intent", intent: { type: "start_game" } }));
            }
        };
    }

    if (btnKill) {
        btnKill.onclick = () => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "intent", intent: { type: "kill" } }));
            }
        };
    }

    if (btnVent) {
        btnVent.onclick = () => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "intent", intent: { type: "vent" } }));
            }
        };
    }

    if (btnTask) {
        btnTask.onclick = () => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "intent", intent: { type: "do_task" } }));
            }
        };
    }

    if (btnVitals) {
        btnVitals.onclick = () => {
            const modal = document.getElementById("vitals-modal");
            const list = document.getElementById("vitals-list");
            if (modal && list && window.currentGameState?.players) {
                list.innerHTML = window.currentGameState.players.map(p => {
                    const isDead = p.extras?.isGhost;
                    const color = isDead ? "var(--danger)" : "var(--cyan)";
                    const text = isDead ? "💀 MUERTO" : "💚 VIVO";
                    return `
                        <li class="players-list__item">
                            <div class="players-list__content" style="display: flex; justify-content: space-between; width: 100%;">
                                <span class="players-list__name">${p.username}</span>
                                <span style="color: ${color}; font-weight: bold;">${text}</span>
                            </div>
                        </li>
                    `;
                }).join("");
                modal.showModal();
            }
        };
    }
    if (btnCallMeeting) {
        btnCallMeeting.onclick = () => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "intent", intent: { type: "call_meeting" } }));
            }
        };
    }

    if (btnVoteSkip) {
        btnVoteSkip.onclick = () => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "intent", intent: { type: "vote", targetId: "skip" } }));
                document.getElementById("voting-modal").close();
            }
        };
    }

    if (btnSendChat && chatInput) {
        const sendChat = () => {
            const text = chatInput.value.trim();
            if (text && socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "intent", intent: { type: "chat", text } }));
                chatInput.value = "";
            }
        };
        btnSendChat.onclick = sendChat;
        chatInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter") sendChat();
        });
    }
});
function submitVote(targetId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "intent", intent: { type: "vote", targetId } }));
        document.getElementById("voting-modal").close();
    }
}
window.submitVote = submitVote;

function updateGameStateUI() {
    const gameState = window.currentGameState?.gameState;
    const statusEl = document.getElementById("game-status");
    const lobbyControls = document.getElementById("lobby-controls");
    const playingControls = document.getElementById("playing-controls");
    const roleDisplay = document.getElementById("role-display");
    const impostorActions = document.getElementById("impostor-actions");
    const crewmateActions = document.getElementById("crewmate-actions");
    const btnTask = document.getElementById("btn-task");
    const btnVitals = document.getElementById("btn-vitals");
    const btnCallMeeting = document.getElementById("btn-call-meeting");
    const votingModal = document.getElementById("voting-modal");

    if (!gameState || gameState.status === "lobby") {
        if (statusEl) statusEl.textContent = "Estado: Lobby";
        if (lobbyControls) lobbyControls.style.display = "block";
        if (playingControls) playingControls.style.display = "none";
        if (votingModal && votingModal.open) {
            votingModal.close();
            document.getElementById("chat-messages").innerHTML = ""; // Clear chat on end
        }
    } else if (gameState.status === "playing") {
        if (statusEl) statusEl.textContent = "Estado: Jugando";
        if (lobbyControls) lobbyControls.style.display = "none";
        if (playingControls) playingControls.style.display = "flex";
        if (votingModal && votingModal.open) {
            votingModal.close();
            document.getElementById("chat-messages").innerHTML = "";
        }

        const isImpostor = gameState.impostorId === myUserId;
        const myPlayer = window.currentGameState?.players?.find(p => p.userId === myUserId);
        const isGhost = myPlayer?.extras?.isGhost;
        const globalTasks = gameState.globalTasksCompleted || 0;

        if (roleDisplay) {
            if (isGhost) {
                roleDisplay.textContent = isImpostor ? "FANTASMA (Impostor)" : `FANTASMA (Progreso Global: ${globalTasks})`;
                roleDisplay.style.color = "var(--muted)";
            } else if (isImpostor) {
                roleDisplay.textContent = "ROL: IMPOSTOR";
                roleDisplay.style.color = "var(--danger)";
            } else {
                roleDisplay.textContent = `ROL: TRIPULANTE (Progreso Global: ${globalTasks})`;
                roleDisplay.style.color = "var(--cyan)";
            }
        }

        if (impostorActions) {
            impostorActions.style.display = (isImpostor && !isGhost) ? "flex" : "none";
        }
        
        if (crewmateActions) {
            crewmateActions.style.display = (!isImpostor && !isGhost) ? "flex" : "none";
        }

        // Distance checks
        let nearTask = false;
        let nearVitals = false;
        let nearEmergency = false;
        if (myPlayer && window.currentWorldConfig) {
            const wc = window.currentWorldConfig;
            if (wc.tasks) {
                nearTask = wc.tasks.some(t => Math.hypot((t.x + t.w/2) - myPlayer.x, (t.y + t.h/2) - myPlayer.y) <= 60);
            }
            if (wc.vitals) {
                nearVitals = Math.hypot((wc.vitals.x + wc.vitals.w/2) - myPlayer.x, (wc.vitals.y + wc.vitals.h/2) - myPlayer.y) <= 80;
            }
            if (wc.emergencyButton) {
                nearEmergency = Math.hypot((wc.emergencyButton.x + wc.emergencyButton.w/2) - myPlayer.x, (wc.emergencyButton.y + wc.emergencyButton.h/2) - myPlayer.y) <= 60;
            }
        }

        if (btnTask) btnTask.style.display = nearTask && !isImpostor && !isGhost ? "block" : "none";
        if (btnVitals) btnVitals.style.display = nearVitals ? "block" : "none";
        if (btnCallMeeting) btnCallMeeting.style.display = nearEmergency && !isGhost ? "block" : "none";

    } else if (gameState.status === "meeting") {
        if (statusEl) statusEl.textContent = "Estado: Reunión Activa";
        if (lobbyControls) lobbyControls.style.display = "none";
        if (playingControls) playingControls.style.display = "flex";

        const myPlayer = window.currentGameState?.players?.find(p => p.userId === myUserId);
        const isGhost = myPlayer?.extras?.isGhost;

        if (btnCallMeeting) btnCallMeeting.style.display = "none";
        if (btnTask) btnTask.style.display = "none";
        if (btnVitals) btnVitals.style.display = "none";

        if (votingModal && !votingModal.open) {
            // Render voting list
            const caller = window.currentGameState.players.find(p => p.userId === gameState.meeting?.caller);
            document.getElementById("meeting-caller").textContent = `Convocada por: ${caller ? caller.username : 'Desconocido'}`;
            
            const list = document.getElementById("voting-list");
            list.innerHTML = window.currentGameState.players.filter(p => !p.extras?.isGhost).map(p => {
                const isMe = p.userId === myUserId;
                return `
                    <li class="players-list__item" style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" 
                        onclick="${isGhost ? '' : `submitVote('${p.userId}')`}">
                        <span>${p.username} ${isMe ? '(Tú)' : ''}</span>
                        ${!isGhost ? '<span style="font-size: 0.8rem; color: var(--muted);">Votar</span>' : ''}
                    </li>
                `;
            }).join("");

            if (isGhost) {
                document.getElementById("btn-vote-skip").style.display = "none";
                const chatInput = document.getElementById("chat-input");
                const btnSendChat = document.getElementById("btn-send-chat");
                if (chatInput) { chatInput.disabled = true; chatInput.placeholder = "Los fantasmas no pueden chatear"; }
                if (btnSendChat) btnSendChat.disabled = true;
            } else {
                document.getElementById("btn-vote-skip").style.display = "block";
                const chatInput = document.getElementById("chat-input");
                const btnSendChat = document.getElementById("btn-send-chat");
                if (chatInput) { chatInput.disabled = false; chatInput.placeholder = "Mensaje..."; }
                if (btnSendChat) btnSendChat.disabled = false;
            }

            votingModal.showModal();
        }

        if (votingModal && votingModal.open) {
            const timeLeft = Math.max(0, Math.floor((gameState.meeting.endsAt - Date.now()) / 1000));
            document.getElementById("meeting-timer").textContent = `Tiempo restante: ${timeLeft}s`;
        }
    }
}

function updatePlayersUI(players) {
    const list = document.getElementById("players-list");
    if (!list) return;

    if (!Array.isArray(players) || !players.length) {
        list.innerHTML = '<li class="players-list__empty">Esperando jugadores en el radar...</li>';
        return;
    }

    list.innerHTML = players.map((player) => {
        const badge = player.provider === "google" ? "G" : "L";
        const isGhost = player.extras?.isGhost;
        const isCurrent = player.userId === myUserId;
        const status = isGhost ? "👻 Muerto" : "Vivo";

        return `
            <li class="players-list__item ${isCurrent ? "players-list__item--current" : ""}" style="${isGhost ? 'opacity: 0.6;' : ''}">
                <div class="players-list__avatar">${badge}</div>
                <div class="players-list__content">
                    <span class="players-list__name" style="${isGhost ? 'text-decoration: line-through;' : ''}">${player.username} ${isCurrent ? "(Tu)" : ""}</span>
                    <span class="players-list__meta">Auth: ${player.provider} | Coord: ${player.coordinatorId || "n/a"} | ${status}</span>
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
