require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

const app = express();
const server = http.createServer(app);

// Inicializamos el WebSocketServer con noServer: true para manejar el upgrade a mano
const wss = new WebSocketServer({ noServer: true });

// Map para mantener en memoria la lista de jugadores conectados [cite: 16, 123]
const players = new Map(); // userId -> { username, socket, connectedAt }

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Coordinador corriendo en puerto ${PORT}`);
});