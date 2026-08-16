// FONTE ÚNICA dos limiares de exibição da fiscalização por vídeo (#245) e do
// painel por eixo (#244). Consumido pela LISTA de alunos (professor.html) e pela
// tela INDIVIDUAL (conversation.html).
//
// Antes os limiares viviam duplicados nas duas telas, com valores DIFERENTES: um
// aluno com celular em 3% e 23 quadros disparava na lista (count >= 10) e não
// disparava na individual (pct >= 25). O professor via o sinal, abria o aluno e
// não encontrava nada.
//
// Dois princípios:
//  1. O limiar DESTACA, não OCULTA. Todo eixo analisado aparece sempre; o limiar
//     decide a cor/severidade. Esconder sinal abaixo do limiar fazia indício real
//     sumir da tela.
//  2. Nada aqui acusa. É indício para revisão humana — ver a ADR 0004.
(function () {
    // Celular por SEGUNDOS, não por percentual (#245): o uso dura poucos segundos
    // e o percentual dilui isso numa prova longa (3% de 11 min). Dois gatilhos:
    //   - sequência contígua longa  -> "estava com o aparelho na mão";
    //   - total alto, ainda que espalhado -> abundante demais para ignorar.
    // Carimbos espalhados com total baixo são a assinatura do falso positivo que
    // o verifyPhoneZoom já combate (gesticular lido como celular).
    const LIMIARES = {
        phone: { runSec: 10, totalSec: 30 },
        absent: { pct: 20 },
        multiple_people: { pct: 20 },
    };

    const seg = (n) => `${Math.round(n)} s`;
    // Relatórios ANTIGOS não têm count_sec (o passo era sempre 1 s, então `count`
    // já era segundos) nem max_run_sec para celular. Só uma reanálise dá o sinal
    // melhor nos vídeos já processados; até lá, degrada para o que existe.
    const segundos = (f) => (f?.count_sec != null ? f.count_sec : (f?.count || 0));

    function eixoCelular(f) {
        if (!f) return null;
        const total = segundos(f);
        const run = f.max_run_sec; // undefined em relatório antigo
        const sustentado = run != null && run >= LIMIARES.phone.runSec;
        const abundante = total >= LIMIARES.phone.totalSec;
        const partes = [`${seg(total)} no total`];
        if (run != null) partes.push(`maior sequência ${seg(run)}`);
        else partes.push("sequência não medida (análise antiga)");
        if (f.raw_count != null && f.raw_count > (f.count || 0)) partes.push(`${f.raw_count} brutas antes do filtro`);
        return {
            key: "phone",
            label: "celular",
            state: (sustentado || abundante) ? "alert" : (total > 0 ? "ok" : "ok"),
            detail: total > 0 ? partes.join(" · ") : "nenhuma detecção",
            at: f.at || [],
        };
    }

    function eixoPct(key, label, f, limiar, textoZero) {
        if (!f) return null;
        const pct = f.pct || 0;
        const total = segundos(f);
        return {
            key, label,
            state: pct >= limiar ? "alert" : "ok",
            detail: total > 0 ? `${pct}% da sessão · ${seg(total)}` : textoZero,
            at: f.at || [],
        };
    }

    function eixoFlag(key, label, f, textoOk) {
        // Ausente = NÃO ANALISADO (sidecar MediaPipe indisponível), que é
        // diferente de "ok". A tela precisa distinguir os dois.
        if (!f) return { key, label, state: "unanalyzed", detail: "não analisado neste vídeo", at: [] };
        const partes = [];
        if (f.absent_pct != null) partes.push(`fora do quadro em ${f.absent_pct}% do tempo`);
        if (f.bad_pct != null) partes.push(`fora do padrão em ${f.bad_pct}% do tempo`);
        if (f.max_absence_sec) partes.push(`maior ausência ${seg(f.max_absence_sec)}`);
        if (f.max_bad_sec) partes.push(`maior trecho ${seg(f.max_bad_sec)}`);
        return {
            key, label,
            state: f.flag ? "alert" : "ok",
            detail: partes.length ? partes.join(" · ") : textoOk,
            at: f.at || [],
        };
    }

    // Avalia o relatório → lista de eixos, na ordem de exibição. Eixos ausentes do
    // relatório saem como "não analisado" quando aplicável, e nunca somem.
    function evaluate(report) {
        const f = (report && report.flags) || null;
        if (!f) return [];
        return [
            eixoCelular(f.phone),
            eixoPct("absent", "ausência", f.absent, LIMIARES.absent.pct, "sempre presente"),
            eixoPct("multiple_people", "+1 pessoa", f.multiple_people, LIMIARES.multiple_people.pct, "ninguém além do aluno"),
            eixoFlag("hands", "mãos", f.hands, "mãos à mostra"),
            eixoFlag("framing", "enquadramento", f.framing, "dentro do padrão"),
        ].filter(Boolean);
    }

    const hasAlert = (eixos) => (eixos || []).some(e => e.state === "alert");

    // Cobertura parcial da análise (#249) — não é um eixo, é um aviso sobre o
    // próprio relatório: dizer "nenhum alerta" sobre metade do vídeo engana.
    function coverageWarning(report) {
        if (!report || !report.truncated) return null;
        return report.video_duration_s
            ? `analisados ${seg(report.covered_s)} de ${seg(report.video_duration_s)} de vídeo`
            : "cobertura parcial do vídeo";
    }

    window.proctorAxes = { evaluate, hasAlert, coverageWarning, LIMIARES };
})();
