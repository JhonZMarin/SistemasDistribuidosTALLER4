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
  }

  function drawPlayer(p) {
    const isLocal = p.userId === localPlayerId;
    const color = colorFromId(p.userId);
    const mood = p.extras?.mood || ""; // Obtener el emoji [cite: 553]

    ctx.beginPath();
    ctx.arc(p.x, p.y, opts.playerRadius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.lineWidth = isLocal ? 3 : 1.5;
    ctx.strokeStyle = isLocal ? '#ffffff' : '#000000';
    ctx.stroke();

    // Dibujar Username + Mood [cite: 553]
    ctx.font = '14px Rajdhani, sans-serif';
    ctx.fillStyle = '#e6fbff';
    ctx.textAlign = 'center';
    const text = `${mood} ${p.username}${isLocal ? ' (tú)' : ''}`;
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