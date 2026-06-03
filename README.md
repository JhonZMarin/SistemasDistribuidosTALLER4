# Radar de Pilotos - UB (Among Us Distribuido P2P)

**Arquitectura de Sistemas Distribuidos - Taller 4**

Este proyecto es la implementación de un juego multijugador asíncrono (estilo Among Us) construido sobre una **Topología de Malla (Mesh P2P) tolerante a fallos**, con un servicio centralizado de descubrimiento y autenticación que maneja un **Algoritmo de Elección de Líder (Bully Algorithm)**.

El objetivo principal es demostrar conceptos de sistemas distribuidos: **replicación de estado, tolerancia a fallos, balanceo de carga, algoritmos de consenso y reconexión dinámica.**

---

## 🏗 Arquitectura del Sistema

El sistema se compone de 3 capas principales:

```mermaid
graph TD
    subgraph Capa de Clientes (Frontend)
        C1[Cliente 1]
        C2[Cliente 2]
        C3[Cliente N]
    end

    subgraph Capa de Autenticación (Registry & Leader)
        A1[Auth Service 1 (Leader)]
        A2[Auth Service 2 (Replica)]
        A3[Auth Service 3 (Replica)]
    end

    subgraph Capa Coordinadora (Mesh P2P)
        M1[Coordinador A]
        M2[Coordinador B]
        M3[Coordinador C]
    end

    C1 <-->|WebSocket: Estado local| M1
    C2 <-->|WebSocket: Estado local| M2
    C3 <-->|WebSocket: Estado local| M2
    
    C1 -.->|HTTP GET /coordinator: Descubrimiento| A1
    
    M1 <-->|WebSocket P2P: Full Mesh| M2
    M2 <-->|WebSocket P2P: Full Mesh| M3
    M1 <-->|WebSocket P2P: Full Mesh| M3

    M1 -.->|HTTP POST /heartbeat| A1
    M2 -.->|HTTP POST /heartbeat| A1
    M3 -.->|HTTP POST /heartbeat| A1
    
    A1 <-->|HTTP: Bully Election| A2
    A2 <-->|HTTP: Bully Election| A3
```

### 1. Auth Service (Directorio y Autenticación)
- Actúa como servicio de registro y balanceador de carga.
- Maneja la emisión de JSON Web Tokens (JWT) para la autenticación de usuarios.
- Implementa el **Algoritmo Bully** para elegir un "Líder" entre múltiples instancias del servicio. El líder se encarga de administrar el estado unificado y servir el Directorio.
- Recibe *Heartbeats* periódicos (cada 3s) de los coordinadores para saber cuáles están vivos. Si un coordinador deja de enviar señales (timeout de 6s), es podado del registro.

### 2. Coordinadores (Mesh P2P)
- Nodos backend que actúan como servidores de juego.
- Se conectan entre sí creando una **Malla Completa (Full Mesh)**. Para evitar bucles de conexión, el nodo con el ID alfanumérico menor es responsable de iniciar el socket contra el mayor.
- Tienen dos canales de comunicación:
  - **Canal Público (`routes.js`):** WebSockets para los clientes locales.
  - **Canal P2P (`mesh.js`):** WebSockets hacia otros coordinadores para propagar el estado (Jugadores, Intenciones de Movimiento, Votaciones, Tareas).

### 3. Cliente (Vanilla JS & Canvas)
- SPA (Single Page Application) que se renderiza mediante Canvas API a 60 FPS.
- Envía comandos de "Intención" (`intent`) 20 veces por segundo.
- Realiza el descubrimiento de red de manera asíncrona: primero contacta al Auth Service, obtiene la URL del coordinador con menor carga, y abre un WebSocket contra este.

---

## 🛠 Decisiones de Diseño

1. **Replicación de Estado Event-Sourced vs Snapshotting:** 
   El juego no envía el estado del mundo completo en cada frame, lo cual saturaría la red. En su lugar, cuando un jugador se mueve, se envía una *Intención de movimiento (vector de dirección)*. El Game Loop de cada coordinador interpola las posiciones localmente de manera independiente pero determinista. Cada cierto tiempo (Snapshot), se sincronizan coordenadas exactas para corregir desfases (Rubber-banding).
2. **Failover Optimista (Desconexión suave):**
   Si el Coordinador A se cae, la malla de coordinadores restantes marca a sus jugadores como `disconnected` en lugar de eliminarlos. Esto preserva el progreso de tareas, ubicación y roles (Ej. si era Impostor). Cuando el cliente reconecta tras el failover, "reclama" su estado conservándolo intacto.
3. **Ngrok Tunneling y Bypass de Seguridad:**
   Dado que Ngrok intercepta peticiones HTTP para mostrar una advertencia en navegadores (`Browser Warning`), todas las conexiones de WebSockets (que inician como HTTP Upgrade) y peticiones `fetch` envían la cabecera `ngrok-skip-browser-warning: 1` para no ser bloqueadas a nivel de proxy.
4. **Caché Buster en Descubrimiento (`no-store`):**
   Dado que los browsers cachean fuertemente los métodos `GET`, la solicitud `/coordinator` se forzó con `cache: 'no-store'`. De lo contrario, durante un failover, el cliente obtendría la misma URL del coordinador muerto una y otra vez desde la caché local del navegador, creando un bucle de desconexión infinita.

---

## 🚨 Modos de Falla Conocidos & Tolerancia

| Escenario de Falla | Comportamiento del Sistema (Mitigación) |
| :--- | :--- |
| **Caída de un Coordinador de Juego** | El cliente detecta cierre del WebSocket (`onclose`). El cliente espera unos segundos a que el Auth Service mutile al coordinador muerto por falta de heartbeats. Luego solicita un nuevo coordinador y se conecta al sobreviviente. Sus datos in-game persisten. |
| **Caída del Auth Service Leader** | Se gatilla el Algoritmo Bully. El Auth Service con mayor prioridad asume el liderazgo. Mientras ocurre la elección, no pueden unirse nuevos jugadores ni iniciar nuevos coordinadores, pero *las partidas en curso no se ven afectadas* (la malla P2P funciona independientemente). |
| **Jugador pierde internet temporalmente** | El jugador es marcado como "desconectado" y queda congelado para los demás. Tiene 7 segundos de gracia para reconectar; si vuelve en ese periodo, su cliente renegocia el WebSocket sin perder el estado local. |
| **Aislamiento Parcial (Split Brain)** | Si la malla P2P se corta a la mitad, se producirá divergencia de estado local. La mitigación actual prioriza que el juego no se cierre, resultando en dos realidades alternas hasta que el enlace de red regrese y el líder de la malla decida quién sobrescribe el estado. |

---

## 🚀 Guía de Despliegue Rápido (Local)

### Requisitos Previos
- Node.js v18 o superior
- Si se va a probar por internet: Ngrok instalado

### Paso 1: Levantar los Auth Services
En la carpeta `/auth-service`:
Instala las dependencias:
```bash
npm install
```

Levanta 3 instancias en consolas diferentes para simular el algoritmo Bully (usa las variables de entorno incluidas):
```bash
# Terminal 1
node index.js

# Terminal 2
node --env-file=.env.auth2 index.js

# Terminal 3
node --env-file=.env.auth3 index.js
```

### Paso 2: Levantar Coordinadores
Abre la carpeta `/coordinador` y duplícala físicamente o ábrela en múltiples consolas usando variables locales (se provee el `.env` para simplificar, pero necesitarás exponer diferentes puertos en cada instancia si usas una sola máquina).
```bash
npm install
npm start
```
*Si levantas múltiples en la misma PC, asegúrate de cambiar `PORT_PUBLIC` y `PORT_PEER` en cada `.env` adicional.*

### Paso 3: Exponer a Internet (Ngrok) - Opcional
Si vas a jugar con amigos, debes exponer *los puertos* de Auth y de al menos un Coordinador.

```bash
# Exponer Auth Leader (Ej. puerto 3000)
ngrok http 3000

# Exponer un Coordinador Público (Ej. puerto 5000)
ngrok http 5000
```

Tras esto, debes colocar las URLs de ngrok generadas en:
1. `client/js/config.js` -> `window.AUTH_SERVICES = ["https://<tu-auth-ngrok>"]`
2. `.env` del coordinador -> `PUBLIC_URL="https://<tu-coord-ngrok>"`

### Paso 4: Jugar
Abre la carpeta `/client`. **No uses protocolo `file://`**, debes levantar un servidor estático:
```bash
npx serve .
```
O usar extensiones como "Live Server" de VSCode.
Ingresa al cliente, pon un nombre, la URL del Auth Service y disfruta de la partida.
