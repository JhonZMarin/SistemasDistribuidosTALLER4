// ═══════════════════════════════════════════════════════════════════════════
//  ui.js — Manipulación del DOM y Chat (Fase 3)
//  Coordinador — Taller 4
// ═══════════════════════════════════════════════════════════════════════════

export class GameUI {
  constructor() {
    this.statusElem = document.getElementById('connection-status');
    this.coordIdElem = document.getElementById('coordinator-id');
    this.coordUrlElem = document.getElementById('coordinator-url');
    
    this.playersListElem = document.getElementById('players-list');
    this.vitalsListElem = document.getElementById('vitals-list');
    
    // Controles y Modales
    this.btnStartGame = document.getElementById('btn-start-game');
    this.lobbyControls = document.getElementById('lobby-controls');
    this.playingControls = document.getElementById('playing-controls');
    
    // Raza y Rol
    this.breedSelect = document.getElementById('breed-select');
    this.roleDisplay = document.getElementById('role-display');
    this.impostorActions = document.getElementById('impostor-actions');
    this.crewmateActions = document.getElementById('crewmate-actions');
    
    // Acciones in-game
    this.btnKill = document.getElementById('btn-kill');
    this.btnVent = document.getElementById('btn-vent');
    this.btnTask = document.getElementById('btn-task');
    this.btnVitals = document.getElementById('btn-vitals');
    this.btnCallMeeting = document.getElementById('btn-call-meeting');
    
    // Votación y Chat
    this.votingModal = document.getElementById('voting-modal');
    this.meetingCaller = document.getElementById('meeting-caller');
    this.votingList = document.getElementById('voting-list');
    this.btnVoteSkip = document.getElementById('btn-vote-skip');
    this.chatMessages = document.getElementById('chat-messages');
    this.chatInput = document.getElementById('chat-input');
    this.btnSendChat = document.getElementById('btn-send-chat');

    // Estado local para UI
    this.myUserId = null;
    this.isGhost = false;
    this.isImpostor = false;

    // Network Info Modal
    this.btnNetworkInfo = document.getElementById('btn-network-info');
    this.networkInfoContainer = document.getElementById('network-info-btn-container');
    this.networkInfoModal = document.getElementById('network-info-modal');
    this.modalPlayersListElem = document.getElementById('modal-players-list');
    this.modalCoordIdElem = document.getElementById('modal-coordinator-id');
    this.modalCoordUrlElem = document.getElementById('modal-coordinator-url');

    if (this.btnNetworkInfo && this.networkInfoModal) {
        this.btnNetworkInfo.addEventListener('click', () => {
            this.networkInfoModal.showModal();
        });
    }
  }

  // --- Helpers de Seguridad ---
  
  escapeHTML(str) {
    const p = document.createElement('p');
    p.appendChild(document.createTextNode(str));
    return p.innerHTML;
  }

  // --- Actualización de Metadatos ---

  updateConnectionStatus(message, type) {
    if (!this.statusElem) return;
    this.statusElem.textContent = message;
    this.statusElem.className = 'status-badge';
    
    if (type === 'success') this.statusElem.classList.add('status-badge--connected');
    else if (type === 'error') this.statusElem.classList.add('status-badge--disconnected');
    else this.statusElem.classList.add('status-badge--connecting');
  }

  updateCoordinatorInfo(coordinatorId, publicUrl) {
    if (this.coordIdElem) this.coordIdElem.textContent = coordinatorId || '---';
    if (this.coordUrlElem) this.coordUrlElem.textContent = publicUrl || '---';

    if (this.modalCoordIdElem) this.modalCoordIdElem.textContent = coordinatorId || '---';
    if (this.modalCoordUrlElem) this.modalCoordUrlElem.textContent = publicUrl || '---';
  }

  setMyUserId(userId) {
    this.myUserId = userId;
  }

  getSelectedBreed() {
    return this.breedSelect ? this.breedSelect.value : 'siames';
  }

  // --- Renderizado de Listas ---

  updatePlayersList(players) {
    if (!this.playersListElem) return;
    this.playersListElem.innerHTML = '';
    if (this.vitalsListElem) this.vitalsListElem.innerHTML = '';
    
    for (const p of players) {
      const li = document.createElement('li');
      li.className = 'player-item';
      if (p.userId === this.myUserId) li.classList.add('player-item--me');
      if (p.extras?.isGhost) li.style.opacity = '0.5';

      li.innerHTML = `
        <div class="player-item__avatar" style="background: var(--primary);"></div>
        <div class="player-item__info">
          <div class="player-item__name">${this.escapeHTML(p.username)}</div>
          <div class="player-item__status">
            ${p.extras?.isGhost ? 'FANTASMA' : 'VIVO'} 
            ${p.extras?.inVent ? '(DUCTO)' : ''}
          </div>
        </div>
      `;
      this.playersListElem.appendChild(li);

      // Duplicar en el modal de vitales/radar y en el modal de red
      if (this.vitalsListElem) {
        const liVital = li.cloneNode(true);
        this.vitalsListElem.appendChild(liVital);
      }
      if (this.modalPlayersListElem) {
        const liNetwork = li.cloneNode(true);
        this.modalPlayersListElem.appendChild(liNetwork);
      }
    }
  }

  // --- Lógica del Estado del Juego (Lobby vs Playing vs Meeting) ---

  updateGameState(gameState, myPlayer) {
    this.isGhost = myPlayer?.extras?.isGhost || false;
    this.isImpostor = (gameState.impostors && gameState.impostors.includes(this.myUserId));

    const statusText = document.getElementById('game-status');
    if (statusText) {
      statusText.textContent = `Estado: ${gameState.status.toUpperCase()}`;
    }

    if (gameState.status === 'lobby') {
      this.showLobbyControls();
      this.closeModals();
    } else if (gameState.status === 'playing') {
      this.showPlayingControls(gameState.globalTasksCompleted, gameState.globalTasksTotal);
      this.closeModals();
    } else if (gameState.status === 'meeting') {
      this.showMeetingModal(gameState.meeting, myPlayer);
    }
  }

  showLobbyControls() {
    if (this.lobbyControls) this.lobbyControls.style.display = 'block';
    if (this.playingControls) this.playingControls.style.display = 'none';
    const lobbyPanel = document.getElementById('lobby-panel');
    if (lobbyPanel) lobbyPanel.style.display = 'block';
    if (this.networkInfoContainer) this.networkInfoContainer.style.display = 'none';
  }

  showPlayingControls(globalTasks, totalTasks) {
    if (this.lobbyControls) this.lobbyControls.style.display = 'none';
    const lobbyPanel = document.getElementById('lobby-panel');
    if (lobbyPanel) lobbyPanel.style.display = 'none';
    
    if (this.playingControls) this.playingControls.style.display = 'flex';
    if (this.networkInfoContainer) this.networkInfoContainer.style.display = 'block';

    if (this.roleDisplay) {
      if (this.isGhost) {
        this.roleDisplay.textContent = this.isImpostor ? "FANTASMA (Impostor)" : `FANTASMA (Progreso Global: ${globalTasks} / ${totalTasks || '?'})`;
        this.roleDisplay.style.color = "var(--muted)";
      } else if (this.isImpostor) {
        this.roleDisplay.textContent = "ROL: IMPOSTOR";
        this.roleDisplay.style.color = "var(--danger)";
      } else {
        this.roleDisplay.textContent = `ROL: TRIPULANTE (Progreso Global: ${globalTasks} / ${totalTasks || '?'})`;
        this.roleDisplay.style.color = "var(--cyan)";
      }
    }

    if (this.impostorActions) this.impostorActions.style.display = (this.isImpostor && !this.isGhost) ? 'flex' : 'none';
    if (this.crewmateActions) this.crewmateActions.style.display = (!this.isImpostor && !this.isGhost) ? 'flex' : 'none';
  }

  // --- Modales y Reunión ---

  closeModals() {
    if (this.votingModal && this.votingModal.open) this.votingModal.close();
    const vitalsModal = document.getElementById('vitals-modal');
    if (vitalsModal && vitalsModal.open) vitalsModal.close();
    
    // Limpiar chat al cerrar
    if (this.chatMessages) this.chatMessages.innerHTML = '';
  }

  showMeetingModal(meetingContext, myPlayer) {
    if (this.playingControls) this.playingControls.style.display = 'none';
    if (this.lobbyControls) this.lobbyControls.style.display = 'none';

    if (this.votingModal && !this.votingModal.open) {
      this.votingModal.showModal();
    }

    if (this.meetingCaller) {
       this.meetingCaller.textContent = `Llamada por: ${this.escapeHTML(meetingContext.caller)}`;
    }

    // Actualizar timer visual
    const timerElem = document.getElementById('meeting-timer');
    if (timerElem) {
       const left = Math.max(0, Math.floor((meetingContext.endsAt - Date.now()) / 1000));
       timerElem.textContent = `Tiempo restante: ${left}s`;
    }

    // El chat input se oculta si soy fantasma
    const chatSection = document.getElementById('chat-section');
    if (chatSection) {
       const inputs = chatSection.querySelectorAll('input, button');
       inputs.forEach(el => el.disabled = this.isGhost);
    }
  }

  // Genera la lista de jugadores a votar
  renderVotingList(players, currentMeeting, onVoteClick) {
    if (!this.votingList) return;
    this.votingList.innerHTML = '';

    const myVote = currentMeeting?.votes[this.myUserId];

    for (const p of players) {
      if (p.extras?.isGhost) continue; // No se puede votar a un muerto
      
      const li = document.createElement('li');
      li.className = 'player-item';
      li.style.cursor = (!myVote && !this.isGhost) ? 'pointer' : 'default';

      // Contar votos contra este jugador
      let votesReceived = 0;
      for (const target of Object.values(currentMeeting?.votes || {})) {
         if (target === p.userId) votesReceived++;
      }

      const btnHtml = (!myVote && !this.isGhost) ? `<button class="button button--ghost" style="padding: 2px 8px; font-size: 0.8rem;">Votar</button>` : '';

      li.innerHTML = `
        <div class="player-item__avatar" style="background: var(--primary);"></div>
        <div class="player-item__info">
          <div class="player-item__name">${this.escapeHTML(p.username)} ${myVote === p.userId ? '(Tu voto)' : ''}</div>
          <div class="player-item__status" style="color: var(--danger)">${votesReceived} Votos</div>
        </div>
        <div style="margin-left: auto;">${btnHtml}</div>
      `;

      if (!myVote && !this.isGhost) {
        li.onclick = () => onVoteClick(p.userId);
      }
      this.votingList.appendChild(li);
    }
  }

  // --- Chat ---

  appendChatMessage(username, text) {
    if (!this.chatMessages) return;
    const div = document.createElement('div');
    div.style.marginBottom = '4px';
    // XSS Prevention (Track 2.6)
    div.innerHTML = `<strong style="color: var(--cyan);">${this.escapeHTML(username)}:</strong> ${this.escapeHTML(text)}`;
    this.chatMessages.appendChild(div);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  bindChatEvents(onSendChat) {
    if (!this.btnSendChat || !this.chatInput) return;
    
    // Evitamos re-bindear limpiando el evento previo
    const newBtn = this.btnSendChat.cloneNode(true);
    this.btnSendChat.parentNode.replaceChild(newBtn, this.btnSendChat);
    this.btnSendChat = newBtn;

    const newInp = this.chatInput.cloneNode(true);
    this.chatInput.parentNode.replaceChild(newInp, this.chatInput);
    this.chatInput = newInp;

    const send = () => {
       const text = this.chatInput.value.trim();
       if (text) {
          onSendChat(text);
          this.chatInput.value = '';
       }
    };

    this.btnSendChat.addEventListener('click', send);
    this.chatInput.addEventListener('keypress', (e) => {
       if (e.key === 'Enter') send();
    });
  }

  // --- Bind Actions ---

  bindActionEvents(actions) {
    if (this.btnStartGame) this.btnStartGame.onclick = actions.onStartGame;
    if (this.btnKill) this.btnKill.onclick = actions.onKill;
    if (this.btnVent) this.btnVent.onclick = actions.onVent;
    if (this.btnCallMeeting) this.btnCallMeeting.onclick = actions.onCallMeeting;
    if (this.btnVoteSkip) this.btnVoteSkip.onclick = () => actions.onVote('skip');
    
    if (this.btnVitals) {
      this.btnVitals.onclick = () => {
        const vitalsModal = document.getElementById('vitals-modal');
        if (vitalsModal && !vitalsModal.open) vitalsModal.showModal();
      };
    }

    document.getElementById('logout-button')?.addEventListener('click', () => {
      if (window.clearStoredSession) window.clearStoredSession();
      window.location.href = './login.html';
    });
  }

  showGameOver(winnerText) {
    const modal = document.getElementById('game-over-modal');
    const winnerEl = document.getElementById('game-over-winner');
    if (modal && winnerEl) {
      winnerEl.textContent = winnerText;
      modal.showModal();
    }
  }
}
