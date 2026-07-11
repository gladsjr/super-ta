// Controle por GESTO da entrevista com proctoring — CAMADA PARALELA.
// EXCLUSIVO da entrevista (não toca na prova oral). Reconhece três poses estáticas
// (palma aberta / V / punho) sobre a câmera e apenas DISPARA callbacks — que, na
// student.html, clicam os botões de gravar/enviar/cancelar já existentes. O
// pipeline de áudio/STT não muda em nada. Esquema validado no PoC:
//   guardas = mão LEVANTADA (acima de uma linha) + TRANSIÇÃO (relaxar entre
//   comandos) + PALMA virada p/ a câmera (todos os gestos) + SEGURAR (~0,8 s).
//   palma = COMEÇAR · V = ENVIAR · punho = CANCELAR.
(function () {
  const MP_BASE = '/static/vision';
  const HOLD_MS = 800, MIN_CONF = 0.40, RAISE_Y = 0.55, FACING_COS = 0.35;

  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const fingerExtended = (L, tip, pip) => d(L[tip], L[0]) > d(L[pip], L[0]) * 1.03;
  function palmFacingCamera(L, handed) {
    const v1 = { x: L[5].x - L[0].x, y: L[5].y - L[0].y, z: (L[5].z || 0) - (L[0].z || 0) };
    const v2 = { x: L[17].x - L[0].x, y: L[17].y - L[0].y, z: (L[17].z || 0) - (L[0].z || 0) };
    const nx = v1.y * v2.z - v1.z * v2.y, ny = v1.z * v2.x - v1.x * v2.z, nz = v1.x * v2.y - v1.y * v2.x;
    const mag = Math.hypot(nx, ny, nz) || 1;
    let score = -(nz / mag);
    if (handed === 'Left') score = -score;
    return score > FACING_COS;
  }
  function classify(L) {
    const idx = fingerExtended(L, 8, 6), mid = fingerExtended(L, 12, 10), ring = fingerExtended(L, 16, 14), pink = fingerExtended(L, 20, 18);
    const n = [idx, mid, ring, pink].filter(Boolean).length;
    if (idx && mid && ring && pink) return 'OPEN_PALM';
    if (idx && mid && !ring && !pink) return 'V_SIGN';
    if (n === 0) return 'FIST';
    return 'NONE';
  }
  const CMD = { OPEN_PALM: 'start', V_SIGN: 'send', FIST: 'cancel' };

  // { videoEl, onCommand(kind), onFeedback({pose,progress,label}) } → { stop() }
  window.createGestureControl = function ({ videoEl, onCommand, onFeedback }) {
    let handLm = null, running = true, heldPose = 'NONE', heldSince = 0, canFire = false, lastT = null;

    (async () => {
      try {
        const mp = await import(`${MP_BASE}/vision_bundle.mjs`);
        const fs = await mp.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
        handLm = await mp.HandLandmarker.createFromOptions(fs, {
          baseOptions: { modelAssetPath: `${MP_BASE}/models/hand_landmarker.task` },
          runningMode: 'VIDEO', numHands: 1, minHandDetectionConfidence: 0.3,
        });
      } catch (e) { onFeedback && onFeedback({ pose: 'ERR', progress: 0, label: 'Gesto indisponível — use os botões.' }); return; }
      lastT = performance.now();
      requestAnimationFrame(loop);
    })();

    function loop() {
      if (!running) return;
      const now = performance.now();
      const dt = now - (lastT || now); lastT = now;
      let valid = 'NONE', label = null;
      if (handLm && videoEl.readyState >= 2) {
        let res = null; try { res = handLm.detectForVideo(videoEl, now); } catch {}
        if (res && res.landmarks && res.landmarks.length) {
          const L = res.landmarks[0];
          const handed = res.handedness?.[0]?.[0]?.categoryName || 'Right';
          const conf = res.handedness?.[0]?.[0]?.score ?? 1;
          const pose = conf >= MIN_CONF ? classify(L) : 'NONE';
          const raised = L[0].y < RAISE_Y;
          if (CMD[pose] && raised && palmFacingCamera(L, handed)) valid = pose;
          if (pose !== 'NONE' && !raised) label = 'Levante a mão (com a palma p/ a câmera) para comandar.';
        }
      }
      let progress = 0;
      if (valid === 'NONE') { canFire = true; heldPose = 'NONE'; heldSince = 0; }
      else {
        if (valid === heldPose) {
          heldSince += dt;
          progress = Math.min(100, (heldSince / HOLD_MS) * 100);
          if (heldSince >= HOLD_MS && canFire) { onCommand && onCommand(CMD[valid]); canFire = false; heldSince = 0; progress = 0; }
        } else { heldPose = valid; heldSince = 0; }
      }
      onFeedback && onFeedback({ pose: valid, progress, label });
      requestAnimationFrame(loop);
    }

    return {
      stop() { running = false; try { handLm && handLm.close && handLm.close(); } catch {} },
    };
  };
})();
