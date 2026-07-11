// Setup de PROCTORING POR VÍDEO da ENTREVISTA por mensagem.
// EXCLUSIVO da entrevista — não importa nem altera nada da prova oral. Renderiza
// duas telas num container e chama onDone() quando o aluno clica "Começar
// entrevista". NUNCA bloqueia: as checagens só orientam o começo (espelha a
// filosofia do setup da prova oral, mas com código próprio).
//
// Uso (na student.html, script clássico):
//   await window.runProctoringSetup({ submissionToken, config, container, onDone });
// `config` = payload de GET /s/:t/setup-config: { proctoring_enabled, calibration }.
(function () {
  const MP_BASE = '/static/vision';
  const POSE_IMG_BASE = '/static/oral-poses/';
  const NOISE_MAX_RMS = 0.035;      // limiar de "barulhento" (mesma sensibilidade da oral)
  const FACE_MAX = 0.16, FACE_MIN = 0.06; // distância pela largura da face (orelha a orelha)
  const MAX_ATTEMPTS = 2;

  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  window.runProctoringSetup = function ({ submissionToken, config, container, onDone }) {
    return new Promise((resolve) => {
      const calib = config && config.calibration && config.calibration.enabled ? config.calibration : null;
      let camStream = null, micStream = null, noiseCtx = null, noiseRAF = 0, posRAF = 0;
      let poseLm = null, handLm = null, objDet = null, calibRecording = false;

      // ---------- markup ----------
      container.innerHTML = `
        <div id="ps-root" style="max-width:520px;margin:0 auto">
          <!-- Tela 1: conexão + ruído + calibração -->
          <div id="ps-screen1">
            <p style="background:#eef4ff;border:1px solid #cfe0f5;border-radius:8px;padding:8px 12px;margin:0 0 12px"><strong>🎧 Use fones de ouvido.</strong></p>
            <div id="ps-conn" style="text-align:center;font-weight:600;padding:10px;border-radius:8px;background:#fff7e6;border:1px solid #f0d69a;color:#8a6d1a">Testando a conexão…</div>
            <div style="margin:14px auto 0">
              <div style="text-align:center;color:#667;font-size:13px;margin-bottom:4px">Nível de ruído do ambiente</div>
              <div style="height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden"><div id="ps-noise-bar" style="height:100%;width:0;background:#2f9e56;transition:width .1s linear"></div></div>
              <div id="ps-noise-verdict" style="text-align:center;font-weight:600;padding:6px;border-radius:8px;background:#fff7e6;border:1px solid #f0d69a;color:#8a6d1a;margin-top:6px">Medindo o ambiente…</div>
            </div>
            ${calib ? `
            <div style="margin-top:18px;border-top:1px solid #e5e7eb;padding-top:14px">
              <p style="margin:0 0 4px"><strong>Teste de captação da sua fala.</strong> Vamos conferir se o sistema transcreve bem o que você fala — a sua nota sai da transcrição, então isso ajuda a avaliação a refletir a sua resposta.</p>
              <p style="margin:0 0 8px;color:#667;font-size:13px">Fale em <strong>volume médio</strong>, num <strong>ritmo tranquilo</strong> (sem correr) e <strong>sem cortar o fim das palavras</strong>. Leia a frase abaixo em voz alta:</p>
              <div style="text-align:center;font-size:18px;line-height:1.5;margin:0 0 10px;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#fafafa">${esc(calib.sentence)}</div>
              <div style="text-align:center"><button id="ps-calib-rec" type="button" style="cursor:pointer;font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #cbd3e1;background:#2563eb;color:#fff">🎤 Gravar e ler a frase</button></div>
              <div id="ps-calib-status" style="text-align:center;padding:8px;border-radius:8px;background:#f3f4f6;color:#556;margin-top:12px">Quando estiver pronto, toque em “Gravar e ler a frase”.</div>
            </div>` : ''}
            <div style="margin-top:18px;text-align:center"><button id="ps-to-check" type="button" style="cursor:pointer;font:inherit;padding:10px 18px;border-radius:8px;border:none;background:#2563eb;color:#fff">Continuar</button></div>
          </div>

          <!-- Tela 2: posição por câmera -->
          <div id="ps-screen2" style="display:none">
            <p style="margin:0 0 8px"><strong>Posição:</strong> tronco à cabeça no quadro; ~1,5 m da câmera; mãos à mostra.</p>
            <div style="display:flex;gap:10px;max-width:320px;margin:8px auto 10px">
              <figure style="margin:0;flex:1"><img src="${POSE_IMG_BASE}com-mesa__m__branco.jpg" alt="exemplo com mesa" style="width:100%;border:1px solid #e5e7eb;border-radius:10px;display:block"/><figcaption style="text-align:center;color:#667;font-size:12px;margin-top:3px">Com mesa</figcaption></figure>
              <figure style="margin:0;flex:1"><img src="${POSE_IMG_BASE}sem-mesa__f__negra.jpg" alt="exemplo sem mesa" style="width:100%;border:1px solid #e5e7eb;border-radius:10px;display:block"/><figcaption style="text-align:center;color:#667;font-size:12px;margin-top:3px">Sem mesa</figcaption></figure>
            </div>
            <div style="background:#fffbeb;border:1px solid #f0e0a0;border-radius:8px;padding:8px 12px;margin:0 0 10px;color:#7a5c12"><strong>Importante:</strong> a entrevista não será interrompida por posicionamento inadequado, porém o vídeo fica gravado e é analisado.</div>
            <div style="text-align:center;color:#667;font-size:13px;margin-bottom:4px">Sua câmera</div>
            <video id="ps-cam" autoplay muted playsinline style="width:100%;max-width:300px;border-radius:10px;background:#000;transform:scaleX(-1);display:block;margin:0 auto 10px"></video>
            <div id="ps-pos-guidance" style="text-align:center;font-weight:600;padding:10px;border-radius:8px;background:#fff7e6;border:1px solid #f0d69a;color:#8a6d1a">Iniciando a câmera…</div>
            <div style="margin-top:14px;text-align:center"><button id="ps-begin" type="button" style="cursor:pointer;font:inherit;padding:10px 18px;border-radius:8px;border:none;background:#2563eb;color:#fff">Começar entrevista</button></div>
            <div id="ps-err" style="color:#c0453b;text-align:center;margin-top:8px"></div>
          </div>
        </div>`;

      const $ = id => container.querySelector('#' + id);
      const banner = (el, text, kind) => {
        el.textContent = text;
        const c = kind === 'ok' ? ['#eaf7ef', '#a9dcbd', '#1e6b3b'] : kind === 'bad' ? ['#fdecec', '#f0b4b4', '#8a2020'] : ['#fff7e6', '#f0d69a', '#8a6d1a'];
        el.style.background = c[0]; el.style.borderColor = c[1]; el.style.color = c[2];
      };

      // ---------- 1) Conexão (ping simples ao servidor) ----------
      (async () => {
        const times = [];
        for (let i = 0; i < 3; i++) {
          const t0 = performance.now();
          try { await fetch(`/s/${submissionToken}/setup-config`, { cache: 'no-store' }); times.push(performance.now() - t0); } catch {}
        }
        if (times.length) { times.sort((a, b) => a - b); banner($('ps-conn'), `Conexão ok ✓ (~${Math.round(times[Math.floor(times.length / 2)])} ms)`, 'ok'); }
        else banner($('ps-conn'), 'Conexão instável — verifique sua internet.', 'bad');
      })();

      // ---------- 2) Medidor de ruído (Web Audio RMS + EMA) ----------
      (async () => {
        try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
        catch { banner($('ps-noise-verdict'), 'Não foi possível medir o ruído (microfone).', 'bad'); return; }
        noiseCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = noiseCtx.createMediaStreamSource(micStream);
        const an = noiseCtx.createAnalyser(); an.fftSize = 2048; src.connect(an);
        const buf = new Float32Array(an.fftSize);
        let ema = null;
        const tick = () => {
          if (calibRecording) { banner($('ps-noise-verdict'), 'Medição de ruído pausada durante a leitura', 'wait'); noiseRAF = requestAnimationFrame(tick); return; }
          an.getFloatTimeDomainData(buf);
          let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / buf.length);
          ema = ema == null ? rms : ema * 0.85 + rms * 0.15;
          $('ps-noise-bar').style.width = Math.min(100, (rms / (NOISE_MAX_RMS * 2)) * 100) + '%';
          if (ema <= NOISE_MAX_RMS) { banner($('ps-noise-verdict'), 'Silêncio ok ✓', 'ok'); $('ps-noise-bar').style.background = '#2f9e56'; }
          else { banner($('ps-noise-verdict'), 'Ambiente barulhento — procure um lugar mais silencioso.', 'bad'); $('ps-noise-bar').style.background = '#c0453b'; }
          noiseRAF = requestAnimationFrame(tick);
        };
        tick();
      })();

      // ---------- 3) Calibração de fala (opcional) ----------
      let calibRec = null, calibChunks = [], calibAttempt = 0;
      if (calib) {
        const recBtn = $('ps-calib-rec'), stat = $('ps-calib-status');
        recBtn.onclick = async () => {
          if (!calibRecording) {
            if (!micStream) { banner(stat, 'Microfone indisponível.', 'bad'); return; }
            calibChunks = [];
            let mime = 'audio/webm;codecs=opus';
            if (!(window.MediaRecorder && MediaRecorder.isTypeSupported(mime))) mime = '';
            try { calibRec = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream); } catch { banner(stat, 'Gravação não suportada neste navegador.', 'bad'); return; }
            calibRec.ondataavailable = e => { if (e.data && e.data.size) calibChunks.push(e.data); };
            calibRec.onstop = () => submitCalib();
            calibRecording = true; calibRec.start();
            recBtn.textContent = '⏹ Parar e verificar';
            banner(stat, '🔴 Gravando… leia a frase e toque em “Parar e verificar”.', 'wait');
          } else {
            calibRecording = false; recBtn.disabled = true;
            try { calibRec.stop(); } catch {}
          }
        };
        async function submitCalib() {
          calibAttempt++;
          banner(stat, 'Verificando a captação…', 'wait');
          try {
            const blob = new Blob(calibChunks, { type: (calibRec && calibRec.mimeType) || 'audio/webm' });
            const form = new FormData(); form.append('file', blob, 'calib.webm'); form.append('attempt', String(calibAttempt));
            const r = await fetch(`/s/${submissionToken}/calibrate`, { method: 'POST', body: form });
            const j = await r.json();
            recBtn.disabled = false;
            if (!r.ok) { banner(stat, 'Não deu para verificar agora — você pode seguir mesmo assim.', 'wait'); recBtn.textContent = '🎤 Tentar de novo'; return; }
            if (j.ok) { banner(stat, 'Captação ok ✓ — sua fala foi transcrita bem.', 'ok'); recBtn.style.display = 'none'; }
            else if (calibAttempt < MAX_ATTEMPTS) { banner(stat, (j.advice || 'Tente de novo, um pouco mais devagar e claro.'), 'wait'); recBtn.textContent = '🎤 Tentar mais uma vez'; }
            else { banner(stat, 'Seguimos assim. Ao final, confira a transcrição e, se algo saiu errado, avise o professor.', 'wait'); recBtn.style.display = 'none'; }
          } catch { recBtn.disabled = false; banner(stat, 'Falha de comunicação — você pode seguir mesmo assim.', 'wait'); recBtn.textContent = '🎤 Tentar de novo'; }
        }
      }

      // ---------- passagem para a tela 2 ----------
      $('ps-to-check').onclick = () => {
        if (noiseRAF) cancelAnimationFrame(noiseRAF), noiseRAF = 0;
        try { noiseCtx && noiseCtx.close(); } catch {}
        try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch {} // libera o mic; a câmera abre agora
        micStream = null;
        $('ps-screen1').style.display = 'none';
        $('ps-screen2').style.display = '';
        startPositionCheck();
      };

      // ---------- 4) Posição por câmera (MediaPipe) ----------
      async function initVision() {
        const mp = await import(`${MP_BASE}/vision_bundle.mjs`);
        const fs = await mp.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
        [poseLm, handLm, objDet] = await Promise.all([
          mp.PoseLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: `${MP_BASE}/models/pose_landmarker_lite.task` }, runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.5 }),
          mp.HandLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: `${MP_BASE}/models/hand_landmarker.task` }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.3 }),
          mp.ObjectDetector.createFromOptions(fs, { baseOptions: { modelAssetPath: `${MP_BASE}/models/efficientdet_lite0.tflite` }, runningMode: 'VIDEO', scoreThreshold: 0.4, categoryAllowlist: ['cell phone', 'person'] }),
        ]);
      }
      function evalFrame(vid, ts) {
        const pr = poseLm.detectForVideo(vid, ts);
        const hr = handLm.detectForVideo(vid, ts);
        const od = objDet.detectForVideo(vid, ts);
        const dets = od.detections || [];
        const phone = dets.some(d => (d.categories || []).some(c => c.categoryName === 'cell phone' && c.score >= 0.4));
        const people = dets.filter(d => (d.categories || []).some(c => c.categoryName === 'person' && c.score >= 0.5)).length;
        const L = (pr.landmarks && pr.landmarks[0]) || null;
        if (!L) return { ok: false, guidance: 'Apareça na câmera, de frente — mostre o rosto e o tronco.' };
        const vis = i => (L[i].visibility != null ? L[i].visibility : 1);
        const inFrame = i => L[i].x > 0.03 && L[i].x < 0.97 && L[i].y > 0.05 && L[i].y < 0.98;
        const head = vis(0) > 0.6 && vis(2) > 0.5 && vis(5) > 0.5 && inFrame(0) && L[0].y > 0.08;
        if (!head) return { ok: false, guidance: 'Mostre o ROSTO inteiro na câmera — sua cabeça precisa aparecer.' };
        const earMid = (L[7].x + L[8].x) / 2, faceW = Math.abs(L[7].x - L[8].x);
        const facingFront = vis(7) > 0.5 && vis(8) > 0.5 && faceW > 0.001 && Math.abs(L[0].x - earMid) < 0.30 * faceW;
        if (!facingFront) return { ok: false, guidance: 'Fique DE FRENTE para a câmera, olhando para ela (não de lado).' };
        const trunk = vis(11) > 0.5 && vis(12) > 0.5 && inFrame(11) && inFrame(12);
        if (!trunk) return { ok: false, guidance: 'Mostre o TRONCO: os dois ombros precisam aparecer (afaste-se se estiver perto demais).' };
        if (faceW > FACE_MAX) return { ok: false, guidance: 'Afaste-se — você está perto demais; preciso ver do tronco até a cabeça.' };
        if (faceW < FACE_MIN) return { ok: false, guidance: 'Aproxime-se um pouco da câmera.' };
        if ((hr.landmarks || []).length < 2) return { ok: false, guidance: 'Deixe AS DUAS mãos visíveis, como nas fotos de exemplo.' };
        if (phone) return { ok: false, guidance: 'Guarde o celular para começar.' };
        if (people >= 2) return { ok: false, guidance: 'Você precisa estar sozinho — há outra pessoa no quadro.' };
        return { ok: true, guidance: 'Posição e enquadramento ok!' };
      }
      async function startPositionCheck() {
        const vid = $('ps-cam'), g = $('ps-pos-guidance');
        try { camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }); }
        catch { $('ps-err').textContent = 'Não foi possível abrir a câmera. Você ainda pode começar a entrevista.'; return; }
        vid.srcObject = camStream;
        try { await initVision(); } catch (e) { banner(g, 'Checagem de posição indisponível — pode começar mesmo assim.', 'wait'); return; }
        const loop = () => {
          if (!camStream) return;
          if (vid.readyState >= 2) {
            let r; try { r = evalFrame(vid, performance.now()); } catch { r = null; }
            if (r) banner(g, r.guidance, r.ok ? 'ok' : 'wait');
          }
          posRAF = requestAnimationFrame(loop);
        };
        loop();
      }

      // ---------- concluir ----------
      function cleanup() {
        if (noiseRAF) cancelAnimationFrame(noiseRAF);
        if (posRAF) cancelAnimationFrame(posRAF);
        try { noiseCtx && noiseCtx.close(); } catch {}
        try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch {}
        try { camStream && camStream.getTracks().forEach(t => t.stop()); } catch {}
        micStream = camStream = null;
      }
      $('ps-begin').onclick = () => {
        cleanup();
        container.innerHTML = '';
        if (typeof onDone === 'function') onDone();
        resolve();
      };
    });
  };
})();
