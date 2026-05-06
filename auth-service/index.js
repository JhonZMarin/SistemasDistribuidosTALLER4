require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Inicialización de Base de Datos SQLite
const db = new Database('users.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// ==========================
// REGISTRO (POST /register)
// ==========================
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Error 400: Body inválido
    if (!username || !password || username.trim() === "") {
      return res.status(400).json({ error: 'Username y password son obligatorios' });
    }

    // Validar si el usuario ya existe
    const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existingUser) {
      return res.status(409).json({ error: 'El nombre de usuario ya existe' });
    }

    // Hashear contraseña (mínimo 10 rounds)[cite: 1]
    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Insertar en la base de datos[cite: 1]
    const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
    const info = stmt.run(username, passwordHash);

    // Responder 201 con datos básicos[cite: 1]
    return res.status(201).json({
      userId: info.lastInsertRowid,
      username: username
    });

  } catch (error) {
    console.error("Error en registro:", error.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ==========================
// LOGIN (POST /login)[cite: 1]
// ==========================
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Error 400: Body inválido[cite: 1]
    if (!username || !password) {
      return res.status(400).json({ error: 'Faltan credenciales' });
    }

    // Buscar usuario[cite: 1]
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Comparar contra el hash[cite: 1]
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Emitir JWT (userId, username, iat, exp de 1 hora)[cite: 1]
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '30s' }
    );

    // Responder 200 con el token[cite: 1]
    return res.status(200).json({
      token: token,
      username: user.username
    });

  } catch (error) {
    console.error("Error en login:", error.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Esta es la ruta para el navegador (GET)
app.get('/', (req, res) => {
  res.send(`
    <h1>Servicio de Autenticación Activo</h1>
    <p>Este servicio está funcionando correctamente en el puerto 4000.</p>
    <p>Usa las rutas <b>/register</b> y <b>/login</b> mediante peticiones POST.</p>
  `);
});

// Iniciar servidor[cite: 1]
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Auth service corriendo en puerto ${PORT}`);
});