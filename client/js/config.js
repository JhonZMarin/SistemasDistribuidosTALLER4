const CONFIG = Object.freeze({
  AUTH_URL: normalizeBaseUrl(window.RUNTIME_CONFIG && window.RUNTIME_CONFIG.AUTH_URL),
  WS_URL: normalizeBaseUrl(window.RUNTIME_CONFIG && window.RUNTIME_CONFIG.WS_URL)
});

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function readConfiguredUrl(key) {
  const value = CONFIG[key];

  if (!value) {
    throw new Error(`Missing runtime configuration for ${key}`);
  }

  return value;
}

function getAuthBaseUrl() {
  return readConfiguredUrl("AUTH_URL");
}

function getWebSocketBaseUrl() {
  const wsUrl = readConfiguredUrl("WS_URL");

  // Evita contenido mixto cuando el cliente se publica por HTTPS.
  if (window.location.protocol === "https:" && wsUrl.startsWith("ws://")) {
    return `wss://${wsUrl.slice("ws://".length)}`;
  }

  return wsUrl;
}

function getAuthBaseUrl() {
  const url = window.RUNTIME_CONFIG?.AUTH_URL || "";
  return url.replace(/\/+$/, "");
}

function getWebSocketBaseUrl() {
  const wsUrl = window.RUNTIME_CONFIG?.WS_URL || "";
  let finalUrl = wsUrl.replace(/\/+$/, "");

  // Evita contenido mixto si el cliente está en HTTPS (Ngrok)
  if (window.location.protocol === "https:" && finalUrl.startsWith("ws://")) {
    return `wss://${finalUrl.slice("ws://".length)}`;
  }

  return finalUrl;
}

window.getAuthBaseUrl = getAuthBaseUrl;
window.getWebSocketBaseUrl = getWebSocketBaseUrl;

window.CONFIG = CONFIG;

