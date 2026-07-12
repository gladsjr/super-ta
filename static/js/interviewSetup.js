// Setup de PROCTORING POR VÍDEO da ENTREVISTA por mensagem.
// EXCLUSIVO da entrevista — não importa nem altera nada da prova oral. Três estágios:
//   1) checagens (fones + conexão + ruído + calibração de fala)
//   2) POSICIONAMENTO — áudio de instruções + câmera ao vivo; problemas aparecem em
//      tempo real (contorno vermelho + texto). Só avança quando a posição fica ok.
//   3) COMANDOS — áudio de instruções + as 4 ÁREAS de comando (canto) + botões que se
//      comportam como os da entrevista (modo prática, nada é gravado). "Iniciar" conclui.
// Ao concluir chama onDone(camStream) — a câmera segue para a entrevista (reuso do stream).
// NUNCA bloqueia (as checagens só orientam). Requer window.createCommandZones (commandZones.js).
//
// Uso: await window.runProctoringSetup({ submissionToken, config, container, onDone });
(function () {
  const MP_BASE = '/static/vision';
  const NOISE_MAX_RMS = 0.035;
  const FACE_MAX = 0.16, FACE_MIN = 0.06;
  const MAX_ATTEMPTS = 2;
  const POS_OK_HOLD_MS = 1500; // posição precisa ficar ok por este tempo p/ avançar
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  window.runProctoringSetup = function ({ submissionToken, config, container, onDone }) {
    return new Promise((resolve) => {
      const calib = config && config.calibration && config.calibration.enabled ? config.calibration : null;
      let camStream = null, micStream = null, noiseCtx = null, noiseRAF = 0, posRAF = 0, cmdPosTimer = 0;
      let poseLm = null, handLm = null, objDet = null, calibRecording = false, zones = null, done = false;

      container.innerHTML = `
        <style>
          .ps-stage { position:relative; width:100%; max-width:460px; margin:0 auto; aspect-ratio:4/3; background:#000; border-radius:12px; overflow:hidden; border:4px solid transparent; transition:border-color .15s, box-shadow .15s; }
          .ps-stage.bad { border-color:#dc2626; box-shadow:0 0 0 3px rgba(220,38,38,.35); }
          .ps-stage video, .ps-stage canvas { position:absolute; inset:0; width:100%; height:100%; }
          .ps-stage video { transform:scaleX(-1); object-fit:cover; }
          .ps-stage canvas { transform:scaleX(-1); }
          .ps-guid { text-align:center; font-weight:600; padding:9px 12px; border-radius:8px; margin-top:10px; }
          .ps-btn { cursor:pointer; font:inherit; padding:10px 16px; border-radius:8px; border:none; background:#2563eb; color:#fff; }
          .ps-btn.ghost { background:#eef2f7; color:#243; border:1px solid #cbd3e1; }
        </style>
        <div id="ps-root" style="max-width:520px;margin:0 auto">
          <audio id="ps-audio" preload="none"></audio>

          <!-- 1) checagens -->
          <div id="ps-checks">
            <p style="background:#eef4ff;border:1px solid #cfe0f5;border-radius:8px;padding:8px 12px;margin:0 0 12px"><strong>🎧 Use fones de ouvido.</strong></p>
            <div id="ps-conn" class="ps-guid" style="background:#fff7e6;color:#8a6d1a">Testando a conexão…</div>
            <div style="margin:14px auto 0">
              <div style="text-align:center;color:#667;font-size:13px;margin-bottom:4px">Nível de ruído do ambiente</div>
              <div style="height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden"><div id="ps-noise-bar" style="height:100%;width:0;background:#2f9e56;transition:width .1s linear"></div></div>
              <div id="ps-noise-verdict" class="ps-guid" style="background:#fff7e6;color:#8a6d1a">Medindo o ambiente…</div>
            </div>
            ${calib ? `
            <div style="margin-top:18px;border-top:1px solid #e5e7eb;padding-top:14px">
              <p style="margin:0 0 4px"><strong>Teste de captação da sua fala.</strong> A sua nota sai da transcrição, então isso ajuda a avaliação a refletir a sua resposta.</p>
              <p style="margin:0 0 8px;color:#667;font-size:13px">Fale em <strong>volume médio</strong>, num <strong>ritmo tranquilo</strong> e <strong>sem cortar o fim das palavras</strong>. Leia em voz alta:</p>
              <div style="text-align:center;font-size:18px;line-height:1.5;margin:0 0 10px;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#fafafa">${esc(calib.sentence)}</div>
              <div style="text-align:center"><button id="ps-calib-rec" type="button" class="ps-btn">🎤 Gravar e ler a frase</button></div>
              <div id="ps-calib-status" class="ps-guid" style="background:#f3f4f6;color:#556">Quando estiver pronto, toque em “Gravar e ler a frase”.</div>
            </div>` : ''}
            <div style="margin-top:18px;text-align:center"><button id="ps-to-position" type="button" class="ps-btn">Continuar</button></div>
          </div>

          <!-- 2) posicionamento -->
          <div id="ps-position" style="display:none">
            <div style="display:flex;align-items:center;gap:10px;margin:0 0 8px"><strong>Posicionamento</strong><button id="ps-audio-pos" type="button" class="ps-btn ghost" style="padding:5px 10px;font-size:13px">🔊 Ouvir instruções</button></div>
            <div class="ps-stage" id="ps-pos-stage"><video id="ps-pos-cam" autoplay muted playsinline></video></div>
            <div id="ps-pos-guid" class="ps-guid" style="background:#fff7e6;color:#8a6d1a">Iniciando a câmera…</div>
            <div id="ps-pos-err" style="color:#c0453b;text-align:center;margin-top:8px"></div>
          </div>

          <!-- 3) comandos -->
          <div id="ps-commands" style="display:none">
            <div style="display:flex;align-items:center;gap:10px;margin:0 0 8px"><strong>Comandos (prática)</strong><button id="ps-audio-cmd" type="button" class="ps-btn ghost" style="padding:5px 10px;font-size:13px">🔊 Ouvir instruções</button></div>
            <div class="ps-stage" id="ps-cmd-stage"><video id="ps-cmd-cam" autoplay muted playsinline></video><canvas id="ps-cmd-canvas"></canvas></div>
            <div id="ps-cmd-guid" class="ps-guid" style="background:#eef4ff;color:#274; font-size:15px; line-height:1.4">Leve a mão a uma das áreas dos cantos e segure enquanto conta até 3. Ficam disponíveis só as áreas que fazem sentido a cada momento. Nada está sendo gravado agora.</div>
            <!-- botões IDÊNTICOS aos da entrevista (mesmas classes .record-btn) — modo prática -->
            <div class="input-area-audio" style="margin-top:10px">
              <div class="record-actions">
                <button id="pr-record" class="record-btn" type="button">🎙️ Gravar resposta</button>
                <button id="pr-cancel" class="record-btn secondary hidden" type="button">Cancelar</button>
                <button id="pr-send" class="record-btn recording hidden" type="button">Enviar</button>
              </div>
              <div id="pr-status" class="record-status">Pratique os comandos. Comande <strong>Iniciar</strong> (canto inferior esquerdo) quando quiser começar a entrevista.</div>
            </div>
          </div>
        </div>`;

      const $ = id => container.querySelector('#' + id);
      const banner = (el, text, kind) => {
        el.textContent = text;
        const c = kind === 'ok' ? ['#eaf7ef', '#1e6b3b'] : kind === 'bad' ? ['#fdecec', '#8a2020'] : ['#fff7e6', '#8a6d1a'];
        el.style.background = c[0]; el.style.color = c[1];
      };
      const playAudio = (which) => { const a = $('ps-audio'); a.src = `/s/${submissionToken}/setup-audio?which=${which}&_=${which}`; a.play().catch(() => {}); };

      // ---------- 1) Conexão + ruído + calibração ----------
      (async () => {
        const times = [];
        for (let i = 0; i < 3; i++) { const t0 = performance.now(); try { await fetch(`/s/${submissionToken}/setup-config`, { cache: 'no-store' }); times.push(performance.now() - t0); } catch {} }
        if (times.length) { times.sort((a, b) => a - b); banner($('ps-conn'), `Conexão ok ✓ (~${Math.round(times[Math.floor(times.length / 2)])} ms)`, 'ok'); }
        else banner($('ps-conn'), 'Conexão instável — verifique sua internet.', 'bad');
      })();
      (async () => {
        try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
        catch { banner($('ps-noise-verdict'), 'Não foi possível medir o ruído (microfone).', 'bad'); return; }
        noiseCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = noiseCtx.createMediaStreamSource(micStream);
        const an = noiseCtx.createAnalyser(); an.fftSize = 2048; src.connect(an);
        const buf = new Float32Array(an.fftSize); let ema = null;
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
          } else { calibRecording = false; recBtn.disabled = true; try { calibRec.stop(); } catch {} }
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

      // ---------- passagem checagens → posicionamento ----------
      $('ps-to-position').onclick = async () => {
        if (noiseRAF) { cancelAnimationFrame(noiseRAF); noiseRAF = 0; }
        try { noiseCtx && noiseCtx.close(); } catch {}
        try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch {} micStream = null;
        $('ps-checks').style.display = 'none';
        $('ps-position').style.display = '';
        await startPosition();
      };
      $('ps-audio-pos').onclick = () => playAudio('position');
      $('ps-audio-cmd').onclick = () => playAudio('commands');

      // ---------- MediaPipe (pose + hands + objetos) ----------
      async function initVision() {
        const mp = await import(`${MP_BASE}/vision_bundle.mjs`);
        const fs = await mp.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
        [poseLm, handLm, objDet] = await Promise.all([
          mp.PoseLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: `${MP_BASE}/models/pose_landmarker_lite.task` }, runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.5 }),
          mp.HandLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: `${MP_BASE}/models/hand_landmarker.task` }, runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.3 }),
          mp.ObjectDetector.createFromOptions(fs, { baseOptions: { modelAssetPath: `${MP_BASE}/models/efficientdet_lite0.tflite` }, runningMode: 'VIDEO', scoreThreshold: 0.4, categoryAllowlist: ['cell phone', 'person'] }),
        ]);
      }
      // checagem de posição; checkHands=true no estágio de posição (exige 2 mãos), false nos comandos.
      function evalPosition(vid, ts, checkHands) {
        const pr = poseLm.detectForVideo(vid, ts);
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
        if (checkHands) { const hr = handLm.detectForVideo(vid, ts); if ((hr.landmarks || []).length < 2) return { ok: false, guidance: 'Deixe AS DUAS mãos visíveis, como nas fotos de exemplo.' }; }
        if (phone) return { ok: false, guidance: 'Guarde o celular para começar.' };
        if (people >= 2) return { ok: false, guidance: 'Você precisa estar sozinho — há outra pessoa no quadro.' };
        return { ok: true, guidance: 'Posição e enquadramento ok!' };
      }

      // ---------- 2) Posicionamento ----------
      async function startPosition() {
        const vid = $('ps-pos-cam'), stage = $('ps-pos-stage'), g = $('ps-pos-guid');
        try { camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }); }
        catch { $('ps-pos-err').textContent = 'Não foi possível abrir a câmera. Você ainda pode começar a entrevista.'; setTimeout(goCommands, 1200); return; }
        vid.srcObject = camStream;
        playAudio('position');
        try { await initVision(); } catch (e) { banner(g, 'Checagem de posição indisponível — seguindo.', 'wait'); setTimeout(goCommands, 800); return; }
        let okSince = 0, advanced = false, last = performance.now();
        const loop = () => {
          if (advanced || !camStream) return;
          const now = performance.now(), dt = now - last; last = now;
          if (vid.readyState >= 2) {
            let r; try { r = evalPosition(vid, now, true); } catch { r = null; }
            if (r) {
              banner(g, r.guidance, r.ok ? 'ok' : 'wait');
              stage.classList.toggle('bad', !r.ok);
              okSince = r.ok ? okSince + dt : 0;
              if (okSince >= POS_OK_HOLD_MS) { advanced = true; goCommands(); return; }
            }
          }
          posRAF = requestAnimationFrame(loop);
        };
        loop();
      }

      // ---------- 3) Comandos (prática) ----------
      function goCommands() {
        if (posRAF) { cancelAnimationFrame(posRAF); posRAF = 0; }
        $('ps-position').style.display = 'none';
        $('ps-commands').style.display = '';
        const vid = $('ps-cmd-cam'), canvas = $('ps-cmd-canvas'), stage = $('ps-cmd-stage');
        if (camStream) vid.srcObject = camStream;
        playAudio('commands');

        // botões-prática espelhando a entrevista (sem gravar de verdade)
        let practice = 'idle';
        const recBtn = $('pr-record'), cancelBtn = $('pr-cancel'), sendBtn = $('pr-send'), st = $('pr-status');
        const setPractice = (s) => {
          practice = s;
          recBtn.classList.toggle('hidden', s !== 'idle');
          cancelBtn.classList.toggle('hidden', s !== 'recording');
          sendBtn.classList.toggle('hidden', s !== 'recording');
        };
        const doRecord = () => { if (practice === 'idle') { setPractice('recording'); st.textContent = '🔴 Gravando (teste)… comande Enviar para mandar, ou Cancelar para descartar.'; } };
        const doSend = () => { if (practice === 'recording') { setPractice('idle'); st.textContent = 'Resposta enviada (teste) ✓ — na prova, aqui a IA responderia. Comande Iniciar para começar.'; } };
        const doCancel = () => { if (practice === 'recording') { setPractice('idle'); st.textContent = 'Gravação descartada (teste). Pode gravar de novo.'; } };
        recBtn.onclick = doRecord; sendBtn.onclick = doSend; cancelBtn.onclick = doCancel;
        setPractice('idle');

        const onFire = (id) => {
          if (id === 'record') doRecord();
          else if (id === 'send') doSend();
          else if (id === 'cancel') doCancel();
          else if (id === 'start') finish();
        };
        if (window.createCommandZones) {
          zones = window.createCommandZones({
            videoEl: vid, canvasEl: canvas, dwellMs: 2000, size: 0.18,
            zones: [
              { id: 'record', corner: 'tl', label: 'GRAVAR',   color: '#16a34a' }, // vê: sup./dir.
              { id: 'cancel', corner: 'tr', label: 'CANCELAR', color: '#dc2626' }, // vê: sup./esq.
              { id: 'send',   corner: 'bl', label: 'ENVIAR',   color: '#2563eb' }, // vê: inf./dir.
              { id: 'start',  corner: 'br', label: 'INICIAR',  color: '#d97706' }, // vê: inf./esq.
            ],
            // habilita só o que faz sentido: parado → Gravar; gravando → Enviar/Cancelar; Iniciar sempre.
            enabledFn: (id) => id === 'start' ? true : id === 'record' ? practice === 'idle' : practice === 'recording',
            onFire,
          });
        }
        // monitor de posição leve (mantém o aviso vermelho), throttled — sem mãos p/ não
        // rodar 2 detectores de mão ao mesmo tempo que as áreas de comando.
        if (poseLm && objDet) {
          cmdPosTimer = setInterval(() => {
            if (vid.readyState < 2) return;
            let r; try { r = evalPosition(vid, performance.now(), false); } catch { r = null; }
            if (r) stage.classList.toggle('bad', !r.ok);
          }, 300);
        }
      }

      function finish() {
        if (done) return; done = true;
        if (posRAF) cancelAnimationFrame(posRAF);
        if (noiseRAF) cancelAnimationFrame(noiseRAF);
        if (cmdPosTimer) clearInterval(cmdPosTimer);
        try { zones && zones.stop(); } catch {}
        try { noiseCtx && noiseCtx.close(); } catch {}
        try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch {}
        container.innerHTML = '';
        const stream = camStream; camStream = null; // ENTREGA a câmera para a entrevista
        if (typeof onDone === 'function') onDone(stream);
        resolve(stream);
      }
    });
  };
})();
