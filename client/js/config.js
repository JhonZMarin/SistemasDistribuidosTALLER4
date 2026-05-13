const CONFIG = Object.freeze({
  AUTH_URL: normalizeBaseUrl(window.RUNTIME_CONFIG?.AUTH_URL),
  WS_URL: normalizeBaseUrl(window.RUNTIME_CONFIG?.WS_URL),
  GOOGLE_CLIENT_ID: String(window.RUNTIME_CONFIG?.GOOGLE_CLIENT_ID || "").trim()
});

function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
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

  if (window.location.protocol === "https:" && wsUrl.startsWith("ws://")) {
    return `wss://${wsUrl.slice("ws://".length)}`;
  }

  return wsUrl;
}

function getGoogleClientId() {
  return CONFIG.GOOGLE_CLIENT_ID;
}

window.getAuthBaseUrl = getAuthBaseUrl;
window.getWebSocketBaseUrl = getWebSocketBaseUrl;
window.getGoogleClientId = getGoogleClientId;
window.CONFIG = CONFIG;
