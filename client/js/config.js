const CONFIG = {
  AUTH_URL: "http://localhost:4000",
  WS_URL: "ws://localhost:5000"
};

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function getAuthBaseUrl() {
  return normalizeBaseUrl(CONFIG.AUTH_URL);
}

function getWebSocketBaseUrl() {
  const wsUrl = normalizeBaseUrl(CONFIG.WS_URL);

  // Evita contenido mixto cuando el cliente se publica por HTTPS.
  if (window.location.protocol === "https:" && wsUrl.startsWith("ws://")) {
    return `wss://${wsUrl.slice("ws://".length)}`;
  }

  return wsUrl;
}

window.CONFIG = CONFIG;
window.getAuthBaseUrl = getAuthBaseUrl;
window.getWebSocketBaseUrl = getWebSocketBaseUrl;
