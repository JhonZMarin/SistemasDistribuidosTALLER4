function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function normalizeUrlList(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim());

  return rawItems
    .map((item) => normalizeBaseUrl(item))
    .filter(Boolean);
}

const runtimeAuthUrls = normalizeUrlList(
  window.RUNTIME_CONFIG?.AUTH_URLS || window.RUNTIME_CONFIG?.AUTH_URL
);

const CONFIG = Object.freeze({
  AUTH_URLS: runtimeAuthUrls,
  AUTH_URL: runtimeAuthUrls[0] || "",
  WS_URL: normalizeBaseUrl(window.RUNTIME_CONFIG?.WS_URL),
  GOOGLE_CLIENT_ID: String(window.RUNTIME_CONFIG?.GOOGLE_CLIENT_ID || "").trim()
});

function readConfiguredUrl(key) {
  const value = CONFIG[key];

  if (!value) {
    throw new Error(`Missing runtime configuration for ${key}`);
  }

  return value;
}

function getAuthUrls() {
  return [...CONFIG.AUTH_URLS];
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

window.getAuthUrls = getAuthUrls;
window.getAuthBaseUrl = getAuthBaseUrl;
window.getWebSocketBaseUrl = getWebSocketBaseUrl;
window.getGoogleClientId = getGoogleClientId;
window.CONFIG = CONFIG;
