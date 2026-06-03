// ═══════════════════════════════════════════════════════════════════════════
//  auth.js — JWT, password hashing, validation helpers
//  Auth Service — Taller 4 (Sistemas Distribuidos)
// ═══════════════════════════════════════════════════════════════════════════

const { pbkdf2Sync, randomBytes, timingSafeEqual } = require("crypto");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const {
  JWT_SECRET,
  JWT_EXPIRES_IN,
  GOOGLE_CLIENT_ID,
  PASSWORD_HASH_ITERATIONS,
  USERNAME_PATTERN
} = require("./config");

// ── Google OAuth client ──────────────────────────────────────────────────

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ── JWT ──────────────────────────────────────────────────────────────────

function emitToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      provider: user.provider
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// ── Validation ───────────────────────────────────────────────────────────

function validateUsername(username) {
  const cleanUsername = String(username || "").trim();

  if (!cleanUsername) {
    return { ok: false, message: "username debe existir" };
  }

  if (cleanUsername.length < 3 || cleanUsername.length > 32) {
    return { ok: false, message: "username 3-32 chars" };
  }

  if (!USERNAME_PATTERN.test(cleanUsername)) {
    return { ok: false, message: "username solo letras, numeros y _" };
  }

  return { ok: true, username: cleanUsername };
}

function validatePassword(password) {
  const cleanPassword = String(password || "");

  if (!cleanPassword) {
    return { ok: false, message: "password debe existir" };
  }

  if (cleanPassword.length < 6) {
    return { ok: false, message: "password debe tener al menos 6 caracteres" };
  }

  return { ok: true, password: cleanPassword };
}

// ── Password hashing ────────────────────────────────────────────────────

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, PASSWORD_HASH_ITERATIONS, 32, "sha256");

  return `pbkdf2$${PASSWORD_HASH_ITERATIONS}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== "string" || !storedHash.startsWith("pbkdf2$")) {
    return false;
  }

  const parts = storedHash.split("$");
  if (parts.length !== 4) {
    return false;
  }

  const iterations = Number.parseInt(parts[1], 10);
  const salt = Buffer.from(parts[2], "base64url");
  const expectedHash = Buffer.from(parts[3], "base64url");

  if (!Number.isInteger(iterations) || iterations <= 0 || !salt.length || !expectedHash.length) {
    return false;
  }

  const hash = pbkdf2Sync(password, salt, iterations, expectedHash.length, "sha256");

  if (hash.length !== expectedHash.length) {
    return false;
  }

  return timingSafeEqual(hash, expectedHash);
}

// ── Google helpers ───────────────────────────────────────────────────────

function buildGoogleServiceUnavailable() {
  return {
    error: "google_auth_not_configured",
    message: "GOOGLE_CLIENT_ID no esta configurado en auth-service."
  };
}

module.exports = {
  googleClient,
  emitToken,
  validateUsername,
  validatePassword,
  hashPassword,
  verifyPassword,
  buildGoogleServiceUnavailable
};
