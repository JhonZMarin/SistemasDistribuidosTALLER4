// ═══════════════════════════════════════════════════════════════════════════
//  network.js — Lógica de Red y Websockets (Fase 3)
//  Coordinador — Taller 4
// ═══════════════════════════════════════════════════════════════════════════

export class GameNetwork {
  constructor(options = {}) {
    this.socket = null;
    this.reconnectTimer = null;
    
    // Callbacks que inyectará main.js
    this.onWelcome = options.onWelcome || (() => {});
    this.onState = options.onState || (() => {});
    this.onChat = options.onChat || (() => {});
    this.onGameOver = options.onGameOver || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    
    // Config de conexión
    this.token = window.getStoredToken();
    this.coordinatorId = null;
    this.publicUrl = null;
  }

  // --- 1. Client-Side Load Balancing & Failover ---
  
  async getCoordinator() {
    this.onStatusChange('Obteniendo coordinador asignado...', 'info');
    // window.requestCoordinatorAssignment ya existe en auth.js, o podemos reimplementarlo aquí.
    // Lo llamamos directamente para obtener el nodo vivo.
    const result = await window.requestCoordinatorAssignment();
    
    if (!result.ok) {
      throw new Error(`Fallo al obtener coordinador: ${result.error}`);
    }
    
    this.coordinatorId = result.coordinatorId;
    this.publicUrl = result.publicUrl;
    return result;
  }

  // Construye la URL del websocket reemplazando http por ws
  getWsUrl() {
    if (!this.publicUrl) return null;
    const wsBase = this.publicUrl.replace(/^http/i, 'ws');
    return `${wsBase}/connect?token=${this.token}`;
  }

  // Conexión inicial o reconexión (Failover)
  async connect() {
    if (!this.token) {
      this.onStatusChange('No hay sesión. Por favor inicia sesión.', 'error');
      window.location.href = './login.html';
      return;
    }

    try {
      // 1. Obtener nodo vivo (Load Balancing / Failover)
      await this.getCoordinator();
      
      // 2. Conectar al WebSocket
      this.openSocket();
    } catch (err) {
      this.onStatusChange(err.message, 'error');
      this.scheduleReconnect();
    }
  }

  openSocket() {
    const wsUrl = this.getWsUrl();
    if (!wsUrl) return;

    this.onStatusChange(`Conectando a ${this.coordinatorId}...`, 'info');
    this.socket = new WebSocket(wsUrl);

    this.socket.onopen = () => {
      this.onStatusChange('Conectado', 'success');
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.socket.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    this.socket.onclose = () => {
      this.onStatusChange('Desconectado. Reintentando...', 'error');
      // Importante: No reconectamos a la misma URL. Volvemos a pedir un coordinador vivo.
      this.socket = null;
      this.scheduleReconnect();
    };

    this.socket.onerror = () => {
      this.onStatusChange('Error de red detectado.', 'error');
      // onclose will fire after error and trigger reconnect
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(); // Obtiene coordinador nuevo y conecta
    }, 3000);
  }

  // --- 2. Manejo de Mensajes ---

  handleMessage(dataStr) {
    let msg;
    try {
      msg = JSON.parse(dataStr);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case 'welcome':
        this.onWelcome(msg);
        break;
      case 'state':
        this.onState(msg);
        break;
      case 'chat_replicate':
        this.onChat(msg);
        break;
      case 'game_over':
        this.onGameOver(msg);
        break;
      default:
        break;
    }
  }

  // --- 3. Enviar Intenciones (Acciones del Jugador) ---

  sendIntent(intentPayload) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        type: 'intent',
        intent: intentPayload
      }));
    }
  }

  // --- 4. Redirección de Líder (Sobreescribe auth.js logic dinámicamente) ---

  /**
   * Este método inyecta lógica en auth.js (o se puede llamar desde allá)
   * para interceptar los 503 "not_leader" y redirigir el fetch a la URL del líder.
   */
  static applyLeaderRedirectionToAuth() {
    // Interceptamos la función original de enviar auth (definida en auth.js)
    if (typeof window.sendAuthRequest !== 'function') return;
    
    const originalSendAuthRequest = window.sendAuthRequest;
    
    window.sendAuthRequest = async function(path, payload, attempt = 1, forceBaseUrl = null) {
      try {
        // Usamos la baseUrl forzada (el lider redireccionado) o la por defecto
        const baseUrl = forceBaseUrl || window.getAuthBaseUrl();
        const response = await fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "ngrok-skip-browser-warning": "1",
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });
        
        let data = null;
        if (response.headers.get("content-type")?.includes("application/json")) {
           data = await response.json();
        }

        // REDIRECCIÓN DE LÍDER (Taller 4)
        if (response.status === 503 && data?.error === "not_leader" && data?.leaderUrl) {
           if (attempt >= 3) return { ok: false, status: 503, data: { error: "Max redirections reached" } };
           
           console.log(`[Redirección] Nodo no es líder. Reintentando contra el líder real: ${data.leaderUrl}`);
           const cleanLeaderUrl = data.leaderUrl.replace(/\/+$/, "");
           return await window.sendAuthRequest(path, payload, attempt + 1, cleanLeaderUrl);
        }

        return { ok: response.ok, status: response.status, data };
      } catch (error) {
        return { ok: false, status: 0, data: null };
      }
    };
  }
}

// Inyectar el patch de Auth tan pronto se cargue el módulo
GameNetwork.applyLeaderRedirectionToAuth();
