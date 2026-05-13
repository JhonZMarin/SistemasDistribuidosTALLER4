# SistemasDistribuidosTALLER4

Cliente web para la primera parte del proyecto final de Sistemas Distribuidos. Esta base deja lista la interfaz de login/registro y el lobby en tiempo real, consumiendo un servicio de autenticacion HTTP y un coordinador WebSocket.

## Estructura

- `client/`: HTML, CSS y JavaScript plano del cliente.

## Configuracion del cliente

1. Crea `client/.env` a partir de `client/.env.example`.
2. Ajusta las URLs segun tu entorno:

```env
PORT=3000
AUTH_URL=http://localhost:4000
WS_URL=ws://localhost:5000
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
```

Para `ngrok`, cambia `AUTH_URL` a la URL `https://...` del servicio de auth y `WS_URL` a la URL `wss://...` del coordinador.
Si vas a usar Google Identity Services, agrega tambien el `GOOGLE_CLIENT_ID` del cliente OAuth configurado en Google Cloud.

## Ejecucion

```bash
cd client
npm install
npm start
```

Luego abre `http://localhost:3000`.

## Flujo cubierto por el cliente

- Registro de usuario con `POST /register`.
- Login con `POST /login`.
- Login con Google usando el boton oficial y `POST /auth/google`.
- Persistencia de `token` y `username` en `localStorage`.
- Conexion a `ws://.../connect?token=...`.
- Actualizacion en vivo de la lista de jugadores conectados.
- Cierre de sesion manual.
- Redireccion al login si el WebSocket se cae o el token es rechazado.
