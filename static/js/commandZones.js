// Áreas de comando por vídeo — EXCLUSIVO da entrevista (não toca na prova oral).
// Substitui o controle por gesto: quatro/três caixas nos cantos; a mão dentro de
// uma caixa conta 1‑2‑3 e dispara onFire(id). Detecta as DUAS mãos e desenha o
// rastreador (esqueleto). Reusa o HandLandmarker self-hosted em /static/vision.
// Mecânica validada no PoC (static/poc/gesture.html na branch de PoC).
(function () {
  const MP_BASE = '/static/vision';
  const HAND_BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
  const centroidOf = L => { let x=0,y=0; for (const p of L){ x+=p.x; y+=p.y; } return { x:x/L.length, y:y/L.length }; };

  // { videoEl, canvasEl, zones:[{id,corner:'tl'|'tr'|'bl'|'br',label,color}], dwellMs, size, onFire(id), onActive(id|null) }
  // enabledFn(id) → bool: chamado por frame; false = área DESABILITADA (esmaecida,
  // não dispara). Reflete a máquina de estados dos botões (idle: só Gravar; gravando:
  // só Enviar/Cancelar). Sem enabledFn, todas ficam habilitadas.
  window.createCommandZones = function ({ videoEl, canvasEl, zones, dwellMs = 2000, size = 0.24, onFire, onActive, enabledFn }) {
    const octx = canvasEl.getContext('2d');
    let handLm = null, running = true, enabled = true, lastT = null, lastHands = [];
    let Z = zones.map(z => ({ ...z, since: 0, canFire: true }));

    (async () => {
      try {
        const mp = await import(`${MP_BASE}/vision_bundle.mjs`);
        const fs = await mp.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
        handLm = await mp.HandLandmarker.createFromOptions(fs, {
          baseOptions: { modelAssetPath: `${MP_BASE}/models/hand_landmarker.task` },
          runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.3,
        });
      } catch (e) { return; }
      lastT = performance.now();
      requestAnimationFrame(loop);
    })();

    function rectOf(corner) {
      const M = 0.02;
      const w = size, h = size * ((canvasEl.width / canvasEl.height) || 1.333); // caixa quadrada em px
      const left = corner[1] === 'l' ? M : 1 - M - w;
      const top  = corner[0] === 't' ? M : 1 - M - h;
      return { x0: left, x1: left + w, y0: top, y1: top + h };
    }
    const inRect = (c, r) => c && c.x>=r.x0 && c.x<=r.x1 && c.y>=r.y0 && c.y<=r.y1;
    const hexA = (hex, a) => { const n = parseInt(hex.slice(1),16); return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`; };

    function drawHand(L) {
      const W = canvasEl.width, H = canvasEl.height;
      octx.strokeStyle = '#8be0a6'; octx.lineWidth = 2; octx.beginPath();
      for (const [a,b] of HAND_BONES) { octx.moveTo(L[a].x*W, L[a].y*H); octx.lineTo(L[b].x*W, L[b].y*H); }
      octx.stroke();
      octx.fillStyle = '#eaffe9';
      for (const p of L) { octx.beginPath(); octx.arc(p.x*W, p.y*H, 3, 0, 7); octx.fill(); }
    }
    // Texto legível apesar do espelho (CSS scaleX(-1)): desfaz o flip e desenha com
    // CONTORNO escuro (para ler sobre qualquer fundo do vídeo). Fonte já vem escalada.
    function drawText(txt, cx, cy, font, color, baseline) {
      const sz = parseInt((font.match(/(\d+)px/) || [])[1]) || 16;
      octx.save(); octx.translate(canvasEl.width, 0); octx.scale(-1, 1);
      octx.textAlign = 'center'; octx.textBaseline = baseline || 'middle'; octx.font = font;
      octx.lineJoin = 'round'; octx.lineWidth = Math.max(3, sz * 0.18); octx.strokeStyle = 'rgba(0,0,0,.82)';
      const X = canvasEl.width - cx;
      octx.strokeText(txt, X, cy);
      octx.fillStyle = color || '#fff'; octx.fillText(txt, X, cy);
      octx.restore();
    }
    // rótulo CENTRALIZADO no quadrado, auto-ajustado para caber na largura da caixa.
    function drawFitLabel(txt, cx, cy, boxW, maxFont, baseline, color) {
      let f = maxFont;
      octx.font = `bold ${f}px system-ui`;
      while (f > 11 && octx.measureText(txt).width > boxW * 0.9) { f -= 1; octx.font = `bold ${f}px system-ui`; }
      drawText(txt, cx, cy, `bold ${f}px system-ui`, color || '#fff', baseline);
    }
    function draw(hands) {
      const W = canvasEl.width, H = canvasEl.height;
      octx.clearRect(0, 0, W, H);
      for (const L of hands) drawHand(L);
      for (const z of Z) {
        const r = z._r || rectOf(z.corner);
        const x = r.x0*W, y = r.y0*H, w = (r.x1-r.x0)*W, h = (r.y1-r.y0)*H;
        if (!z._on) { // DESABILITADA: esmaecida, tracejada, sem contagem
          octx.fillStyle = 'rgba(110,110,110,0.16)'; octx.fillRect(x, y, w, h);
          octx.strokeStyle = 'rgba(200,200,200,0.45)'; octx.lineWidth = 3; octx.setLineDash([7, 6]); octx.strokeRect(x, y, w, h); octx.setLineDash([]);
          drawFitLabel(z.label, x + w/2, y + h/2, w, Math.round(W * 0.042), 'middle', 'rgba(255,255,255,0.5)');
          continue;
        }
        const inside = z._inside;
        const progress = Math.min(100, (z.since/dwellMs)*100);
        const count = inside && z.since>0 ? Math.min(3, Math.floor(z.since/(dwellMs/3))+1) : 0;
        octx.fillStyle = hexA(z.color, inside ? 0.32 : 0.18); octx.fillRect(x, y, w, h);
        if (inside && progress>0) { octx.fillStyle = hexA(z.color, 0.55); const fh = h*(progress/100); octx.fillRect(x, y+h-fh, w, fh); }
        octx.strokeStyle = z.color; octx.lineWidth = inside ? 6 : 4; octx.strokeRect(x, y, w, h);
        if (count > 0) { // contando: rótulo pequeno no topo + número grande no centro
          drawFitLabel(z.label, x + w/2, y + Math.max(11, W * 0.026), w, Math.round(W * 0.032), 'top', '#fff');
          drawText(String(count), x + w/2, y + h/2 + Math.round(W * 0.02), `bold ${Math.round(W * 0.15)}px system-ui`, '#fff', 'middle');
        } else { // parado: rótulo centralizado no quadrado
          drawFitLabel(z.label, x + w/2, y + h/2, w, Math.round(W * 0.042), 'middle', '#fff');
        }
      }
    }
    function loop() {
      if (!running) return;
      const now = performance.now();
      const dt = now - (lastT || now); lastT = now;
      if (videoEl.videoWidth && canvasEl.width !== videoEl.videoWidth) { canvasEl.width = videoEl.videoWidth; canvasEl.height = videoEl.videoHeight; }
      let res = null;
      if (handLm && videoEl.readyState >= 2) { try { res = handLm.detectForVideo(videoEl, now); } catch {} }
      const hands = (res && res.landmarks) ? res.landmarks : [];
      lastHands = hands;
      const centroids = hands.map(centroidOf);
      let active = null;
      for (const z of Z) {
        const r = rectOf(z.corner);
        const on = enabledFn ? !!enabledFn(z.id) : true; // máquina de estados por zona
        const inside = on && centroids.some(c => inRect(c, r));
        if (!inside) { z.canFire = true; z.since = 0; }
        else { z.since += dt; if (enabled && z.since >= dwellMs && z.canFire) { z.canFire = false; z.since = 0; onFire && onFire(z.id); } }
        z._r = r; z._on = on; z._inside = inside;
        if (inside) active = z.id;
      }
      draw(hands);
      onActive && onActive(active);
      requestAnimationFrame(loop);
    }

    return {
      stop() { running = false; try { handLm && handLm.close && handLm.close(); } catch {} try { octx.clearRect(0,0,canvasEl.width,canvasEl.height); } catch {} },
      setEnabled(v) { enabled = v; },
      setZones(nz) { Z = nz.map(z => ({ ...z, since: 0, canFire: true })); },
      getHands() { return lastHands; },
    };
  };
})();
