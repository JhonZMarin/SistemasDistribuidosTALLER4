let lobbySocket = null;
let logoutRequested = false;
let pageUnloading = false;
let sessionFinished = false;
let currentLobbyUsername = "";

function redirectToLogin() {
  window.location.replace("./login.html");
}

function updateConnectionStatus(message, variant) {
  const statusElement = document.getElementById("connection-status");

  if (!statusElement) {
    return;
  }

  statusElement.textContent = message;
  statusElement.classList.remove(
    "status-badge--connecting",
    "status-badge--connected",
    "status-badge--disconnected",
    "status-badge--error"
  );

  statusElement.classList.add(`status-badge--${variant}`);
}

function updatePlayersCount(count) {
  const playersCountElement = document.getElementById("players-count");

  if (!playersCountElement) {
    return;
  }

  const safeCount = Number.isFinite(count) && count > 0 ? count : 0;
  const label = safeCount === 1 ? "piloto" : "pilotos";
  playersCountElement.textContent = `${safeCount} ${label}`;
}

function buildCallsign(username) {
  const compactName = String(username || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 2)
    .toUpperCase();

  return compactName || "??";
}

function renderPlayers(players) {
  const listElement = document.getElementById("players-list");

  if (!listElement) {
    return;
  }

  listElement.innerHTML = "";

  if (!Array.isArray(players) || players.length === 0) {
    updatePlayersCount(0);
    const emptyItem = document.createElement("li");
    emptyItem.className = "players-list__empty";
    emptyItem.textContent = "No hay pilotos en linea. Esperando una nueva senal del coordinador.";
    listElement.appendChild(emptyItem);
    return;
  }

  updatePlayersCount(players.length);

  players.forEach((player, index) => {
    const username = player && typeof player.username === "string"
      ? player.username
      : "Jugador sin nombre";
    const isCurrentPlayer = username === currentLobbyUsername;
    const item = document.createElement("li");
    item.className = isCurrentPlayer
      ? "players-list__item players-list__item--current"
      : "players-list__item";

    const avatar = document.createElement("span");
    avatar.className = "players-list__avatar";
    avatar.textContent = buildCallsign(username);

    const content = document.createElement("div");
    content.className = "players-list__content";

    const name = document.createElement("span");
    name.className = "players-list__name";
    name.textContent = username;

    const meta = document.createElement("span");
    meta.className = "players-list__meta";
    meta.textContent = isCurrentPlayer
      ? "Tu cabina esta enlazada al radar"
      : `Piloto ${String(index + 1).padStart(2, "0")} en linea`;

    const signal = document.createElement("span");
    signal.className = "players-list__signal";
    signal.textContent = isCurrentPlayer ? "Tu" : "En linea";

    content.append(name, meta);
    item.append(avatar, content, signal);
    listElement.appendChild(item);
  });
}

function finishSession(options) {
  const settings = options || {};

  if (sessionFinished) {
    return;
  }

  sessionFinished = true;
  window.AuthStorage.clearSession();

  if (settings.message) {
    window.AuthStorage.saveSessionNotice(settings.message, settings.messageType || "error");
  }

  redirectToLogin();
}

function resolveCloseMessage(event) {
  if (event && event.code === 4001) {
    return "Tu sesion es invalida o vencio. Inicia sesion nuevamente.";
  }

  return "La conexion con el coordinador se cerro y tu sesion finalizo.";
}

function handleSocketClose(event) {
  if (logoutRequested || pageUnloading) {
    return;
  }

  const closeMessage = resolveCloseMessage(event);

  window.setUiMessage(
    document.getElementById("lobby-message"),
    closeMessage,
    "error"
  );
  updateConnectionStatus("Desconectado", "disconnected");

  finishSession({
    message: closeMessage,
    messageType: "error"
  });
}

function buildSocketUrl(token) {
  return `${window.getWebSocketBaseUrl()}/connect?token=${encodeURIComponent(token)}`;
}

function connectToLobby(token) {
  try {
    lobbySocket = new WebSocket(buildSocketUrl(token));
  } catch (error) {
    updateConnectionStatus("Error de conexion", "error");
    window.setUiMessage(
      document.getElementById("lobby-message"),
      "No fue posible abrir la conexion en tiempo real.",
      "error"
    );
    finishSession({
      message: "No fue posible conectarte al coordinador. Inicia sesion de nuevo.",
      messageType: "error"
    });
    return;
  }

  updateConnectionStatus("Conectando...", "connecting");
  window.setUiMessage(
    document.getElementById("lobby-message"),
    "Conectando con el coordinador...",
    "info"
  );

  lobbySocket.onopen = () => {
    updateConnectionStatus("Conectado", "connected");
    window.setUiMessage(
      document.getElementById("lobby-message"),
      "Conexion activa. Esperando actualizaciones de jugadores.",
      "success"
    );
  };

  lobbySocket.onmessage = (event) => {
    let payload;

    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    if (payload.type === "players_update") {
      renderPlayers(payload.players);
    }
  };

  lobbySocket.onerror = () => {
    updateConnectionStatus("Error de conexion", "error");
    window.setUiMessage(
      document.getElementById("lobby-message"),
      "Se perdio la comunicacion con el coordinador.",
      "error"
    );

    if (lobbySocket && lobbySocket.readyState < WebSocket.CLOSING) {
      lobbySocket.close();
      return;
    }

    handleSocketClose();
  };

  lobbySocket.onclose = (event) => {
    handleSocketClose(event);
  };
}

function logout() {
  logoutRequested = true;
  updateConnectionStatus("Desconectando...", "disconnected");

  if (lobbySocket && (
    lobbySocket.readyState === WebSocket.OPEN ||
    lobbySocket.readyState === WebSocket.CONNECTING
  )) {
    lobbySocket.close();
  }

  window.AuthStorage.clearSession();
  redirectToLogin();
}

function initializeLobbyPage() {
  if (!document.body || document.body.dataset.page !== "lobby") {
    return;
  }

  const token = window.AuthStorage.getStoredToken();
  const username = window.AuthStorage.getStoredUsername();
  const usernameElement = document.getElementById("current-username");
  const logoutButton = document.getElementById("logout-button");

  if (!token) {
    redirectToLogin();
    return;
  }

  if (usernameElement) {
    usernameElement.textContent = username || "Usuario";
  }

  currentLobbyUsername = username || "";

  if (logoutButton) {
    logoutButton.addEventListener("click", logout);
  }

  renderPlayers([]);
  connectToLobby(token);
}

window.addEventListener("beforeunload", () => {
  pageUnloading = true;

  if (lobbySocket && lobbySocket.readyState === WebSocket.OPEN) {
    lobbySocket.close();
  }
});

document.addEventListener("DOMContentLoaded", initializeLobbyPage);
