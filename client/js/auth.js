const AUTH_STORAGE_KEYS = Object.freeze({
    token: "token",
    username: "username"
});

const GOOGLE_USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;
const AUTH_REQUEST_TIMEOUT_MS = 10000;

let googleInitialized = false;
let pendingGoogleIdToken = null;
let lastAuthUrlUsed = null;

function normalizeBaseUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
}

function getAuthUrls() {
    const urls = Array.isArray(window.getAuthUrls?.()) ? window.getAuthUrls() : [];

    if (urls.length) {
        return urls.map((url) => normalizeBaseUrl(url)).filter(Boolean);
    }

    const fallback = normalizeBaseUrl(window.getAuthBaseUrl?.());
    return fallback ? [fallback] : [];
}

function buildAuthUrl(baseUrl, path) {
    return `${normalizeBaseUrl(baseUrl)}${path}`;
}

function isLocalHostUrl(url) {
    try {
        const { hostname } = new URL(url);
        return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch (error) {
        return false;
    }
}

function canFollowLeaderUrl(url) {
    if (!url) return false;

    const pageHost = window.location.hostname;
    const pageIsLocal = pageHost === "localhost" || pageHost === "127.0.0.1" || pageHost === "::1";

    return pageIsLocal || !isLocalHostUrl(url);
}

function buildAuthHeaders(includeJsonContentType = false) {
    const headers = {
        "Accept": "application/json",
        "ngrok-skip-browser-warning": "1"
    };

    if (includeJsonContentType) {
        headers["Content-Type"] = "application/json";
    }

    return headers;
}

async function readJsonSafely(response) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return null;

    try {
        return await response.json();
    } catch (error) {
        return null;
    }
}

async function fetchWithTimeout(resource, options, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return fetch(resource, options);
    }

    let timeoutId = null;

    try {
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = window.setTimeout(() => {
                const error = new Error("request_timeout");
                error.name = "TimeoutError";
                reject(error);
            }, timeoutMs);
        });

        return await Promise.race([
            fetch(resource, options),
            timeoutPromise
        ]);
    } finally {
        if (timeoutId !== null) {
            window.clearTimeout(timeoutId);
        }
    }
}

async function fetchJsonWithFallback(path, { method = "POST", payload = null, expectBody = true, signal = undefined, timeoutMs = AUTH_REQUEST_TIMEOUT_MS } = {}) {
    const urls = getAuthUrls();
    const tried = new Set();
    const queue = [...urls];

    while (queue.length) {
        const baseUrl = normalizeBaseUrl(queue.shift());

        if (!baseUrl || tried.has(baseUrl)) {
            continue;
        }

        tried.add(baseUrl);

        try {
            const response = await fetchWithTimeout(buildAuthUrl(baseUrl, path), {
                method,
                headers: buildAuthHeaders(Boolean(payload)),
                body: payload ? JSON.stringify(payload) : undefined,
                signal
            }, timeoutMs);
            const data = expectBody ? await readJsonSafely(response) : null;

            if (response.ok) {
                if (expectBody && data === null) {
                    continue;
                }

                lastAuthUrlUsed = baseUrl;
                return { ok: true, status: response.status, data, authUrl: baseUrl };
            }

            const leaderUrl = normalizeBaseUrl(data?.leaderUrl);
            if (
                response.status === 503
                && data?.error === "not_leader"
                && canFollowLeaderUrl(leaderUrl)
                && !tried.has(leaderUrl)
            ) {
                queue.unshift(leaderUrl);
                continue;
            }

            if (response.status >= 500 || response.status === 503) {
                continue;
            }

            lastAuthUrlUsed = baseUrl;
            return { ok: false, status: response.status, data, authUrl: baseUrl };
        } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") {
                throw error;
            }

            if (error?.name === "TimeoutError") {
                continue;
            }

            continue;
        }
    }

    return { ok: false, status: 0, data: null, authUrl: null };
}

function validateCredentials(username, password) {
    const cleanUsername = String(username || "").trim();
    const cleanPassword = String(password || "");

    if (!cleanUsername || !cleanPassword) {
        return { ok: false, message: "Ingresa username y password." };
    }

    return { ok: true, username: cleanUsername, password: cleanPassword };
}

function validateGoogleUsername(username) {
    const cleanUsername = String(username || "").trim();

    if (!cleanUsername) {
        return { ok: false, message: "Ingresa un username para continuar con Google." };
    }
    if (cleanUsername.length < 3 || cleanUsername.length > 32) {
        return { ok: false, message: "El username debe tener entre 3 y 32 caracteres." };
    }
    if (!GOOGLE_USERNAME_PATTERN.test(cleanUsername)) {
        return { ok: false, message: "El username solo puede tener letras, numeros y _." };
    }

    return { ok: true, username: cleanUsername };
}

async function sendAuthRequest(path, payload) {
    return fetchJsonWithFallback(path, { method: "POST", payload, expectBody: true });
}

async function requestCoordinatorAssignment() {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 8000);

    try {
        const result = await fetchJsonWithFallback("/coordinator", {
            method: "GET",
            expectBody: true,
            signal: controller.signal
        });

        if (result.ok && result.data?.coordinatorId && result.data?.publicUrl) {
            return {
                ok: true,
                status: result.status,
                coordinatorId: String(result.data.coordinatorId).trim(),
                publicUrl: String(result.data.publicUrl).trim().replace(/\/+$/, ""),
                authUrl: result.authUrl
            };
        }

        return {
            ok: false,
            status: result.status,
            error: result.data?.error || "coordinator_lookup_failed"
        };
    } catch (error) {
        return {
            ok: false,
            status: 0,
            error: error?.name === "AbortError" ? "coordinator_lookup_timeout" : "coordinator_lookup_failed"
        };
    } finally {
        window.clearTimeout(timeoutId);
    }
}

async function register(username, password) {
    const validation = validateCredentials(username, password);
    if (!validation.ok) return { ok: false, status: 400, message: validation.message };

    const result = await sendAuthRequest("/register", {
        username: validation.username,
        password: validation.password
    });

    if (result.ok) {
        return { ok: true, status: result.status, message: "Registro exitoso. Inicia sesion." };
    }
    if (result.status === 409) {
        return { ok: false, status: 409, message: "El usuario ya existe." };
    }

    return { ok: false, status: result.status, message: "Error en el registro." };
}

async function login(username, password) {
    const validation = validateCredentials(username, password);
    if (!validation.ok) return { ok: false, status: 400, message: validation.message };

    const result = await sendAuthRequest("/login", {
        username: validation.username,
        password: validation.password
    });

    if (result.ok) {
        return {
            ok: true,
            status: result.status,
            token: result.data.token,
            username: result.data.username
        };
    }

    return { ok: false, status: result.status, message: "Credenciales invalidas." };
}

function saveSession(token, username) {
    localStorage.setItem(AUTH_STORAGE_KEYS.token, token);
    localStorage.setItem(AUTH_STORAGE_KEYS.username, username);
}

function clearSession() {
    localStorage.removeItem(AUTH_STORAGE_KEYS.token);
    localStorage.removeItem(AUTH_STORAGE_KEYS.username);
}

function setMessage(element, message, type) {
    if (!element) return;

    element.textContent = message || "";
    element.className = "message";

    if (message) {
        element.classList.add(`message--${type || "info"}`);
    }
}

function toggleFormState(form, disabled) {
    if (!form) return;

    form.querySelectorAll("input, button").forEach((control) => {
        control.disabled = disabled;
    });
}

function getGoogleUi() {
    return {
        buttonContainer: document.getElementById("google-signin-button"),
        usernameForm: document.getElementById("google-username-form"),
        usernameInput: document.getElementById("google-username"),
        cancelButton: document.getElementById("google-username-cancel"),
        message: document.getElementById("google-message")
    };
}

function setGoogleUsernameFormVisible(visible) {
    const { usernameForm, usernameInput } = getGoogleUi();

    if (!usernameForm) return;

    usernameForm.hidden = !visible;

    if (!visible) {
        usernameForm.reset();
        return;
    }

    if (usernameInput) {
        usernameInput.focus();
        usernameInput.select();
    }
}

function resetGoogleFlow() {
    pendingGoogleIdToken = null;
    setGoogleUsernameFormVisible(false);
}

function normalizeAuthError(errorCode) {
    switch (errorCode) {
        case "invalid_id_token":
            return "Google rechazo el token de identidad. Intenta de nuevo.";
        case "email_not_verified":
            return "La cuenta de Google debe tener el email verificado.";
        case "username_taken":
            return "Ese username ya existe. Elige otro.";
        case "username_required":
            return "Elige un username para terminar tu primer login con Google.";
        default:
            return errorCode ? String(errorCode) : "No se pudo autenticar con Google.";
    }
}

async function authWithGoogle(idToken, username) {
    const payload = { idToken };

    if (username) {
        payload.username = username;
    }

    return sendAuthRequest("/auth/google", payload);
}

async function completeGoogleAuth(idToken, username) {
    const { message, usernameForm } = getGoogleUi();

    toggleFormState(usernameForm, true);
    setMessage(message, "Validando login con Google...", "info");

    let result;

    try {
        result = await authWithGoogle(idToken, username);
    } catch (error) {
        toggleFormState(usernameForm, false);
        resetGoogleFlow();
        setMessage(message, "La validacion con Google no respondio. Intenta otra vez.", "error");
        return;
    }

    toggleFormState(usernameForm, false);

    if (result.ok) {
        if (!result.data?.token || !result.data?.username) {
            resetGoogleFlow();
            setMessage(message, "La respuesta del auth fue invalida. Reintenta.", "error");
            return;
        }

        resetGoogleFlow();
        saveSession(result.data.token, result.data.username);
        window.location.href = "./lobby.html";
        return;
    }

    if (result.status === 409 && result.data?.error === "username_required") {
        pendingGoogleIdToken = idToken;
        setGoogleUsernameFormVisible(true);
        setMessage(
            message,
            result.data.hint || "Es tu primera vez con Google. Elige un username.",
            "info"
        );
        return;
    }

    if (result.status === 409 && result.data?.error === "username_taken") {
        pendingGoogleIdToken = idToken;
        setGoogleUsernameFormVisible(true);
        setMessage(message, normalizeAuthError(result.data.error), "error");
        return;
    }

    if (result.status === 400 && username) {
        pendingGoogleIdToken = idToken;
        setGoogleUsernameFormVisible(true);
        setMessage(message, normalizeAuthError(result.data?.error), "error");
        return;
    }

    resetGoogleFlow();
    setMessage(message, normalizeAuthError(result.data?.error), "error");
}

async function handleGoogleResponse(response) {
    const idToken = String(response?.credential || "").trim();
    const { message } = getGoogleUi();

    if (!idToken) {
        setMessage(message, "Google no devolvio un token de identidad valido.", "error");
        return;
    }

    pendingGoogleIdToken = idToken;
    await completeGoogleAuth(idToken);
}

function renderGoogleButton() {
    const { buttonContainer, message } = getGoogleUi();
    const googleClientId = window.getGoogleClientId();

    if (!buttonContainer) return;

    if (!googleClientId) {
        setMessage(message, "Falta configurar GOOGLE_CLIENT_ID en client/.env.", "info");
        return;
    }

    if (!window.google?.accounts?.id) {
        setMessage(message, "No se pudo cargar Google Identity Services.", "error");
        return;
    }

    if (!googleInitialized) {
        window.google.accounts.id.initialize({
            client_id: googleClientId,
            callback: handleGoogleResponse
        });
        googleInitialized = true;
    }

    buttonContainer.innerHTML = "";
    const buttonWidth = Math.min(buttonContainer.clientWidth || 320, 320);
    window.google.accounts.id.renderButton(buttonContainer, {
        theme: "outline",
        size: "large",
        text: "signin_with",
        shape: "pill",
        width: buttonWidth
    });
}

function initGoogleSignIn() {
    if (window.google?.accounts?.id) {
        renderGoogleButton();
        return;
    }

    const { message } = getGoogleUi();
    const googleScript = document.querySelector("[data-google-identity-script]");

    if (!googleScript) {
        setMessage(message, "Falta el script oficial de Google Identity Services.", "error");
        return;
    }

    googleScript.addEventListener("load", renderGoogleButton, { once: true });
    googleScript.addEventListener("error", () => {
        setMessage(message, "No se pudo cargar Google Identity Services.", "error");
    }, { once: true });
}

function bindGoogleUsernameFlow() {
    const { usernameForm, usernameInput, cancelButton, message } = getGoogleUi();

    if (!usernameForm) return;

    usernameForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (!pendingGoogleIdToken) {
            setMessage(message, "Vuelve a hacer clic en Google para generar un nuevo login.", "error");
            setGoogleUsernameFormVisible(false);
            return;
        }

        const validation = validateGoogleUsername(usernameInput?.value);
        if (!validation.ok) {
            setMessage(message, validation.message, "error");
            return;
        }

        await completeGoogleAuth(pendingGoogleIdToken, validation.username);
    });

    if (cancelButton) {
        cancelButton.addEventListener("click", () => {
            resetGoogleFlow();
            setMessage(message, "Se cancelo el alta inicial con Google. Puedes intentarlo otra vez.", "info");
        });
    }
}

function bindAuthPage() {
    if (!document.body) return;

    const page = document.body.dataset.page;
    if (page !== "login" && page !== "register") return;

    const registerForm = document.getElementById("register-form");
    const loginForm = document.getElementById("login-form");

    if (page === "login") {
        bindGoogleUsernameFlow();
        initGoogleSignIn();
    }

    if (registerForm) {
        registerForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            const formData = new FormData(registerForm);

            toggleFormState(registerForm, true);
            const result = await register(formData.get("username"), formData.get("password"));
            setMessage(
                document.getElementById("register-message"),
                result.message,
                result.ok ? "success" : "error"
            );
            toggleFormState(registerForm, false);
        });
    }

    if (loginForm) {
        loginForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            const formData = new FormData(loginForm);

            toggleFormState(loginForm, true);
            const result = await login(formData.get("username"), formData.get("password"));

            if (result.ok) {
                saveSession(result.token, result.username);
                window.location.href = "./lobby.html";
                return;
            }

            setMessage(document.getElementById("login-message"), result.message, "error");
            toggleFormState(loginForm, false);
        });
    }
}

document.addEventListener("DOMContentLoaded", bindAuthPage);

window.getStoredToken = () => localStorage.getItem(AUTH_STORAGE_KEYS.token);
window.clearStoredSession = clearSession;
window.requestCoordinatorAssignment = requestCoordinatorAssignment;
window.getLastAuthUrlUsed = () => lastAuthUrlUsed;
