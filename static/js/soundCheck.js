// Sound check v2 (#288) — lado do NAVEGADOR, compartilhado pela prova oral e
// pela entrevista em tempo real (as duas telas têm o mesmo bloco de calibração;
// um arquivo só evita a divergência, como no setupGate).
//
// Três peças:
//   1. detectHfp / spectralProbe — earbud Bluetooth em modo chamada (perfil
//      HFP): rótulo do dispositivo + confirmação espectral (HFP tem um
//      penhasco inconfundível acima de ~6–8 kHz). SEMPRE aviso, nunca bloqueio.
//   2. runEchoTest — toca a frase do examinador (servidor) com o aluno em
//      silêncio, grava o microfone e manda ao servidor conferir vazamento.
//   3. redPanel — a tela do estado VERMELHO, que NUNCA é beco: checklist de
//      custo zero → testar de novo → reagendar/professor libera (ADR 0023).
(function () {
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // --- HFP: rótulo do dispositivo + taxa de amostragem da track -------------
  // Rótulos típicos: "AirPods (Hands-Free AG Audio)", "Headset (… HFP)".
  const HFP_LABEL_RE = /hands.?free|\bHFP\b|\bAG\b.?audio|headset\s*\(/i;
  function detectHfp(micStream) {
    try {
      const track = micStream && micStream.getAudioTracks && micStream.getAudioTracks()[0];
      if (!track) return null;
      const st = (track.getSettings && track.getSettings()) || {};
      const label = track.label || "";
      const sr = Number(st.sampleRate) || null;
      // HFP clássico é 8 kHz; mSBC/wideband é 16 kHz. Captação normal ≥ 44,1 kHz.
      const narrowband = sr != null && sr <= 16000;
      return { label, sample_rate: sr, label_suspect: HFP_LABEL_RE.test(label), narrowband };
    } catch { return null; }
  }

  // --- Sonda espectral: roda DURANTE a gravação da leitura ------------------
  // Mede a energia média acima de ~7 kHz vs a banda da voz (300 Hz–4 kHz).
  // Fala normal em captação plena tem sibilância acima de 7 kHz; HFP corta ali.
  function spectralProbe(micStream) {
    let ctx = null, src = null, an = null, timer = null;
    let hi = 0, lo = 0, frames = 0;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      src = ctx.createMediaStreamSource(micStream);
      an = ctx.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      const bins = new Float32Array(an.frequencyBinCount);
      const hz = ctx.sampleRate / an.fftSize; // largura de cada bin
      timer = setInterval(() => {
        an.getFloatFrequencyData(bins);
        let hiSum = 0, hiN = 0, loSum = 0, loN = 0;
        for (let i = 0; i < bins.length; i++) {
          const f = i * hz, p = Math.pow(10, bins[i] / 10); // dB → potência
          if (f >= 300 && f <= 4000) { loSum += p; loN++; }
          else if (f >= 7000 && f <= 11000) { hiSum += p; hiN++; }
        }
        if (loN && hiN) { lo += loSum / loN; hi += hiSum / hiN; frames++; }
      }, 120);
    } catch { /* sem Web Audio: sonda não roda, só o rótulo decide */ }
    return {
      stop() {
        try { clearInterval(timer); src && src.disconnect(); ctx && ctx.close(); } catch {}
        if (!frames || !lo) return null;
        return { hi_ratio: hi / lo, frames };
      },
    };
  }

  // Junta rótulo + espectro num veredito. `spectral` pode ser null (sonda não
  // rodou). Suspeito quando o rótulo denuncia OU quando há voz clara (lo alto o
  // suficiente para a razão ser significativa) com o penhasco espectral.
  const HI_RATIO_CLIFF = 0.002; // razão hi/lo abaixo disso = sem nada acima de 7 kHz
  function hfpVerdict(basic, spectral) {
    if (!basic) return null;
    const cliff = !!(spectral && spectral.hi_ratio != null && spectral.hi_ratio < HI_RATIO_CLIFF);
    const suspect = basic.label_suspect || basic.narrowband || cliff;
    return {
      suspect,
      label: basic.label,
      sample_rate: basic.sample_rate,
      hi_ratio: spectral ? Math.round(spectral.hi_ratio * 1e6) / 1e6 : null,
    };
  }

  // --- Teste de eco ---------------------------------------------------------
  // Toca `${base}/echo-audio` e grava o microfone do começo ao fim (+ cauda),
  // depois envia a `${base}/echo-check`. Resolve com o JSON do servidor, ou
  // rejeita em falha de rede/permissão (o chamador decide o texto).
  function runEchoTest({ base, micStream, onStatus }) {
    return new Promise((resolve, reject) => {
      let rec = null, chunks = [];
      let stream;
      try { stream = new MediaStream(micStream.getAudioTracks()); } catch { stream = micStream; }
      try { rec = new MediaRecorder(stream); } catch (e) { return reject(e); }
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        try {
          if (onStatus) onStatus("checking");
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          const form = new FormData();
          form.append("file", blob, "echo.webm");
          const r = await fetch(`${base}/echo-check`, { method: "POST", body: form });
          resolve(await r.json());
        } catch (e) { reject(e); }
      };
      const audio = new Audio(`${base}/echo-audio`);
      audio.onerror = () => { try { rec.stop(); } catch {} reject(new Error("echo-audio falhou")); };
      audio.onended = () => setTimeout(() => { try { rec.stop(); } catch {} }, 700); // cauda p/ o eco tardio
      rec.start();
      if (onStatus) onStatus("playing");
      audio.play().catch((e) => { try { rec.stop(); } catch {} reject(e); });
    });
  }

  // --- Tela do VERMELHO (nunca é beco) --------------------------------------
  // Renderiza dentro de `container` o checklist + saídas. `onRetry` reabre as
  // sondas (nova leitura + novo eco); a liberação é do professor, aqui só se
  // explica o caminho.
  function redPanelHtml(state) {
    const motivos = (state && state.reasons || []).map((r) => `<li>${esc(r)}</li>`).join("");
    return (
      `<div style="border:2px solid #dc2626;border-radius:10px;padding:14px;background:#fef2f2">` +
      `<p style="margin:0 0 8px"><strong>⛔ A captação do seu áudio reprovou no teste.</strong> Com ela assim, a transcrição das suas respostas sairia errada — e a sua avaliação seria prejudicada. Por isso a prova não começa ainda.</p>` +
      (motivos ? `<ul style="margin:0 0 10px;padding-left:20px">${motivos}</ul>` : "") +
      `<p style="margin:0 0 6px"><strong>Antes de qualquer coisa, tente isto (resolve a maioria dos casos):</strong></p>` +
      `<ol style="margin:0 0 10px;padding-left:20px">` +
      `<li><strong>Use fone com fio</strong> (o P2/USB simples é o melhor equipamento para a prova). Fone Bluetooth de ouvido, quando o microfone dele assume, degrada muito o áudio.</li>` +
      `<li>Feche outras abas e aplicativos que usam o microfone (Meet, WhatsApp, Discord).</li>` +
      `<li>Se houver outro microfone/fone disponível, troque o dispositivo e recarregue a página.</li>` +
      `</ol>` +
      `<p style="margin:0 0 10px">Depois de ajustar, toque em <strong>“Já ajustei — testar de novo”</strong>. Se não conseguir resolver agora, <strong>não há penalidade</strong>: combine outro horário com o professor, ou peça a ele a liberação para fazer a prova assim mesmo (ele consegue liberar pelo painel).</p>` +
      `<div style="text-align:center"><button class="btn" id="sc-retry-btn">Já ajustei — testar de novo</button></div>` +
      `</div>`
    );
  }

  function mountRedPanel(container, state, onRetry) {
    container.innerHTML = redPanelHtml(state);
    const b = container.querySelector("#sc-retry-btn");
    if (b && onRetry) b.onclick = onRetry;
  }

  // --- WIZARD guiado por VOZ (#321) ---------------------------------------
  // Máquina de estados do sound check: o orientador (áudios pré-gravados em
  // /static/audio/soundcheck/) conduz as etapas, e CADA fala dele é sonda de
  // eco — o microfone grava durante a reprodução e o servidor confere se o
  // roteiro voltou. Tudo que a voz diz aparece em texto (espelho visual).
  function mountWizard(opts) {
    const { base, micStream, sentence, els, getEnv, setCalibRecording, hfp, onUpdate } = opts;
    let ecoLoops = 0, attempt = 0, hfpSent = false, lastCap = null, stopped = false;
    // #328: falha de infra ganha UMA retentativa antes do fail-open; sonda crua
    // morta (iOS mata uma das capturas com dois getUserMedia no mesmo mic) cai
    // p/ o stream da sessão na retentativa; leitura já aprovada não se repete.
    let ecoInfraFails = 0, readInfraFails = 0, probeDead = false, leituraJaFeita = false;

    // Sonda de eco em stream CRU (achado do teste manual de 26/08): o AEC do
    // navegador, ligado por padrão, CANCELA o áudio tocado pela própria página
    // na trilha do microfone — a captura chegava VAZIA ao STT justamente sem
    // fones. O gate mede o ARRANJO FÍSICO (voz voltando pelo ar), então a
    // amostra de eco usa echoCancellation/noiseSuppression/autoGain OFF; a
    // LEITURA continua no stream normal (mede o que a prova vai ouvir).
    let rawMic = null;
    async function getRawMic() {
      if (probeDead) return micStream; // sonda crua veio muda (#328): última chance no stream da sessão
      if (rawMic) return rawMic;
      try {
        // MESMO dispositivo do stream da sessão (#323 round 2): sem deviceId, o
        // getUserMedia cru pode abrir OUTRO microfone (o padrão do sistema) e
        // captar silêncio. Pina no device que o aluno autorizou.
        const devId = micStream?.getAudioTracks?.()[0]?.getSettings?.().deviceId;
        rawMic = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(devId ? { deviceId: { exact: devId } } : {}),
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          },
        });
      } catch { rawMic = micStream; }
      return rawMic;
    }
    // RMS da amostra gravada (diagnóstico #323): distingue "captura muda"
    // (constraint/driver apagou o som) de "áudio presente mas STT vazio".
    async function blobRms(blob) {
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const buf = await ac.decodeAudioData(await blob.arrayBuffer());
        const d = buf.getChannelData(0);
        let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
        try { ac.close(); } catch {}
        return Math.round(Math.sqrt(sum / d.length) * 1e5) / 1e5;
      } catch { return null; }
    }
    function dropRawMic() {
      if (rawMic && rawMic !== micStream) { try { rawMic.getTracks().forEach(tr => tr.stop()); } catch {} }
      rawMic = null;
    }

    const stage = els.stage;
    function ui(html) { stage.innerHTML = html; }
    const esc2 = esc;
    function speechRow(text) {
      return `<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:10px">` +
        `<div style="font-size:22px">🎧</div>` +
        `<div style="flex:1;background:var(--bg-muted,#f4f1ea);border-radius:10px;padding:10px 12px;line-height:1.5"><span style="font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#5a6b80;display:block;margin-bottom:4px">Orientação (voz)</span>${esc2(text)}</div></div>`;
    }

    // Toca um roteiro (com espelho visual) e, se `capture`, grava o microfone
    // durante a fala + cauda — a captura vira a amostra de eco daquele trecho.
    async function speak(key, { capture = false, extraHtml = "" } = {}) {
      // UI PRIMEIRO e síncrona (os controles do estágio nascem com o chamador
      // ainda no mesmo tick — quem chama sem await já os encontra no DOM).
      ui(speechRow(SC_TEXTS[key]) + extraHtml);
      const capStream = capture ? await getRawMic() : null; // cru: o AEC não apaga o eco
      return new Promise((resolve) => {
        let rec = null, chunks = [];
        if (capture && capStream) {
          try {
            rec = new MediaRecorder(new MediaStream(capStream.getAudioTracks()));
            rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
            rec.start();
          } catch { rec = null; }
        }
        const audio = new Audio(`/static/audio/soundcheck/${key}.mp3`);
        const finish = () => setTimeout(() => {
          if (rec && rec.state === "recording") {
            rec.onstop = () => { lastCap = { blob: new Blob(chunks, { type: rec.mimeType || "audio/webm" }), script: key }; resolve(); };
            rec.stop();
          } else resolve();
        }, 600);
        audio.onended = finish;
        audio.onerror = finish; // sem áudio (arquivo/saída quebrados): o espelho visual segue valendo
        audio.play().catch(finish);
      });
    }

    const sleepW = (ms) => new Promise(r => setTimeout(r, ms));
    function push(resp) { if (onUpdate) onUpdate(resp); }
    function isRed(resp) { return resp && resp.sound_check && resp.sound_check.state === "vermelho" && !resp.sound_check.waived; }

    async function postEcho(rms) {
      const form = new FormData();
      form.append("file", lastCap.blob, "echo.webm");
      form.append("script", lastCap.script);
      if (rms != null) form.append("rms", String(rms));
      const r = await fetch(`${base}/echo-check`, { method: "POST", body: form });
      if (!r.ok) return { error: `http ${r.status}` }; // 502 do STT etc. → ramo de infra
      return await r.json();
    }

    // ---- Estágios ----
    async function s0Silencio() {
      if (els.conn) els.conn.style.display = "";
      if (els.noise) els.noise.style.display = "";
      await speak("g1_intro", { capture: true });
      await sleepW(3500); // janela de medição em silêncio, pós-fala
      return s1Veredito();
    }
    async function s1Veredito() {
      const env = getEnv ? getEnv() : {};
      const problems = [];
      if (env.connWarn) problems.push("g2_conn");
      if (env.noiseDone && !env.noiseOk) problems.push("g2_ruido");
      if (!problems.length) {
        await speak("g2_ok", { capture: true });
      } else {
        for (const p of problems) {
          await speak(p, { capture: true, extraHtml: `<div style="text-align:center"><button class="btn" id="sc-aware-btn">Estou ciente</button></div>` });
          await new Promise((res) => { const b = stage.querySelector("#sc-aware-btn"); if (b) b.onclick = res; else res(); });
        }
      }
      // O feedback de conexão/ruído cumpriu o papel: some (nada de pilha rolando).
      if (els.conn) els.conn.style.display = "none";
      if (els.noise) els.noise.style.display = "none";
      return s2Fones();
    }
    async function s2Fones() {
      if (stopped) return;
      if (els.fones) els.fones.style.display = "";
      const key = ecoLoops === 0 ? "g3_fones" : "g5_eco_loop";
      const btnHtml = `<div style="text-align:center"><button class="btn" id="sc-test-btn" disabled>🎧 Testar captação</button></div>` +
        `<div class="banner wait" id="sc-echo-status" style="margin-top:10px;display:none"></div>`;
      // A UI nasce ANTES de a fala terminar (ui() é síncrono dentro de speak):
      // o checkbox/botão já respondem durante o áudio; o clique só processa
      // após o fim da fala (aguarda `spoken`), garantindo a captura do eco.
      const spoken = speak(key, { capture: true, extraHtml: btnHtml });
      const btn = stage.querySelector("#sc-test-btn");
      const st = stage.querySelector("#sc-echo-status");
      const sync = () => { if (btn) btn.disabled = !(els.hpCheck && els.hpCheck.checked); };
      if (els.hpCheck) els.hpCheck.addEventListener("change", sync);
      sync();
      await new Promise((res) => { if (btn) btn.onclick = res; });
      await spoken; // fala + captura completas antes de conferir o eco
      if (els.hpCheck) els.hpCheck.removeEventListener("change", sync);
      if (btn) btn.disabled = true;
      if (st) { st.style.display = ""; st.textContent = "Verificando o eco…"; }
      // Amostra sem energia = a sonda NÃO mediu nada (#328, caso iOS rms=0) —
      // não é "sem eco"; trata como falha e retenta (a retentativa usa o
      // stream da sessão via probeDead).
      const rms = lastCap ? await blobRms(lastCap.blob) : null;
      const dead = rms != null && rms < 0.0001;
      let j = null;
      if (!dead) { try { j = lastCap ? await postEcho(rms) : null; } catch {} }
      if (dead || !j || j.error) {
        ecoInfraFails++;
        if (dead) { dropRawMic(); probeDead = true; }
        if (ecoInfraFails < 2) {
          ui(`<div class="banner adjust">Não consegui medir o eco agora${dead ? " (a captação veio muda)" : " (falha do serviço)"}. Vamos tentar mais uma vez.</div><div style="text-align:center;margin-top:8px"><button class="btn" id="sc-retry-eco">Tentar de novo</button></div>`);
          await new Promise((res) => { const b = stage.querySelector("#sc-retry-eco"); if (b) b.onclick = res; else res(); });
          return s2Fones();
        }
        // 2ª falha seguida: infra não bloqueia (ADR 0023) — segue com aviso explícito
        push({ sound_check_pending: false });
        ui(`<div class="banner adjust">O teste de eco não pôde ser concluído (falha do serviço). Você pode seguir.</div>`);
        await sleepW(1800);
        return leituraJaFeita ? s4Fim({ infra: true }) : s3Leitura();
      }
      ecoInfraFails = 0;
      push(j);
      if (j.leak) {
        ecoLoops++;
        if (els.hpCheck) els.hpCheck.checked = false; // desfaz a confirmação: havia eco
        if (isRed(j)) return; // 2 ecos = vermelho — painel/liberação assumem (nunca é beco)
        await speak("g4_eco", { capture: true });
        return s2Fones();
      }
      return leituraJaFeita ? s4Fim({}) : s3Leitura();
    }
    async function s3Leitura(infraRetry = false) {
      if (stopped) return;
      const frame = `
        <div class="card" style="text-align:center;font-size:18px;line-height:1.5;margin:0 0 10px">${esc2(sentence)}</div>
        <div style="text-align:center"><button class="btn" id="sc-rec-btn">🎤 Gravar e ler a frase</button></div>
        <div class="banner wait" id="sc-read-status" style="margin-top:10px">Quando estiver pronto, toque em “Gravar e ler a frase”.</div>`;
      // UI e handler nascem JÁ (ui é síncrono dentro de speak); a gravação em si
      // espera a instrução terminar — clicar cedo não grava a voz-guia junto.
      // Retentativa por INFRA não repete o g7 ("captação ruim"): a falha foi do
      // serviço, não do aluno (#328).
      const spoken = (attempt === 0)
        ? speak("g6_leitura", { capture: true, extraHtml: frame })
        : (ui((infraRetry ? "" : speechRow(SC_TEXTS.g7_leitura_ruim)) + frame), Promise.resolve());
      const btn = stage.querySelector("#sc-rec-btn");
      const st = stage.querySelector("#sc-read-status");
      let rec = null, chunks = [];
      const j = await new Promise((res) => {
        btn.onclick = async () => {
          if (rec && rec.state === "recording") { rec.stop(); return; }
          await spoken; // instrução concluída (e captura de eco fechada)
          chunks = [];
          try { rec = new MediaRecorder(new MediaStream(micStream.getAudioTracks())); } catch { return res(null); }
          rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
          rec.onstop = async () => {
            if (setCalibRecording) setCalibRecording(false);
            btn.disabled = true; st.className = "banner wait"; st.textContent = "Verificando a captação…";
            attempt++;
            try {
              const form = new FormData();
              form.append("file", new Blob(chunks, { type: rec.mimeType || "audio/webm" }), "calib.webm");
              form.append("attempt", String(attempt));
              const h = hfp && !hfpSent ? hfp() : null;
              if (h) { form.append("hfp", JSON.stringify(h)); hfpSent = true; }
              res(await (await fetch(`${base}/calibrate`, { method: "POST", body: form })).json());
            } catch { res(null); }
          };
          rec.start();
          if (setCalibRecording) setCalibRecording(true);
          btn.textContent = "⏹ Parar e verificar";
          st.className = "banner wait"; st.textContent = "🎤 Gravando… leia a frase e toque em “Parar e verificar”.";
        };
      });
      if (!j || j.error) {
        // 1ª falha de infra: retenta; só a 2ª seguida libera (fail-open, #328)
        readInfraFails++;
        if (readInfraFails < 2) {
          ui(`<div class="banner adjust">Não consegui verificar a captação agora (falha do serviço). Toque em Tentar de novo e grave outra vez.</div><div style="text-align:center;margin-top:8px"><button class="btn" id="sc-retry-read">Tentar de novo</button></div>`);
          await new Promise((res) => { const b = stage.querySelector("#sc-retry-read"); if (b) b.onclick = res; else res(); });
          return s3Leitura(true);
        }
        push({ sound_check_pending: false });
        return s4Fim({ infra: true });
      }
      readInfraFails = 0;
      push(j);
      if (j.ok) return s4Fim({});
      if ((Number(j.attempts_left) || 0) > 0) {
        await speak("g7_leitura_ruim", { capture: true, extraHtml: `<div class="banner adjust">${esc2(j.advice || "A captação não ficou boa.")}</div>` });
        return s3Leitura();
      }
      // tentativas esgotadas: a escada decide (vermelho → painel; senão segue com aviso)
      if (isRed(j)) return;
      return s4Fim({ ressalva: true });
    }
    async function s4Fim({ ressalva = false, infra = false } = {}) {
      dropRawMic(); // a sonda crua cumpriu o papel; libera o dispositivo
      const extra = ressalva
        ? `<div class="banner adjust">A leitura não foi aprovada, mas você pode seguir. Ao final, confira a transcrição e avise o professor se algo sair errado.</div>`
        : (infra ? `<div class="banner adjust">Não consegui concluir a verificação agora (falha do serviço). Você pode seguir.</div>` : "");
      await speak("g8_fim", { extraHtml: extra + `<div class="banner ok" style="margin-top:8px">Verificação concluída ✓ Use o botão Continuar abaixo.</div>` });
    }

    // Entrada: retoma do estágio certo (reload) ou pula tudo se já concluído.
    async function start({ progress = {}, state = null, pending = true } = {}) {
      if (state && state.state === "vermelho" && !state.waived) return; // painel vermelho da página assume
      if (pending === false) { ui(`<div class="banner ok">Teste de captação já concluído ✓</div>`); if (els.fones) els.fones.style.display = ""; return; }
      leituraJaFeita = progress.leitura_done === true;
      // Reentrada (#328): o eco "resolvido" veio de OUTRO momento físico — o
      // aluno pode ter voltado sem os fones. Refaz confirmação (checkbox) +
      // sonda; a leitura aprovada segue valendo (não se repete).
      if (progress.echo_done) { if (els.conn) els.conn.style.display = "none"; if (els.noise) els.noise.style.display = "none"; return s2Fones(); }
      return s0Silencio();
    }
    // Recuperação pós-vermelho ("Já ajustei"): reabre do estágio do eco.
    function restart() {
      stopped = false; ecoLoops = 0;
      leituraJaFeita = false; // recuperação: a leitura NOVA é o que limpa o vermelho
      if (els.conn) els.conn.style.display = "none";
      if (els.noise) els.noise.style.display = "none";
      return s2Fones();
    }
    return { start, restart };
  }

  // Espelho dos textos falados (mantido em sincronia com lib/soundCheck.js —
  // regerado junto com os mp3 por scripts/gen-soundcheck-audio.mjs).
  const SC_TEXTS = window.SC_SCRIPTS_MIRROR || {
    g1_intro: "Olá! Eu sou a orientação automática da ORATIA. Antes de começar, vou fazer alguns testes rápidos para garantir que a sua fala será entendida sem erros. Primeiro: fique em silêncio por alguns segundos, enquanto eu meço o ambiente e a conexão.",
    g2_ok: "Conexão e nível de ruído: tudo certo.",
    g2_conn: "A sua conexão está instável ou lenta. Você pode continuar, mas pode haver cortes — se puder, aproxime-se do roteador ou troque de rede. Clique em Estou ciente para seguir.",
    g2_ruido: "O ambiente está barulhento. Você pode continuar, mas o ruído atrapalha a transcrição da sua fala — se puder, procure um lugar mais silencioso. Clique em Estou ciente para seguir.",
    g3_fones: "Para a prova, é obrigatório usar fones de ouvido. Sem eles, a minha voz volta pelo seu microfone e vira eco. Coloque os fones agora, marque a caixa confirmando, e clique em Testar captação.",
    g4_eco: "Detectei eco: a minha voz está voltando pelo seu microfone. Isso normalmente acontece sem fones de ouvido, ou com o volume muito alto. Este ponto é bloqueante: ajuste o equipamento, e vamos tentar de novo.",
    g5_eco_loop: "Para garantir a qualidade da avaliação, preciso de som sem eco. Use fones de ouvido e baixe o volume. Se eu detectar eco de novo, voltaremos a este mesmo estágio.",
    g6_leitura: "Agora, leia em voz alta a frase que está na tela, com a mesma entonação que você vai usar na prova. O objetivo é garantir uma boa transcrição dos termos específicos do tema. Clique em Gravar, leia a frase, e clique em Parar e verificar.",
    g7_leitura_ruim: "A captação da sua leitura não ficou boa. Fale um pouco mais perto do microfone, num ritmo tranquilo, e tente novamente.",
    g8_fim: "Tudo certo por aqui. Pode continuar para a próxima etapa.",
  };

  window.soundCheck = { detectHfp, spectralProbe, hfpVerdict, runEchoTest, mountRedPanel, mountWizard };
})();
