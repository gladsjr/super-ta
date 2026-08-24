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

  window.soundCheck = { detectHfp, spectralProbe, hfpVerdict, runEchoTest, mountRedPanel };
})();
