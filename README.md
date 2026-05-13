# SistemasDistribuidosTALLER4

Repositorio del cliente web y los servicios base del proyecto final de Sistemas Distribuidos.

## Estructura

- `client/`: interfaz web de login, registro y lobby.
- `auth-service/`: autenticacion local/Google y directory service para coordinadores.
- `coordinador/`: coordinador de juego con clientes WebSocket, heartbeats y mesh entre peers.

## Variables de entorno

### `client/.env`

```env
PORT=3000
AUTH_URL=http://localhost:4000
WS_URL=
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
```

`WS_URL` queda opcional. El cliente ahora resuelve el coordinador con `GET /coordinator`.

### `auth-service/.env`

```env
PORT=4000
JWT_SECRET=replace_with_a_secret_at_least_32_chars
JWT_EXPIRES_IN=1h
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
HEARTBEAT_TIMEOUT_MS=6000
```

### `coordinador/.env`

```env
PORT=5000
PEER_PORT=5100
JWT_SECRET=replace_with_the_same_secret_used_by_auth_service
COORDINATOR_ID=coord-a
AUTH_SERVICE_URL=http://localhost:4000
PUBLIC_WS_URL=ws://localhost:5000
PEER_WS_URL=ws://localhost:5100
WORLD_WIDTH=800
WORLD_HEIGHT=600
PLAYER_RADIUS=20
PLAYER_SPEED=220
TICK_RATE=20
HEARTBEAT_INTERVAL_MS=2000
PEER_DISCOVERY_INTERVAL_MS=2000
```

## Ejecucion local

```bash
cd auth-service
npm install
npm start
```

```bash
cd coordinador
npm install
npm start
```

Para varios coordinadores, levanta varias instancias con distinto `PORT`, `PEER_PORT`, `COORDINATOR_ID`, `PUBLIC_WS_URL` y `PEER_WS_URL`.

```bash
cd client
npm install
npm start
```

Luego abre `http://localhost:3000`.

## Flujo actual

1. El cliente hace login en `auth-service`.
2. El lobby pide `GET /coordinator`.
3. El cliente abre `WS /connect?token=...` contra el coordinador asignado.
4. Cada coordinador manda heartbeat al auth y descubre peers con `GET /peers`.
5. Los coordinadores replican `player_joined`, `player_left`, `intent_replicate` y `extras_replicate`.
