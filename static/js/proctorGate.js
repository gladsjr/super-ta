// Gate de PROCTORING DE VÍDEO — compartilhado pelos três fluxos (entrevista por
// mensagem, prova oral e entrevista simplificada). O proctoring é OBRIGATÓRIO e
// BLOQUEANTE: sem captura de vídeo confirmada a arguição não começa, e se a
// captura cai no meio a arguição trava até religar.
//
// Expõe window.proctorGate = { pickVideoMime, probeCapture, blockingCameraError,
//   attachTrackLossGuard }.
(function () {
  // Ordem de preferência de container/codec. Deixa o browser escolher ('') como
  // último recurso — no Safari, p.ex., o default costuma ser mp4/H.264.
  const VIDEO_MIMES = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];

  function pickVideoMime() {
    if (!window.MediaRecorder) return null; // sem MediaRecorder → sem gravação
    for (const m of VIDEO_MIMES) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
    }
    return ""; // suportado, mas nenhum candidato conhecido → deixa o browser decidir
  }

  // Confirma que o stream REALMENTE grava vídeo: cria um MediaRecorder de teste e
  // espera um chunk não-vazio. É o coração do gate — pega navegadores sem
  // MediaRecorder/sem codec (ex.: alguns iOS) e câmeras que abrem mas não geram
  // dados. Resolve { ok:true, mime } ou { ok:false, reason }.
  function probeCapture(stream, timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (!window.MediaRecorder) return resolve({ ok: false, reason: "no-recorder" });
      if (!stream || stream.getVideoTracks().length === 0) return resolve({ ok: false, reason: "no-video-track" });
      const mime = pickVideoMime();
      if (mime === null) return resolve({ ok: false, reason: "no-recorder" });
      let rec;
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch { return resolve({ ok: false, reason: "recorder-init" }); }
      let done = false;
      const finish = (r) => { if (done) return; done = true; try { if (rec.state !== "inactive") rec.stop(); } catch {} resolve(r); };
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) finish({ ok: true, mime: rec.mimeType || mime }); };
      rec.onerror = () => finish({ ok: false, reason: "recorder-error" });
      try { rec.start(250); } catch { return finish({ ok: false, reason: "recorder-start" }); }
      setTimeout(() => finish({ ok: false, reason: "no-data" }), timeoutMs);
    });
  }

  // Mensagem amigável por motivo do bloqueio.
  function reasonText(reason) {
    switch (reason) {
      case "permission":
      case "no-video-track":
        return "Não conseguimos acessar a sua câmera. Autorize o uso da câmera para este site e tente de novo. Se o botão de permissão não aparecer, verifique o cadeado ao lado do endereço.";
      case "no-recorder":
      case "recorder-init":
      case "recorder-start":
      case "recorder-error":
        return "O seu navegador não conseguiu gravar o vídeo. Tente usar o Google Chrome (ou o Edge) atualizado, em um computador, se possível.";
      case "no-data":
        return "A câmera abriu, mas não gerou vídeo. Feche outros aplicativos que possam estar usando a câmera e tente de novo.";
      default:
        return "Não foi possível iniciar a gravação de vídeo exigida para esta atividade.";
    }
  }

  // Painel de BLOQUEIO (barra o início). Diagnóstico + botão de nova tentativa +
  // saída realista. Preenche `container`.
  //
  // O que NÃO se promete aqui (#346): a liberação do professor (`waive-video`)
  // só age na CONCLUSÃO — `finalizeWithVideoGate` consulta `video_waived`, e o
  // botão "Liberar" do painel só aparece em `awaiting_video`, estado posterior
  // à arguição. Quem é barrado no INÍCIO não tem essa saída, então o texto
  // aponta para a que existe de fato: combinar com o professor.
  function blockingCameraError(container, { reason, onRetry } = {}) {
    if (!container) return;
    container.innerHTML = `
      <div style="max-width:520px;margin:0 auto;text-align:center;padding:22px 18px;border:1px solid #e6b3b3;background:#fdecec;border-radius:12px;color:#7a1f1f">
        <div style="font-size:34px;line-height:1;margin-bottom:10px">📷🚫</div>
        <h3 style="margin:0 0 8px;color:#7a1f1f">Câmera obrigatória para esta atividade</h3>
        <p style="margin:0 0 14px;line-height:1.5">${reasonText(reason)}</p>
        <button type="button" class="pg-retry" style="cursor:pointer;font:inherit;padding:10px 18px;border-radius:8px;border:none;background:#2563eb;color:#fff">Tentar de novo</button>
        <p style="margin:14px 0 0;font-size:13px;color:#8a5a5a">Se o problema persistir no seu equipamento, fale com o professor — ele pode combinar outro horário ou outra forma de avaliação.</p>
      </div>`;
    const btn = container.querySelector(".pg-retry");
    if (btn && typeof onRetry === "function") btn.addEventListener("click", () => onRetry(), { once: true });
  }

  // Vigia a CAPTURA (não o conteúdo — "sem ninguém/mão fora" é o proctoring de
  // conteúdo, à parte). Dispara onLost quando a track de vídeo termina (permissão
  // revogada, webcam desconectada) ou o recorder morre; onRegained quando volta.
  // Retorna { stop } para desligar os listeners.
  function attachTrackLossGuard(stream, recorder, { onLost, onRegained } = {}) {
    let lost = false;
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    const fireLost = () => { if (lost) return; lost = true; try { onLost && onLost(); } catch {} };
    const fireRegained = () => { if (!lost) return; lost = false; try { onRegained && onRegained(); } catch {} };
    const onEnded = () => fireLost();
    const onMute = () => fireLost();       // alguns navegadores só mutam a track
    const onUnmute = () => fireRegained();
    if (track) {
      track.addEventListener("ended", onEnded);
      track.addEventListener("mute", onMute);
      track.addEventListener("unmute", onUnmute);
    }
    if (recorder) recorder.addEventListener && recorder.addEventListener("error", fireLost);
    return {
      isLost: () => lost,
      markRegained: fireRegained,
      stop() {
        if (track) {
          track.removeEventListener("ended", onEnded);
          track.removeEventListener("mute", onMute);
          track.removeEventListener("unmute", onUnmute);
        }
        if (recorder) recorder.removeEventListener && recorder.removeEventListener("error", fireLost);
      },
    };
  }

  window.proctorGate = { pickVideoMime, probeCapture, blockingCameraError, attachTrackLossGuard };
})();
