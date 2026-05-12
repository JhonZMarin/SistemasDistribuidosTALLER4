const AUTH_STORAGE_KEYS = Object.freeze({
    token: "token",
    username: "username",
    noticeMessage: "notice_message",
    noticeType: "notice_type"
});

// --- GOOGLE LOGIN (NUEVO REQUISITO) ---
async function handleGoogleResponse(response) {
    const idToken = response.credential;
    await authWithGoogle(idToken);
}

async function authWithGoogle(idToken, chosenUsername = null) {
    const body = { idToken };
    if (chosenUsername) body.username = chosenUsername;

    const res = await fetch(`${window.getAuthBaseUrl()}/auth/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    const data = await res.json();

    // Si es la primera vez, el servidor pide un username [cite: 280, 400]
    if (res.status === 409 && data.error === "username_required") {
        const username = prompt("¡Bienvenido! Por favor, elige un nombre de usuario para el radar:");
        if (username) {
            await authWithGoogle(idToken, username); // Reintentar con el username [cite: 281]
        }
    } else if (res.ok) {
        saveSession(data.token, data.username);
        window.location.href = "./lobby.html";
    } else {
        const errorMsg = data.error || "Error al conectar con Google";
        alert("Error: " + errorMsg);
    }
}

// Configurar el botón oficial de Google [cite: 259]
function initGoogleSignIn() {
    if (typeof google === 'undefined') return;
    google.accounts.id.initialize({
        client_id: "TU_GOOGLE_CLIENT_ID.apps.googleusercontent.com", // REEMPLAZAR CON TU ID
        callback: handleGoogleResponse
    });
    const btnContainer = document.getElementById("google-signin-button");
    if (btnContainer) {
        google.accounts.id.renderButton(btnContainer, { theme: "outline", size: "large" });
    }
}

// --- FUNCIONES EXISTENTES ---
function buildAuthUrl(path) {
    return `${window.getAuthBaseUrl()}${path}`;
}

async function readJsonSafely(response) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return null;
    try { return await response.json(); } catch (error) { return null; }
}

function validateCredentials(username, password) {
    const cleanUsername = String(username || "").trim();
    const cleanPassword = String(password || "");
    if (!cleanUsername || !cleanPassword) {
        return { ok: false, message: "Ingresa username y password." };
    }
    return { ok: true, username: cleanUsername, password: cleanPassword };
}

async function sendAuthRequest(path, credentials) {
    try {
        const response = await fetch(buildAuthUrl(path), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(credentials)
        });
        const data = await readJsonSafely(response);
        return { ok: response.ok, status: response.status, data };
    } catch (error) {
        return { ok: false, status: 0, data: null };
    }
}

async function register(username, password) {
    const validation = validateCredentials(username, password);
    if (!validation.ok) return { ok: false, status: 400, message: validation.message };

    const result = await sendAuthRequest("/register", {
        username: validation.username,
        password: validation.password
    });

    if (result.ok) return { ok: true, status: result.status, message: "Registro exitoso. Inicia sesión." };
    if (result.status === 409) return { ok: false, status: 409, message: "El usuario ya existe." };
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
    return { ok: false, status: result.status, message: "Credenciales inválidas." };
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
    if (message) element.classList.add(`message--${type || "info"}`);
}

function toggleFormState(form, disabled) {
    if (!form) return;
    form.querySelectorAll("input, button").forEach(c => c.disabled = disabled);
}

function bindAuthPage() {
    if (!document.body || document.body.dataset.page !== "login") return;

    initGoogleSignIn(); // Iniciar Google

    const registerForm = document.getElementById("register-form");
    const loginForm = document.getElementById("login-form");

    if (registerForm) {
        registerForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const formData = new FormData(registerForm);
            toggleFormState(registerForm, true);
            const res = await register(formData.get("username"), formData.get("password"));
            setMessage(document.getElementById("register-message"), res.message, res.ok ? "success" : "error");
            toggleFormState(registerForm, false);
        });
    }

    if (loginForm) {
        loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const formData = new FormData(loginForm);
            toggleFormState(loginForm, true);
            const res = await login(formData.get("username"), formData.get("password"));
            if (res.ok) {
                saveSession(res.token, res.username);
                window.location.href = "./lobby.html";
            } else {
                setMessage(document.getElementById("login-message"), res.message, "error");
                toggleFormState(loginForm, false);
            }
        });
    }
}

document.addEventListener("DOMContentLoaded", bindAuthPage);
window.getStoredToken = () => localStorage.getItem(AUTH_STORAGE_KEYS.token);