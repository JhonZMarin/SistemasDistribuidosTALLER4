# Prototipo Among Us - Sistemas Distribuidos (Taller 4 / Examen Final)

**Autor:** Wilson Sebastian Moreno Sanchez (Código: 55223016)

Este repositorio contiene la implementación del Taller 4 y Examen Final de Sistemas Distribuidos. Consiste en un clon funcional de "Among Us" utilizando una arquitectura distribuida estricta sin el uso de herramientas externas de enrutamiento o mensajería (sin Redis, sin Kafka, sin proxies reversos).

## 🏗️ Arquitectura del Sistema

El sistema se compone de tres piezas fundamentales:

1. **Auth Service (Directorio P2P y Autenticación)**
   - Base de datos local usando `node:sqlite`.
   - Autenticación Stateless basada en **JWT** (JSON Web Tokens).
   - **Replicación Single-Writer**: Cada instancia del Auth Service tiene su propia base de datos local (`users-auth-X.db`). La replicación se hace sincronizando peticiones a través de WebSockets (`sync_request`, `write_propagate`).
   - Sirve como directorio para que los clientes descubran los Coordinadores disponibles (`/peers`).

2. **Coordinadores (Servidores de Juego en Mesh P2P)**
   - Forman un **Mesh P2P Completo** utilizando WebSockets.
   - Reciben "Intents" (intenciones de acción) de los clientes, calculan el estado resultante (ej. colisiones de paredes, distancias de asesinato) de forma autoritativa.
   - Replican el estado a otros coordinadores mediante eventos P2P (ej. `global_state_replicate`, `extras_replicate`, `chat_replicate`).
   - Sin estado persistente en disco; todo corre en memoria para máxima velocidad.

3. **Cliente Web (Frontend)**
   - Servidor estático ultra-ligero (`express`).
   - Renderizado en `<canvas>` con JavaScript puro (sin frameworks).
   - Simplemente dibuja el estado que dicta el Coordinador y envía inputs del usuario (`intent`).

---

## 🚀 Funcionalidades Implementadas (Fases)

### Fase 1: Replicación del Auth
Se eliminó la base de datos compartida. Ahora, múltiples Auth Services pueden correr en paralelo. Un nodo actúa como **Leader** (Writer) y propaga las escrituras (registros de usuarios) a los demás nodos, garantizando consistencia eventual estricta sin librerías externas.

### Fase 2: Mecánicas Base (Core Loop)
- Colisiones Server-Side utilizando *AABB bounding boxes*.
- Sistema de roles aleatorio (Tripulantes vs 1 Impostor).
- **Asesinato (Kill)**: Validación de proximidad en el servidor.
- **Ductos (Vent)**: Capacidad del impostor de esconderse del mapa.

### Fase 3: Zonas de Interacción
- **Tareas Globales**: Zonas redondas amarillas. Si un tripulante interactúa, suma al progreso global del equipo.
- **Panel de Vitales (Track 2.5)**: Escritorio azul en la cafetería. Muestra a todos los jugadores un modal con el estado en tiempo real (Vivo/Muerto) de la tripulación.

### Fase 4: Reuniones de Emergencia
- Botón rojo central. Al activarse, congela el movimiento de todo el servidor y levanta el panel de votación P2P.
- Temporizador de 30s. El jugador con mayoría absoluta es expulsado mediante un intent `eject_replicate`.

### Fase 5: Chat Distribuido (Track 2.6)
- Sistema de chat habilitado **únicamente** durante las reuniones de emergencia.
- **Validaciones en el Coordinador**: Longitud máxima (100 caracteres) y **Rate Limiting** (1 mensaje cada 2 segundos) para prevenir spam.
- Replicado en tiempo real a toda la red Mesh.

### Fase 6: Modo Espectador (Track 2.5)
- Los jugadores asesinados o expulsados se convierten en **Fantasmas** (semi-transparentes).
- Los fantasmas están completamente silenciados a nivel servidor: no pueden matar, usar ductos, llamar reuniones ni chatear.
- **Visibilidad asimétrica**: Los jugadores vivos NO pueden ver a los fantasmas. Los fantasmas SÍ pueden ver a otros fantasmas.

---

## ⚙️ Instrucciones de Ejecución Local

Para probar todo el entorno en una sola máquina (simulando 1 Auth y 1 Coordinador):

1. **Instalar dependencias globales** (Solo si no están instaladas):
   Asegúrate de ejecutar `npm install` dentro de las carpetas `auth-service`, `coordinador` y `client`.

2. **Levantar el Servicio de Autenticación**:
   En una terminal:
   ```bash
   cd auth-service
   npm start
   ```

3. **Levantar el Coordinador P2P**:
   En otra terminal:
   ```bash
   cd coordinador
   npm start
   ```

4. **Levantar el Cliente Web**:
   En una tercera terminal:
   ```bash
   cd client
   npm start
   ```

5. **Jugar**:
   Abre [http://localhost:3000](http://localhost:3000) en tu navegador. Puedes abrir múltiples pestañas (idealmente en modo incógnito o navegadores distintos) para registrarte con distintos usuarios y probar la interacción multijugador.

---

## 💥 Modos de Falla y Resiliencia (Failover)

El sistema está diseñado para resistir caídas:
- Si un **Coordinador** se cae o lo apagas con `Ctrl+C`, el Auth Service lo detectará tras fallar sus heartbeats. Los clientes conectados perderán la conexión, pero el código del frontend interceptará la caída (`ws.onclose`) y solicitará un nuevo coordinador automáticamente (`COORDINATOR_FAILOVER_DELAY_MS`), reconectándose a otro nodo sano si existe.
- Si el **Auth Service** principal se cae, puedes lanzar los scripts `start-auth-2.ps1` y `start-auth-3.ps1` para simular un clúster, demostrando la sincronización P2P en el registro y login.

> **Nota:** Esta versión es considerada un *Prototipo funcional técnico*. Las siguientes iteraciones se enfocarán en mejorar la arquitectura de carpetas, cambiar los "círculos" por sprites/imágenes 2D reales, refinar el diseño del mapa y las interfaces UI.
