// ═══════════════════════════════════════════════════════════════════════════
//  db.js — SQLite database layer (per-node isolated DB file)
//  Auth Service — Taller 4 (Sistemas Distribuidos)
// ═══════════════════════════════════════════════════════════════════════════

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { AUTH_NODE_ID, IS_REPLICATED } = require("./config");

// Each node gets its own DB file when running in replicated mode to avoid
// SQLite locking conflicts.  Standalone mode keeps the original "users.db".
const DB_FILENAME = IS_REPLICATED ? `users-${AUTH_NODE_ID}.db` : "users.db";
const db = new DatabaseSync(path.join(__dirname, DB_FILENAME));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('local', 'google')),
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    email TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── Query helpers ────────────────────────────────────────────────────────

function findUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

function findUserByGoogleSub(googleSub) {
  return db.prepare("SELECT * FROM users WHERE google_sub = ?").get(googleSub);
}

function insertLocalUser(username, passwordHash) {
  return db.prepare(
    "INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', ?)"
  ).run(username, passwordHash);
}

function insertGoogleUser(username, googleSub, email) {
  return db.prepare(
    "INSERT INTO users (username, provider, google_sub, email) VALUES (?, 'google', ?, ?)"
  ).run(username, googleSub, email);
}

function getAllUsers() {
  return db.prepare(
    "SELECT id, username, provider, password_hash, google_sub, email, created_at FROM users"
  ).all();
}

function upsertSyncedUser(userData) {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, provider, password_hash, google_sub, email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userData.id ?? null,
      userData.username,
      userData.provider || "local",
      userData.password_hash ?? null,
      userData.google_sub ?? null,
      userData.email ?? null,
      userData.created_at ?? null
    );
  } catch (error) {
    console.error("[AUTH-MESH] upsertSyncedUser failed:", error.message);
  }
}

module.exports = {
  DB_FILENAME,
  db,
  findUserByUsername,
  findUserByGoogleSub,
  insertLocalUser,
  insertGoogleUser,
  getAllUsers,
  upsertSyncedUser
};
