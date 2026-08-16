// Vigilância LEVE de posição ao vivo nos fluxos de voz (#267).
//
// Princípios (ADR 0021):
//   - A fiscalização fala pela INTERFACE, nunca pela voz do arguidor — a pausa
//     não compete com a voz, substitui: o silêncio é o aviso.
//   - A GRAVAÇÃO é o ativo; a dica é conveniência. Sob qualquer sinal de
//     sofrimento (inferência lenta, queda de captura), a vigilância morre
//     primeiro — e desligada vira SINAL ao professor, não silêncio (ADR 0018).
//   - Só se cobra ao vivo o que o aluno pode consertar: enquadramento,
//     distância, mãos à mostra. Celular/segunda pessoa ficam na análise
//     posterior (ADR 0004 — nada de acusação automática).
//
// O módulo é PURO nos miolos (avaliação de pose + máquina de estados), para os
// testes, e mínimo no DOM (o modal). As páginas (oral-student/live-student)
// fazem a cola: rodam a pose no tick de presença que JÁ existe e reagem às
// ações devolvidas aqui (enviar posture_lost/posture_ok ao relay, etc.).
(function () {
    // Sustentação: 10 s inadequado → pausa; ~3 s adequado → libera. O tick fica
    // mais rápido durante a pausa (a página cuida disso) — a prova está parada,
    // não há voz competindo.
    const DEFAULTS = {
        badMs: 10000,
        okMs: 3000,
        // Orçamento de inferência: mediana das primeiras amostras acima disso →
        // máquina fraca, vigilância desligada (a medição substitui contar núcleos).
        budgetMs: 80,
        benchSamples: 6,
    };

    // ---- Avaliação de posição a partir da POSE (sem mãos, sem objetos) ----
    // Espelho tolerante do evalPosition do setup: mesmos marcos, margens mais
    // frouxas (aqui é meio de prova, não portão) e SEM a exigência de estar "de
    // frente" — virar a cabeça enquanto pensa é normal.
    // Marcos BlazePose: 0 nariz, 2/5 olhos, 7/8 orelhas, 11/12 ombros, 15/16 punhos.
    function evaluatePose(L, opts = {}) {
        const faceMin = (opts.faceMin ?? 0.06) * 0.85; // 15% mais tolerante que o setup
        const faceMax = (opts.faceMax ?? 0.16) * 1.15;
        if (!L) return { ok: false, guidance: "Apareça na câmera — mostre o rosto e o tronco." };
        const vis = i => (L[i].visibility != null ? L[i].visibility : 1);
        const inFrame = i => L[i].x > 0.02 && L[i].x < 0.98 && L[i].y > 0.03 && L[i].y < 0.99;
        const head = vis(0) > 0.5 && inFrame(0) && L[0].y > 0.06;
        if (!head) return { ok: false, guidance: "Mostre o rosto inteiro — sua cabeça precisa aparecer na câmera." };
        const trunk = vis(11) > 0.4 && vis(12) > 0.4 && inFrame(11) && inFrame(12);
        if (!trunk) return { ok: false, guidance: "Enquadre o tronco: os dois ombros precisam aparecer." };
        const faceW = Math.abs(L[7].x - L[8].x);
        if (vis(7) > 0.5 && vis(8) > 0.5 && faceW > 0.001) {
            if (faceW > faceMax) return { ok: false, guidance: "Afaste-se um pouco da câmera." };
            if (faceW < faceMin) return { ok: false, guidance: "Aproxime-se um pouco da câmera." };
        }
        // Punho no quadro ≈ mão à mostra (aproximação honesta para AVISO; a
        // análise fina de mãos continua na fiscalização pós-prova).
        const wristOk = i => vis(i) > 0.35 && inFrame(i);
        if (!wristOk(15) && !wristOk(16)) {
            return { ok: false, guidance: "Deixe as mãos visíveis na câmera, como nas fotos de exemplo." };
        }
        return { ok: true, guidance: "" };
    }

    // ---- Máquina de estados (pura, testável com relógio injetado) ----
    // feed({ok, guidance, inferMs, now}) → { action: 'pause'|'resume'|null,
    // guidance, okProgress } — okProgress ∈ [0,1] alimenta a contagem do modal.
    function createTracker(opts = {}) {
        const cfg = { ...DEFAULTS, ...opts };
        let state = "watching";       // watching | paused | disabled
        // null = "sem contagem aberta" (0 é um timestamp legítimo com relógio injetado)
        let badSince = null, okSince = null;
        let disabledReason = null;
        const bench = [];

        function disable(reason) {
            if (state === "disabled") return;
            state = "disabled"; disabledReason = reason || "desligado_por_desempenho";
        }
        function feed({ ok, guidance = "", inferMs = 0, now = Date.now() }) {
            if (state === "disabled") return { action: null, guidance: "", okProgress: 0 };
            // Benchmark corrente: mediana das primeiras amostras acima do orçamento
            // → a máquina não sustenta a vigilância sem ameaçar a gravação.
            if (inferMs > 0 && bench.length < cfg.benchSamples) {
                bench.push(inferMs);
                if (bench.length === cfg.benchSamples) {
                    const sorted = [...bench].sort((a, b) => a - b);
                    const median = sorted[Math.floor(sorted.length / 2)];
                    if (median > cfg.budgetMs) { disable("desligado_por_desempenho"); return { action: null, guidance: "", okProgress: 0 }; }
                }
            }
            if (state === "watching") {
                if (ok) { badSince = null; return { action: null, guidance: "", okProgress: 0 }; }
                if (badSince == null) badSince = now;
                if (now - badSince >= cfg.badMs) {
                    state = "paused"; okSince = null; badSince = null;
                    return { action: "pause", guidance, okProgress: 0 };
                }
                return { action: null, guidance, okProgress: 0 };
            }
            // paused: espera posição adequada SUSTENTADA para liberar — sem isso,
            // uma inclinação momentânea libera e o modal volta 30 s depois.
            if (!ok) { okSince = null; return { action: null, guidance, okProgress: 0 }; }
            if (okSince == null) okSince = now;
            const p = Math.min(1, (now - okSince) / cfg.okMs);
            if (p >= 1) { state = "watching"; okSince = null; return { action: "resume", guidance: "", okProgress: 1 }; }
            return { action: null, guidance: "", okProgress: p };
        }
        return {
            feed, disable,
            get state() { return state; },
            get disabledReason() { return disabledReason; },
        };
    }

    // ---- Modal de pausa (autoresolvido: NENHUM clique) ----
    // Câmera ao vivo AO LADO das fotos canônicas de posição, mensagem de uma
    // linha e o progresso da liberação. O aluno está longe do teclado — a única
    // saída é se ajustar, e o modal some sozinho.
    function showPauseModal({ stream, exampleSrcs = [], guidance = "" }) {
        if (document.getElementById("nudge-modal")) { setPauseGuidance(guidance); return; }
        const o = document.createElement("div");
        o.id = "nudge-modal";
        o.style.cssText = "position:fixed;inset:0;z-index:9998;background:rgba(20,16,10,.93);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:20px";
        const imgs = exampleSrcs.filter(Boolean).map(src =>
            `<img src="${src}" alt="posição esperada" style="width:170px;border-radius:10px;border:2px solid #7fb069"/>`).join("");
        o.innerHTML =
            `<h2 style="margin:0 0 6px">⏸️ Pausado — ajuste sua posição</h2>` +
            `<p id="nudge-guid" style="margin:0 0 14px;font-size:18px;max-width:520px;line-height:1.4"></p>` +
            `<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;justify-content:center">` +
            `<div><video id="nudge-cam" autoplay muted playsinline style="width:220px;border-radius:10px;border:2px solid #e0a95e;transform:scaleX(-1)"></video>` +
            `<div style="font-size:13px;opacity:.8;margin-top:4px">você agora</div></div>` +
            (imgs ? `<div><div style="display:flex;gap:10px">${imgs}</div><div style="font-size:13px;opacity:.8;margin-top:4px">posição esperada</div></div>` : "") +
            `</div>` +
            `<p style="margin:14px 0 0;font-size:15px;opacity:.9">A conversa continua sozinha quando você se ajustar.</p>` +
            `<div id="nudge-count" style="margin-top:8px;font-size:15px;min-height:22px;color:#7fb069"></div>`;
        document.body.appendChild(o);
        setPauseGuidance(guidance);
        try { const v = document.getElementById("nudge-cam"); if (stream) v.srcObject = stream; } catch {}
    }
    function setPauseGuidance(text) {
        const g = document.getElementById("nudge-guid");
        if (g && text) g.textContent = text;
    }
    // Progresso da liberação: mostra a contagem enquanto o aluno SUSTENTA a
    // posição correta ("mantenha… 3, 2, 1").
    function setPauseProgress(fraction, okMs) {
        const c = document.getElementById("nudge-count");
        if (!c) return;
        if (fraction <= 0) { c.textContent = ""; return; }
        const remaining = Math.ceil(((okMs ?? DEFAULTS.okMs) * (1 - fraction)) / 1000);
        c.textContent = `Boa! Mantenha a posição… ${Math.max(remaining, 1)}`;
    }
    function hidePauseModal() {
        const o = document.getElementById("nudge-modal");
        if (o) o.remove();
    }

    // ---- Integração completa (presença + vigilância), compartilhada pelas
    // duas páginas de voz ----
    // Substitui o antigo startPresenceWatch: UM tick de pose alimenta os dois
    // sinais — 'presence' (vigia de silêncio do servidor, Layer 2) e a
    // vigilância de posição. Custo idêntico ao que já existia: nenhuma
    // inferência extra, só a leitura dos marcos que a pose já devolve.
    //   attachWatch({ video, stream, poseLm, getWs, isEnded, faceMin, faceMax,
    //                 exampleSrcs, enabled }) → { stop, disable, state }
    function attachWatch(opts) {
        const { video, stream, poseLm, getWs, isEnded, exampleSrcs = [] } = opts;
        const okMs = opts.okMs ?? DEFAULTS.okMs;
        const tracker = createTracker(opts);
        let timer = 0, lastPresent = null, pausedByUs = false, stateSent = null;
        // Sem pose ou vigilância desligada de partida: presença fica muda
        // (o servidor assume presente — degradação segura) e o estado vira sinal.
        if (!poseLm) tracker.disable("indisponivel");
        else if (opts.enabled === false) tracker.disable(opts.disabledReason || "desligado_por_desempenho");

        function send(msg) {
            try { const ws = getWs(); if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; } } catch {}
            return false;
        }
        // Só marca como enviado quando o WS estava aberto de fato — o primeiro
        // tick pode rodar antes de a conexão abrir, e o estado se perderia.
        function syncState() {
            const s = tracker.state === "disabled" ? tracker.disabledReason : "ativo";
            if (s !== stateSent && send({ type: "nudges_state", state: s })) stateSent = s;
        }
        function release() {
            if (!pausedByUs) return;
            pausedByUs = false; send({ type: "posture_ok" }); hidePauseModal();
        }
        function tick() {
            if (isEnded()) { release(); return; }
            let present = lastPresent == null ? true : lastPresent;
            let L = null, inferMs = 0;
            try {
                if (poseLm && video.videoWidth && video.readyState >= 2) {
                    const t0 = performance.now();
                    const pr = poseLm.detectForVideo(video, performance.now());
                    inferMs = performance.now() - t0;
                    L = (pr.landmarks && pr.landmarks[0]) || null;
                    present = !!L;
                }
            } catch {}
            if (present !== lastPresent) { lastPresent = present; send({ type: "presence", present }); }
            syncState();
            if (tracker.state !== "disabled") {
                const ev = evaluatePose(L, opts);
                const r = tracker.feed({ ok: ev.ok, guidance: ev.guidance, inferMs });
                if (tracker.state === "disabled") { syncState(); release(); }
                else if (r.action === "pause") {
                    pausedByUs = true; send({ type: "posture_lost" });
                    showPauseModal({ stream, exampleSrcs, guidance: r.guidance });
                } else if (r.action === "resume") {
                    release();
                } else if (pausedByUs) {
                    if (r.guidance) setPauseGuidance(r.guidance);
                    setPauseProgress(r.okProgress, okMs);
                }
            }
            // Pausado: tick rápido (a prova está parada, não há voz competindo);
            // vigiando: o ritmo de sempre.
            timer = setTimeout(tick, pausedByUs ? 1000 : 2500);
        }
        tick();
        return {
            stop() { if (timer) { clearTimeout(timer); timer = 0; } release(); },
            // Watchdog externo (queda de captura, gravador sofrendo): a
            // vigilância morre primeiro — a gravação é o ativo.
            disable(reason) { tracker.disable(reason || "desligado_apos_queda"); release(); syncState(); },
            get state() { return tracker.state; },
        };
    }

    const api = { evaluatePose, createTracker, attachWatch, showPauseModal, setPauseGuidance, setPauseProgress, hidePauseModal, DEFAULTS };
    if (typeof window !== "undefined") window.liveNudge = api;
    else if (typeof globalThis !== "undefined") globalThis.liveNudge = api;
})();
