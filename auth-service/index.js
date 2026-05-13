require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { DatabaseSync } = require('node:sqlite');

// ===========================
// Configuración
// ===========================
const PORT = parseInt(process.env.PORT || '4000', 10);
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// Validar variables de entorno críticas
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('ERROR: JWT_SECRET debe existir y tener al menos 32 caracteres.');
  process.exit(1);
}
if (!GOOGLE_CLIENT_ID) {
  console.error('ERROR: GOOGLE_CLIENT_ID es obligatorio.');
  process.exit(1);
}

// ===========================
// Google OAuth2 Client
// ===========================
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ===========================
// Base de datos SQLite
// ===========================
const db = new DatabaseSync('users.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('local','google')),
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    email TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Prepared statements reutilizables
const stmts = {
  insertLocal: db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', ?)"),
  insertGoogle: db.prepare("INSERT INTO users (username, provider, google_sub, email) VALUES (?, 'google', ?, ?)"),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByGoogle: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
};

// ===========================
// Express App
// ===========================
const app = express();
app.use(cors());
app.use(express.json({ limit: '4kb' }));

// ===========================
// Funciones auxiliares
// ===========================

/**
 * Genera un JWT para el usuario dado.
 * El payload incluye userId, username y provider.
 */
function emitToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, provider: user.provider },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Valida el formato del username.
 * Retorna null si es válido, o un string con el error.
 */
function validateUsername(u) {
  if (typeof u !== 'string') return 'username debe ser string';
  if (u.length < 3 || u.length > 32) return 'username 3-32 chars';
  if (!/^[a-zA-Z0-9_]+$/.test(u)) return 'username solo letras, números, _';
  return null;
}

// ===========================
// POST /register
// ===========================
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    // Validar username
    const usernameError = validateUsername(username);
    if (usernameError) {
      return res.status(400).json({ error: usernameError });
    }

    // Validar password
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'password debe tener al menos 6 caracteres' });
    }

    // Hashear con bcrypt
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Insertar en la base de datos
    try {
      const result = stmts.insertLocal.run(username, hash);
      return res.status(201).json({
        userId: result.lastInsertRowid,
        username: username
      });
    } catch (err) {
      // SQLITE_CONSTRAINT_UNIQUE → username ya existe
      if (err.code === 'ERR_SQLITE_ERROR' && err.errcode === 2067) {
        return res.status(409).json({ error: 'El nombre de usuario ya existe' });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error en registro:', error.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ===========================
// POST /login
// ===========================
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    // Validar body
    if (!username || !password) {
      return res.status(400).json({ error: 'Faltan credenciales' });
    }

    // Buscar usuario
    const user = stmts.findByUsername.get(username);
    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // IMPORTANTE: si el usuario se registró con Google, no tiene password.
    // Debe entrar por /auth/google, no por /login.
    if (user.provider !== 'local') {
      return res.status(401).json({ error: 'Este usuario debe iniciar sesión con Google' });
    }

    // Comparar contraseña contra el hash
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Emitir JWT
    const token = emitToken(user);
    return res.status(200).json({
      token: token,
      username: user.username
    });
  } catch (error) {
    console.error('Error en login:', error.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ===========================
// POST /auth/google (NUEVO)
// ===========================
app.post('/auth/google', async (req, res) => {
  const { idToken, username } = req.body || {};

  // Validar que venga el idToken
  if (typeof idToken !== 'string') {
    return res.status(400).json({ error: 'idToken requerido' });
  }

  // 1. Verificar el ID token contra Google
  //    Esto valida la firma, el audience y la expiración.
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_id_token' });
  }

  // Validar que el email esté verificado
  if (!payload.email_verified) {
    return res.status(401).json({ error: 'email_not_verified' });
  }

  // sub es el identificador estable del usuario en Google (NO el email)
  const googleSub = payload.sub;
  const email = payload.email;

  // 2. ¿Ya existe este usuario de Google?
  const existing = stmts.findByGoogle.get(googleSub);
  if (existing) {
    // Usuario ya registrado → emitir token directamente
    return res.json({ token: emitToken(existing), username: existing.username });
  }

  // 3. Es la primera vez. ¿Mandó username?
  if (!username) {
    return res.status(409).json({
      error: 'username_required',
      hint: 'Primer login con Google. Debes elegir un username.'
    });
  }

  // Validar formato del username
  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.status(400).json({ error: usernameError });
  }

  // 4. Crear el usuario (puede fallar si el username está tomado)
  try {
    const result = stmts.insertGoogle.run(username, googleSub, email);
    const newUser = { id: result.lastInsertRowid, username, provider: 'google' };
    return res.json({ token: emitToken(newUser), username });
  } catch (err) {
    // SQLITE_CONSTRAINT_UNIQUE → username ya tomado
    if (err.code === 'ERR_SQLITE_ERROR' && err.errcode === 2067) {
      return res.status(409).json({ error: 'username_taken' });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal' });
  }
});

// ===========================
// GET / (Health check)
// ===========================
app.get('/', (req, res) => {
  res.send(`
    <h1>Servicio de Autenticación Activo</h1>
    <p>Este servicio está funcionando correctamente en el puerto ${PORT}.</p>
    <p>Rutas disponibles: <b>/register</b>, <b>/login</b>, <b>/auth/google</b> (POST)</p>
  `);
});

// ===========================
// Iniciar servidor
// ===========================
app.listen(PORT, () => console.log(`auth :${PORT}`));