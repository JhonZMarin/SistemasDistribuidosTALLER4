// ═══════════════════════════════════════════════════════════════════════════
//  render.js — Maneja el Canvas y el pintado del mundo (Fase 3)
//  Coordinador — Taller 4
// ═══════════════════════════════════════════════════════════════════════════

export class GameRenderer {
  constructor(canvasId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    
    this.worldWidth = options.width || 800;
    this.worldHeight = options.height || 600;
    
    // Fijamos el tamaño visual del canvas
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
    
    this.walls = options.walls || [];
    this.vents = options.vents || [];
    this.vitals = options.vitals || null;
    this.tasks = options.tasks || [];
    this.emergencyButton = options.emergencyButton || null;
    
    this.backgroundColor = '#0f1419';
    this.gridColor = '#1f2730';
    this.gridSize = 40;
    this.playerRadius = 20;

    // Precargar los Sprites de las diferentes razas cosméticas
    this.sprites = {};
    this.loadSprites([
      'siames', 'persa', 'bengala', 'esfinge', 'fantasma'
    ]);
  }

  resizeCanvas() {
    // Soporte para pantallas de alta resolución (Retina, 4K, o zoom de Windows)
    const dpr = window.devicePixelRatio || 1;
    
    // Configurar el tamaño real de la memoria del canvas
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    
    // Configurar el tamaño visual en la pantalla
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
    
    // Escalar todas las coordenadas para que coincidan con la densidad de píxeles
    this.ctx.scale(dpr, dpr);
    
    // IMPORTANTE: Como las imágenes de IA son de alta resolución (no pixel-art de 8 bits),
    // debemos encender el suavizado (anti-aliasing) de alta calidad ('high').
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  initWorld(worldData) {
    this.worldWidth = worldData.width || 3000;
    this.worldHeight = worldData.height || 3000;
    this.walls = worldData.walls || [];
    this.vents = worldData.vents || [];
    this.vitals = worldData.vitals || null;
    this.tasks = worldData.tasks || [];
    this.emergencyButton = worldData.emergencyButton || null;
  }

  loadSprites(breeds) {
    // Inicializar estados de animación para cada raza
    breeds.forEach(breed => {
      this.sprites[breed] = {
        idle: new Image(),
        walk: new Image(),
        dead: new Image()
      };
      
      // Intentamos cargar las imágenes reales desde la carpeta de assets
      // (si no existen en tu PC, el navegador simplemente no las cargará y usaremos el fallback)
      this.sprites[breed].idle.src = `/assets/cats/${breed}_idle.png`;
      this.sprites[breed].walk.src = `/assets/cats/${breed}_walk.png`;
      this.sprites[breed].dead.src = `/assets/cats/${breed}_dead.png`;
    });
  }

  getFallbackColorForBreed(breed) {
    const colors = {
      'siames': '#e3d2b3',
      'persa': '#ffffff',
      'bengala': '#d4af37',
      'esfinge': '#ffcccc',
      'fantasma': '#a0a0a0'
    };
    return colors[breed] || '#cccccc';
  }

  render(players, currentUserId, gameState) {
    // 1. Limpiar todo con el fondo base
    this.ctx.fillStyle = this.backgroundColor;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const myPlayer = players.find(p => p.userId === currentUserId);
    
    this.ctx.save();

    // IMPORTANTE: Al hacer clear y translate, algunas configuraciones del contexto
    // como el smoothing pueden perderse en ciertos navegadores, así que lo forzamos.
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    // 2. Aplicar Transformación de Cámara
    if (myPlayer) {
      // Tomar en cuenta la escala original de la pantalla sin DPR,
      // porque el ctx.scale(dpr, dpr) ya afectó a todo el contexto.
      const offsetX = window.innerWidth / 2 - myPlayer.x;
      const offsetY = window.innerHeight / 2 - myPlayer.y;
      this.ctx.translate(offsetX, offsetY);
    }

    // 3. Dibujar mundo relativo a la cámara
    this.ctx.fillStyle = this.backgroundColor;
    this.ctx.fillRect(0, 0, this.worldWidth, this.worldHeight);
    
    this.drawGrid();
    this.drawMapFeatures();
    
    // 4. Dibujar Cadáveres
    if (gameState && gameState.corpses) {
      for (const corpse of gameState.corpses) {
        this.drawCorpse(corpse);
      }
    }

    // Dividir jugadores vivos y fantasmas para pintar fantasmas primero (al fondo)
    const alivePlayers = [];
    const ghostPlayers = [];

    for (const player of players) {
      if (player.extras?.isGhost) ghostPlayers.push(player);
      else alivePlayers.push(player);
    }

    for (const ghost of ghostPlayers) this.drawPlayer(ghost, currentUserId);
    for (const alive of alivePlayers) this.drawPlayer(alive, currentUserId);
    
    this.ctx.restore();
  }

  drawCorpse(corpse) {
    this.ctx.save();
    const breed = corpse.breed || 'siames';
    const stateSprites = this.sprites[breed] || this.sprites['siames'];
    const img = stateSprites.dead;

    if (img && img.complete && img.naturalWidth > 0) {
      // DIBUJAR SPRITE DE CADÁVER REAL (2x visual, hitbox intacta)
      const visualSize = this.playerRadius * 4;
      const visualOffset = -this.playerRadius * 2;
      this.ctx.drawImage(img, corpse.x + visualOffset, corpse.y + visualOffset, visualSize, visualSize);
    } else {
      // FALLBACK DE CADÁVER (Mitad superior del círculo)
      this.ctx.fillStyle = this.getFallbackColorForBreed(breed);
      this.ctx.globalAlpha = 0.6;
      this.ctx.beginPath();
      this.ctx.arc(corpse.x, corpse.y, this.playerRadius, 0, Math.PI, true);
      this.ctx.fill();
      
      // Huesito asomando
      this.ctx.fillStyle = '#ffffff';
      this.ctx.globalAlpha = 1.0;
      this.ctx.fillRect(corpse.x - 3, corpse.y - 15, 6, 15);
      this.ctx.beginPath();
      this.ctx.arc(corpse.x - 3, corpse.y - 15, 4, 0, Math.PI*2);
      this.ctx.arc(corpse.x + 3, corpse.y - 15, 4, 0, Math.PI*2);
      this.ctx.fill();
    }
    this.ctx.restore();
  }

  drawPlayer(player, currentUserId) {
    if (player.extras?.inVent && player.userId !== currentUserId) {
       // Ocultar si está en la alcantarilla y no somos nosotros
       return; 
    }

    this.ctx.save();
    
    // Configuración para fantasmas
    if (player.extras?.isGhost) {
      this.ctx.globalAlpha = player.userId === currentUserId ? 0.7 : 0.4;
    } else if (player.extras?.inVent) {
      this.ctx.globalAlpha = 0.5; // Nosotros viéndonos en la alcantarilla
    }

    const breed = player.extras?.breed || 'siames';
    const stateSprites = this.sprites[breed] || this.sprites['siames'];
    
    // Determinar si está moviéndose para usar el sprite walk o idle
    const dirX = player.intent?.dir?.x || 0;
    const dirY = player.intent?.dir?.y || 0;
    const isMoving = dirX !== 0 || dirY !== 0;
    const img = isMoving ? stateSprites.walk : stateSprites.idle;

    if (img && img.complete && img.naturalWidth > 0) {
      // 🐾 DIBUJAR SPRITE REAL (2x visual, hitbox intacta)
      const visualSize = this.playerRadius * 4;
      const visualOffset = -this.playerRadius * 2;

      if (player.intent?.dir?.x < 0) {
        this.ctx.translate(player.x, player.y);
        this.ctx.scale(-1, 1);
        this.ctx.drawImage(img, visualOffset, visualOffset, visualSize, visualSize);
      } else {
        this.ctx.drawImage(img, player.x + visualOffset, player.y + visualOffset, visualSize, visualSize);
      }
    } else {
      // ⬛ DIBUJAR FALLBACK
      this.ctx.fillStyle = player.extras?.isGhost ? this.getFallbackColorForBreed('fantasma') : this.getFallbackColorForBreed(breed);
      this.ctx.beginPath();
      this.ctx.arc(player.x, player.y, this.playerRadius, 0, Math.PI * 2);
      this.ctx.fill();
      
      // Borde
      this.ctx.lineWidth = 2;
      this.ctx.strokeStyle = player.userId === currentUserId ? '#00ffff' : '#000000';
      this.ctx.stroke();

      // "Orejas" para que parezca un gato de fallback
      this.ctx.beginPath();
      this.ctx.moveTo(player.x - 10, player.y - 15);
      this.ctx.lineTo(player.x - 15, player.y - 25);
      this.ctx.lineTo(player.x - 5, player.y - 18);
      this.ctx.fillStyle = this.getFallbackColorForBreed(breed);
      this.ctx.fill();
      this.ctx.stroke();
      
      this.ctx.beginPath();
      this.ctx.moveTo(player.x + 10, player.y - 15);
      this.ctx.lineTo(player.x + 15, player.y - 25);
      this.ctx.lineTo(player.x + 5, player.y - 18);
      this.ctx.fillStyle = this.getFallbackColorForBreed(breed);
      this.ctx.fill();
      this.ctx.stroke();
    }

    // Dibujar el nombre (Username)
    this.ctx.fillStyle = player.userId === currentUserId ? '#00ffff' : '#ffffff';
    this.ctx.font = '12px "Rajdhani", sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(player.username, player.x, player.y - this.playerRadius - 10);

    this.ctx.restore();
  }

  drawGrid() {
    this.ctx.strokeStyle = this.gridColor;
    this.ctx.lineWidth = 1;
    for (let x = 0; x <= this.worldWidth; x += this.gridSize) {
      this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, this.worldHeight); this.ctx.stroke();
    }
    for (let y = 0; y <= this.worldHeight; y += this.gridSize) {
      this.ctx.beginPath(); this.ctx.moveTo(0, y); this.ctx.lineTo(this.worldWidth, y); this.ctx.stroke();
    }
  }

  drawMapFeatures() {
    // Muros
    this.ctx.fillStyle = '#2a3441';
    this.ctx.strokeStyle = '#00ffff';
    this.ctx.lineWidth = 2;
    for (const wall of this.walls) {
      this.ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
      this.ctx.strokeRect(wall.x, wall.y, wall.w, wall.h);
    }

    // Alcantarillas (Vents)
    this.ctx.fillStyle = '#111';
    this.ctx.strokeStyle = '#555';
    for (const vent of this.vents) {
      this.ctx.beginPath();
      this.ctx.fillRect(vent.x - 20, vent.y - 15, 40, 30);
      this.ctx.strokeRect(vent.x - 20, vent.y - 15, 40, 30);
    }

    // Tareas
    this.ctx.fillStyle = '#ffcc00';
    this.ctx.strokeStyle = '#cc8800';
    for (const task of this.tasks) {
      this.ctx.beginPath();
      this.ctx.arc(task.x + task.w/2, task.y + task.h/2, task.w/2, 0, Math.PI * 2);
      this.ctx.fill(); this.ctx.stroke();
      this.ctx.fillStyle = '#000000';
      this.ctx.fillText('!', task.x + task.w/2, task.y + task.h/2);
      this.ctx.fillStyle = '#ffcc00'; // Reset para la proxima iteracion
    }

    // Botón de Emergencia
    if (this.emergencyButton) {
      const btn = this.emergencyButton;
      this.ctx.fillStyle = '#e63946';
      this.ctx.beginPath();
      this.ctx.arc(btn.x + btn.w/2, btn.y + btn.h/2, btn.w/2, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.strokeStyle = '#fff';
      this.ctx.stroke();
      this.ctx.fillStyle = '#fff';
      this.ctx.fillText('EMERGENCIA', btn.x + btn.w/2, btn.y + btn.h/2 + 30);
    }

    // Signos Vitales
    if (this.vitals) {
      this.ctx.fillStyle = '#457b9d';
      this.ctx.fillRect(this.vitals.x, this.vitals.y, this.vitals.w, this.vitals.h);
      this.ctx.fillStyle = '#fff';
      this.ctx.fillText('VITALES', this.vitals.x + this.vitals.w/2, this.vitals.y + this.vitals.h/2 + 5);
    }
  }
}
