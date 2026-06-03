// ═══════════════════════════════════════════════════════════════════════════
//  main.js — Orquestador del Cliente (Fase 3)
//  Coordinador — Taller 4
// ═══════════════════════════════════════════════════════════════════════════

import { GameNetwork } from './network.js';
import { GameUI } from './ui.js';
import { GameRenderer } from './render.js';

class GameClient {
  constructor() {
    this.ui = new GameUI();
    this.network = new GameNetwork({
      onWelcome: this.onWelcome.bind(this),
      onState: this.onState.bind(this),
      onChat: this.onChat.bind(this),
      onGameOver: this.onGameOver.bind(this),
      onStatusChange: this.onStatusChange.bind(this)
    });

    this.renderer = null; // Se inicializa en onWelcome cuando nos envían el WORLD
    this.gameState = null;
    this.players = [];
    this.myPlayer = null;

    // Teclas de movimiento
    this.keys = { w: false, a: false, s: false, d: false };
    
    this.bindEvents();
    this.start();
  }

  start() {
    // 1. Iniciar la conexión de red (Load Balancing + WebSocket)
    this.network.connect();
    
    // 2. Iniciar el loop de inputs (envío a 20 FPS al servidor)
    setInterval(() => this.sendMovementIntent(), 1000 / 20);
  }

  bindEvents() {
    // Teclado
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (this.keys.hasOwnProperty(key)) this.keys[key] = true;
    });

    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      if (this.keys.hasOwnProperty(key)) this.keys[key] = false;
    });

    // Acciones in-game desde la UI
    this.ui.bindActionEvents({
      onStartGame: () => {
        const impostors = parseInt(document.getElementById('config-impostors')?.value) || 1;
        const tasks = parseInt(document.getElementById('config-tasks')?.value) || 4;
        this.network.sendIntent({ type: 'start_game', config: { impostors, tasks } });
      },
      onKill: () => this.network.sendIntent({ type: 'kill' }),
      onVent: () => this.network.sendIntent({ type: 'vent' }),
      onCallMeeting: () => this.network.sendIntent({ type: 'call_meeting' }),
      onVote: (targetId) => this.network.sendIntent({ type: 'vote', targetId })
    });

    if (this.ui.btnTask) {
      this.ui.btnTask.onclick = () => this.network.sendIntent({ type: 'do_task' });
    }

    // Evento para cambiar de raza en tiempo real
    if (this.ui.breedSelect) {
      this.ui.breedSelect.addEventListener('change', () => {
        const selectedBreed = this.ui.getSelectedBreed();
        this.network.sendIntent({ 
          type: 'update_extras', 
          extras: { breed: selectedBreed } 
        });
      });
    }

    // Bind del evento de Chat
    this.ui.bindChatEvents((text) => {
      this.network.sendIntent({ type: 'chat', text });
    });
  }

  // --- Network Callbacks ---

  onStatusChange(msg, type) {
    this.ui.updateConnectionStatus(msg, type);
  }

  onWelcome(msg) {
    this.ui.updateCoordinatorInfo(msg.coordinatorId, this.network.publicUrl);
    this.ui.setMyUserId(msg.you.userId);
    
    if (!this.renderer) {
      this.renderer = new GameRenderer('gameCanvas', msg.world);
      // Animación local a 60 FPS
      requestAnimationFrame(() => this.renderLoop());
    }
  }

  onState(msg) {
    this.gameState = msg.gameState;
    this.players = msg.players;
    
    this.myPlayer = this.players.find(p => p.userId === this.ui.myUserId);

    this.ui.updateGameState(this.gameState, this.myPlayer);
    this.ui.updatePlayersList(this.players);

    // Lógica adicional para Tareas de Tripulante (Mostrar botón de tarea)
    if (this.gameState.status === 'playing' && this.myPlayer && !this.myPlayer.extras?.isGhost) {
      if (!this.ui.isImpostor) {
        let isNearTask = false;
        for (const task of this.renderer.tasks) {
          const cx = task.x + task.w/2;
          const cy = task.y + task.h/2;
          if (Math.hypot(cx - this.myPlayer.x, cy - this.myPlayer.y) <= 80) {
            isNearTask = true; break;
          }
        }
        if (this.ui.btnTask) this.ui.btnTask.style.display = isNearTask ? 'block' : 'none';
      }

      // Reunión de Emergencia (botón o cadaver)
      const btn = this.renderer.emergencyButton;
      let isNearButton = false;
      if (btn) {
        isNearButton = Math.hypot((btn.x + btn.w/2) - this.myPlayer.x, (btn.y + btn.h/2) - this.myPlayer.y) <= 80;
      }
      
      let isNearCorpse = false;
      if (!isNearButton) {
        for (const p of this.players) {
          if (p.extras?.isGhost && p.userId !== this.myPlayer.userId) {
            if (Math.hypot(p.x - this.myPlayer.x, p.y - this.myPlayer.y) <= 80) { isNearCorpse = true; break; }
          }
        }
      }

      if (this.ui.btnCallMeeting) {
         this.ui.btnCallMeeting.style.display = (isNearButton || isNearCorpse) ? 'block' : 'none';
         this.ui.btnCallMeeting.textContent = isNearCorpse ? '🚨 REPORTAR CADÁVER' : '🚨 LLAMAR REUNIÓN';
      }

      // Panel de Vitales
      const vitals = this.renderer.vitals;
      let isNearVitals = false;
      if (vitals) {
        isNearVitals = Math.hypot((vitals.x + vitals.w/2) - this.myPlayer.x, (vitals.y + vitals.h/2) - this.myPlayer.y) <= 80;
      }
      if (this.ui.btnVitals) {
         this.ui.btnVitals.style.display = isNearVitals ? 'block' : 'none';
      }

    } else {
      if (this.ui.btnTask) this.ui.btnTask.style.display = 'none';
      if (this.ui.btnCallMeeting) this.ui.btnCallMeeting.style.display = 'none';
      if (this.ui.btnVitals) this.ui.btnVitals.style.display = 'none';
    }

    // Actualizar timer en reuniones y redibujar lista de votos
    if (this.gameState.status === 'meeting') {
       this.ui.renderVotingList(this.players, this.gameState.meeting, (targetId) => {
         this.network.sendIntent({ type: 'vote', targetId });
       });
    }
  }

  onChat(msg) {
    this.ui.appendChatMessage(msg.username, msg.text);
  }

  onGameOver(msg) {
    const winnerText = msg.winner === 'crewmates' ? '¡TRIPULANTES GANAN!' : '¡IMPOSTORES GANAN!';
    this.ui.showGameOver(winnerText);
  }

  // --- Game Loop (Movimiento y Render) ---

  sendMovementIntent() {
    if (!this.myPlayer || this.gameState?.status !== 'playing') return;
    
    let dx = 0, dy = 0;
    if (this.keys.w) dy -= 1;
    if (this.keys.s) dy += 1;
    if (this.keys.a) dx -= 1;
    if (this.keys.d) dx += 1;

    // Enviar el movimiento
    this.network.sendIntent({ 
      type: 'move', 
      dir: { x: dx, y: dy }
    });
  }

  renderLoop() {
    if (this.renderer && this.players && this.gameState) {
       this.renderer.render(this.players, this.ui.myUserId, this.gameState);
    }
    requestAnimationFrame(() => this.renderLoop());
  }
}

// Iniciar Cliente
function init() {
  if (document.body.dataset.page === 'lobby') {
    window.gameClient = new GameClient();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
