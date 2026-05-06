const AUTH_STORAGE_KEYS = Object.freeze({
  token: "token",
  username: "username",
  noticeMessage: "notice_message",
  noticeType: "notice_type"
});

function buildAuthUrl(path) {
  return `${window.getAuthBaseUrl()}${path}`;
}

async function readJsonSafely(response) {
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    return null;
  }

  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function validateCredentials(username, password) {
  const cleanUsername = String(username || "").trim();
  const cleanPassword = String(password || "");

  if (!cleanUsername || !cleanPassword) {
    return {
      ok: false,
      message: "Ingresa username y password."
    };
  }

  return {
    ok: true,
    username: cleanUsername,
    password: cleanPassword
  };
}

async function sendAuthRequest(path, credentials) {
  try {
    const response = await fetch(buildAuthUrl(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(credentials)
    });

    const data = await readJsonSafely(response);

    return {
      ok: response.ok,
      status: response.status,
      data
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null
    };
  }
}

async function register(username, password) {
  const validation = validateCredentials(username, password);

  if (!validation.ok) {
    return {
      ok: false,
      status: 400,
      message: validation.message
    };
  }

  const result = await sendAuthRequest("/register", {
    username: validation.username,
    password: validation.password
  });

  if (result.ok) {
    return {
      ok: true,
      status: result.status,
      message: "Registro exitoso. Ya puedes iniciar sesion.",
      data: result.data
    };
  }

  if (result.status === 409) {
    return {
      ok: false,
      status: 409,
      message: "El usuario ya existe."
    };
  }

  if (result.status === 400) {
    return {
      ok: false,
      status: 400,
      message: "Datos invalidos. Verifica username y password."
    };
  }

  if (result.status === 0) {
    return {
      ok: false,
      status: 0,
      message: "No se pudo conectar con el servicio de autenticacion."
    };
  }

  return {
    ok: false,
    status: result.status,
    message: "No fue posible completar el registro."
  };
}

async function login(username, password) {
  const validation = validateCredentials(username, password);

  if (!validation.ok) {
    return {
      ok: false,
      status: 400,
      message: validation.message
    };
  }

  const result = await sendAuthRequest("/login", {
    username: validation.username,
    password: validation.password
  });

  if (result.ok) {
    const token = result.data && typeof result.data.token === "string"
      ? result.data.token
      : "";
    const resolvedUsername = result.data && typeof result.data.username === "string"
      ? result.data.username
      : validation.username;

    if (!token) {
      return {
        ok: false,
        status: 502,
        message: "La respuesta del servidor no es valida."
      };
    }

    return {
      ok: true,
      status: result.status,
      message: "Inicio de sesion exitoso.",
      token,
      username: resolvedUsername,
      data: result.data
    };
  }

  if (result.status === 400) {
    return {
      ok: false,
      status: 400,
      message: "Datos invalidos. Verifica username y password."
    };
  }

  if (result.status === 401) {
    return {
      ok: false,
      status: 401,
      message: "Usuario o password incorrectos."
    };
  }

  if (result.status === 0) {
    return {
      ok: false,
      status: 0,
      message: "No se pudo conectar con el servicio de autenticacion."
    };
  }

  return {
    ok: false,
    status: result.status,
    message: "No fue posible iniciar sesion."
  };
}

function saveSession(token, username) {
  localStorage.setItem(AUTH_STORAGE_KEYS.token, token);
  localStorage.setItem(AUTH_STORAGE_KEYS.username, username);
}

function clearSession() {
  localStorage.removeItem(AUTH_STORAGE_KEYS.token);
  localStorage.removeItem(AUTH_STORAGE_KEYS.username);
}

function getStoredToken() {
  return localStorage.getItem(AUTH_STORAGE_KEYS.token);
}

function getStoredUsername() {
  return localStorage.getItem(AUTH_STORAGE_KEYS.username);
}

function saveSessionNotice(message, type) {
  if (!message) {
    return;
  }

  sessionStorage.setItem(AUTH_STORAGE_KEYS.noticeMessage, message);
  sessionStorage.setItem(AUTH_STORAGE_KEYS.noticeType, type || "info");
}

function consumeSessionNotice() {
  const message = sessionStorage.getItem(AUTH_STORAGE_KEYS.noticeMessage);
  const type = sessionStorage.getItem(AUTH_STORAGE_KEYS.noticeType) || "info";

  sessionStorage.removeItem(AUTH_STORAGE_KEYS.noticeMessage);
  sessionStorage.removeItem(AUTH_STORAGE_KEYS.noticeType);

  if (!message) {
    return null;
  }

  return { message, type };
}

function setMessage(element, message, type) {
  if (!element) {
    return;
  }

  element.textContent = message || "";
  element.classList.remove("message--success", "message--error", "message--info");

  if (!message) {
    return;
  }

  const resolvedType = type || "info";
  element.classList.add(`message--${resolvedType}`);
}

function toggleFormState(form, disabled) {
  if (!form) {
    return;
  }

  const controls = form.querySelectorAll("input, button");
  controls.forEach((control) => {
    control.disabled = disabled;
  });
}

function bindAuthPage() {
  if (!document.body || document.body.dataset.page !== "login") {
    return;
  }

  const registerForm = document.getElementById("register-form");
  const registerMessage = document.getElementById("register-message");
  const loginForm = document.getElementById("login-form");
  const loginMessage = document.getElementById("login-message");
  const pendingNotice = consumeSessionNotice();

  if (pendingNotice && loginMessage) {
    setMessage(loginMessage, pendingNotice.message, pendingNotice.type);
  }

  if (registerForm) {
    registerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setMessage(registerMessage, "", "info");
      const formData = new FormData(registerForm);
      toggleFormState(registerForm, true);
      const result = await register(
        formData.get("username"),
        formData.get("password")
      );

      setMessage(registerMessage, result.message, result.ok ? "success" : "error");

      if (result.ok) {
        registerForm.reset();
      }

      toggleFormState(registerForm, false);
    });
  }

  if (loginForm) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setMessage(loginMessage, "", "info");
      const formData = new FormData(loginForm);
      toggleFormState(loginForm, true);
      const result = await login(
        formData.get("username"),
        formData.get("password")
      );

      if (!result.ok) {
        setMessage(loginMessage, result.message, "error");
        toggleFormState(loginForm, false);
        return;
      }

      saveSession(result.token, result.username);
      setMessage(loginMessage, "Acceso correcto. Redirigiendo...", "success");
      window.location.href = "./lobby.html";
    });
  }
}

window.AuthStorage = {
  saveSession,
  clearSession,
  getStoredToken,
  getStoredUsername,
  saveSessionNotice
};

window.setUiMessage = setMessage;

document.addEventListener("DOMContentLoaded", bindAuthPage);
