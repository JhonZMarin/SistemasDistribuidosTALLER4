# SistemasDistribuidosTALLER4

Repositorio del cliente web y los servicios base para el Taller 4 de Sistemas Distribuidos.

## Estructura

- `client/`: interfaz web de login, registro y lobby.
- `auth-service/`: servicio HTTP de autenticacion local y con Google.
- `coordinador/`: servicio WebSocket que valida JWT y mantiene el estado del lobby.

## Variables de entorno

### `client/.env`

```env
PORT=3000
AUTH_URL=http://localhost:4000
WS_URL=ws://localhost:5000
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
```

### `auth-service/.env`

```env
PORT=4000
JWT_SECRET=replace_with_a_secret_at_least_32_chars
JWT_EXPIRES_IN=1h
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
```

### `coordinador/.env`

```env
PORT=5000
JWT_SECRET=replace_with_the_same_secret_used_by_auth_service
WORLD_WIDTH=800
WORLD_HEIGHT=600
PLAYER_RADIUS=20
PLAYER_SPEED=220
TICK_RATE=20
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

```bash
cd client
npm install
npm start
```

Luego abre `http://localhost:3000`.
