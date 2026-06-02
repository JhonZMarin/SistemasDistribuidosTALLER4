export function createGame(config) {
  const {
    canvas,
    onIntent,
    getRenderState,
    localPlayerId,
    options = {}
  } = config;

  if (!canvas) throw new Error('createGame: canvas es requerido');
  if (typeof onIntent !== 'function') throw new Error('createGame: onIntent es requerido');
  if (typeof getRenderState !== 'function') throw new Error('createGame: getRenderState es requerido');

  const opts = {
    worldWidth: 800,
    worldHeight: 600,
    playerRadius: 20,
    walls: options.walls || [],
    vents: options.vents || [],
    vitals: options.vitals || null,
    tasks: options.tasks || [],
    emergencyButton: options.emergencyButton || null,
    backgroundColor: '#0f1419',
    gridColor: '#1f2730',
    gridSize: 40,
    ...options
  };

  canvas.width = opts.worldWidth;
  canvas.height = opts.worldHeight;
  const ctx = canvas.getContext('2d');

  const keys = new Set();
  let lastIntent = { x: 0, y: 0 };

  function computeDirection() {
    let x = 0, y = 0;
    if (keys.has('ArrowLeft')  || keys.has('KeyA')) x -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) x += 1;
    if (keys.has('ArrowUp')    || keys.has('KeyW')) y -= 1;
    if (keys.has('ArrowDown')  || keys.has('KeyS')) y += 1;
    return { x, y };
  }

  function maybeEmitIntent() {
    const dir = computeDirection();
    if (dir.x !== lastIntent.x || dir.y !== lastIntent.y) {
      lastIntent = dir;
      onIntent({ type: 'move', dir });
    }
  }

  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (keys.has(e.code)) return;
    keys.add(e.code);
    if (isMovementKey(e.code)) {
      e.preventDefault();
      maybeEmitIntent();
    }
  }

  function onKeyUp(e) {
    if (!keys.has(e.code)) return;
    keys.delete(e.code);
    if (isMovementKey(e.code)) {
      e.preventDefault();
      maybeEmitIntent();
    }
  }

  function onBlur() {
    if (keys.size === 0) return;
    keys.clear();
    maybeEmitIntent();
  }

  function isMovementKey(code) {
    return ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','KeyA','KeyD','KeyW','KeyS'].includes(code);
  }

  function drawBackground() {
    ctx.fillStyle = opts.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = opts.gridColor;
    ctx.lineWidth = 1;
    for (let x = 0; x <= canvas.width; x += opts.gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= canvas.height; y += opts.gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Dibujar ductos (vents)
    ctx.fillStyle = '#444';
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    for (const vent of opts.vents) {
      ctx.beginPath();
      ctx.rect(vent.x - 20, vent.y - 15, 40, 30);
      ctx.fill();
      ctx.stroke();
      
      // Rejilla del ducto
      ctx.beginPath();
      ctx.moveTo(vent.x - 15, vent.y - 5);
      ctx.lineTo(vent.x + 15, vent.y - 5);
      ctx.moveTo(vent.x - 15, vent.y + 5);
      ctx.lineTo(vent.x + 15, vent.y + 5);
      ctx.stroke();
    }

    // Dibujar paredes
    ctx.fillStyle = '#2a3b4c';
    ctx.strokeStyle = '#1e2a38';
    ctx.lineWidth = 4;
    for (const wall of opts.walls) {
      ctx.beginPath();
      ctx.rect(wall.x, wall.y, wall.w, wall.h);
      ctx.fill();
      ctx.stroke();
    }

    // Dibujar Panel de Vitales
    if (opts.vitals) {
      ctx.fillStyle = '#0f52ba';
      ctx.strokeStyle = '#0a3b85';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(opts.vitals.x, opts.vitals.y, opts.vitals.w, opts.vitals.h);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('VITALES', opts.vitals.x + opts.vitals.w / 2, opts.vitals.y + opts.vitals.h / 2);
    }

    // Dibujar Tareas
    ctx.fillStyle = '#ffaa00';
    ctx.strokeStyle = '#cc8800';
    ctx.lineWidth = 2;
    for (const task of opts.tasks) {
      ctx.beginPath();
      ctx.arc(task.x + task.w/2, task.y + task.h/2, task.w/2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#000000';
      ctx.fillText('!', task.x + task.w/2, task.y + task.h/2);
    }

    // Dibujar Botón de Emergencia
    if (opts.emergencyButton) {
      ctx.fillStyle = '#e63946';
      ctx.strokeStyle = '#990000';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(opts.emergencyButton.x + opts.emergencyButton.w/2, opts.emergencyButton.y + opts.emergencyButton.h/2, opts.emergencyButton.w/2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = '14px sans-serif';
      ctx.fillText('🚨', opts.emergencyButton.x + opts.emergencyButton.w/2, opts.emergencyButton.y + opts.emergencyButton.h/2);
    }
  }

  function drawPlayer(p) {
    const isLocal = p.userId === localPlayerId;
    const color = colorFromId(p.userId);
    const isGhost = p.extras?.isGhost;
    const inVent = p.extras?.inVent;

    // Check my state
    const state = getRenderState();
    const myPlayer = state?.players?.find(player => player.userId === localPlayerId);
    const amIGhost = myPlayer?.extras?.isGhost;

    if (inVent && !isLocal) {
        return; // Don't draw others if they are in vent
    }

    if (isGhost && !isLocal && !amIGhost) {
        return; // Vivos no ven a los fantasmas
    }

    ctx.globalAlpha = isGhost ? 0.4 : (inVent ? 0.3 : 1.0);

    ctx.beginPath();
    ctx.arc(p.x, p.y, opts.playerRadius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.lineWidth = isLocal ? 3 : 1.5;
    ctx.strokeStyle = isGhost ? '#555555' : (isLocal ? '#ffffff' : '#000000');
    ctx.stroke();

    if (isGhost) {
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText('👻', p.x, p.y);
    }

    // Dibujar Username
    ctx.globalAlpha = 1.0;
    ctx.font = '14px Rajdhani, sans-serif';
    ctx.fillStyle = '#e6fbff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const text = `${p.username}${isLocal ? ' (tú)' : ''}`;
    ctx.fillText(text, p.x, p.y - opts.playerRadius - 10);
}

  function colorFromId(userId) {
    const hue = (Number(userId) * 137.508) % 360;
    return `hsl(${hue}, 70%, 55%)`;
  }

  function render() {
    const state = getRenderState();
    drawBackground();
    if (!state || !Array.isArray(state.players)) return;
    const sorted = [...state.players].sort((a, b) => {
      if (a.userId === localPlayerId) return 1;
      if (b.userId === localPlayerId) return -1;
      return 0;
    });
    for (const p of sorted) drawPlayer(p);
  }

  let running = false;
  let rafId = null;

  function loop() {
    if (!running) return;
    render();
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    loop();
  }

  function stop() {
    running = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  }

  function destroy() {
    stop();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return { start, stop, destroy, options: opts };
}