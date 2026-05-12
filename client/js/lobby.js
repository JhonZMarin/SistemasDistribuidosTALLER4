import { createGame } from './game.js';

// Global para la sustentación
window.currentGameState = { players: [] }; 
let socket = null;
let myUserId = null;

function initConnection() {
    const token = localStorage.getItem('token');
    if (!token) { window.location.href = 'login.html'; return; }

    socket = new WebSocket(`${window.getWebSocketBaseUrl()}/connect?token=${token}`);

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'welcome') {
            myUserId = msg.you.userId;
            initGame(msg.world);
        }

        if (msg.type === 'state') {
            window.currentGameState = msg; 
            updatePlayersUI(msg.players);
        }
    };

    socket.onclose = () => { window.location.href = 'login.html'; };
}

function initGame(worldConfig) {
    const game = createGame({
        canvas: document.getElementById('gameCanvas'),
        localPlayerId: myUserId,
        options: {
            worldWidth: worldConfig.width,
            worldHeight: worldConfig.height,
            playerRadius: worldConfig.playerRadius
        },
        onIntent: (intent) => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'intent', intent }));
            }
        },
        getRenderState: () => window.currentGameState
    });
    game.start();
}

// --- FEATURES EXTRAS (Mood y Provider Badge) ---

// 1. Mood: Enviar emoji al servidor [cite: 553]
window.updateMood = (emoji) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'extras_update',
            extras: { ...window.currentGameState.players.find(p => p.userId === myUserId)?.extras, mood: emoji }
        }));
    }
};

function updatePlayersUI(players) {
    const list = document.getElementById('players-list');
    if (!list) return;

    list.innerHTML = players.map(p => {
        // Lógica del Provider Badge [cite: 556]
        const badge = p.provider === 'google' ? '🌐' : '🔑';
        const mood = p.extras?.mood || '';

        return `
            <li class="players-list__item ${p.userId === myUserId ? 'players-list__item--current' : ''}">
                <div class="players-list__avatar">
                    ${badge}
                </div>
                <div class="players-list__content">
                    <span class="players-list__name">${p.username} ${mood} ${p.userId === myUserId ? '(Tú)' : ''}</span>
                    <span class="players-list__meta">Autenticado vía ${p.provider}</span>
                </div>
            </li>
        `;
    }).join('');
}

document.getElementById('logout-button').onclick = () => {
    localStorage.clear();
    if (socket) socket.close();
    window.location.href = 'login.html';
};

document.addEventListener("DOMContentLoaded", initConnection);