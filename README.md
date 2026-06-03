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
AUTH_URLS=http://localhost:4000,http://localhost:4001,http://localhost:4002
AUTH_URL=http://localhost:4000
WS_URL=
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
```

`AUTH_URLS` es la lista preferida para tolerancia a fallos; `AUTH_URL` queda como compatibilidad.
`WS_URL` queda opcional. El cliente resuelve el coordinador con `GET /coordinator`.

### `auth-service/.env`

```env
PORT=4000
AUTH_ID=auth-a
PUBLIC_URL=http://localhost:4000
PEER_PORT=5000
PEER_URL=ws://localhost:5000
AUTH_URLS=http://localhost:4000,http://localhost:4001,http://localhost:4002
JWT_SECRET=replace_with_a_secret_at_least_32_chars
JWT_EXPIRES_IN=1h
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
HEARTBEAT_TIMEOUT_MS=6000
AUTH_ELECTION_TIMEOUT_MS=2500
AUTH_READ_STALENESS_TOLERANCE=10
```

Cada auth usa su propia base SQLite `users-<AUTH_ID>.db`. `auth-a` arranca con `npm start`; `auth-b` y `auth-c` tienen scripts propios.

### `coordinador/.env`

```env
PORT=5000
PEER_PORT=5100
JWT_SECRET=replace_with_the_same_secret_used_by_auth_service
COORDINATOR_ID=coord-a
AUTH_URLS=http://localhost:4000,http://localhost:4001,http://localhost:4002
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
cd auth-service
npm run start:auth-b
```

```bash
cd auth-service
npm run start:auth-c
```

```bash
cd coordinador
npm install
npm start
```

Para varios coordinadores, levanta varias instancias con distinto `PORT`, `PEER_PORT`, `COORDINATOR_ID`, `PUBLIC_WS_URL`, `PEER_WS_URL` y el mismo `AUTH_URLS`.

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
6. Los auth replicas exponen `/status`, `/peers` y `GET /peers?kind=coordinators`; si el líder cae, los replicas responden `503 not_leader` con `leaderUrl`.
