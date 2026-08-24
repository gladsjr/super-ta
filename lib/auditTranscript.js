// Bloco de RETRANSCRIÇÃO DE AUDITORIA para os AVALIADORES (#289, corte 4).
//
// O transcript ao vivo degrada porque o VAD pica a fala e o STT alucina os
// retalhos; o `final_transcript` (retranscrição do áudio contínuo, corte 2/3)
// é a fonte mais fiel ÀS PALAVRAS DO ALUNO. Em CONVIVÊNCIA: o avaliador segue
// recebendo a conversa ao vivo (que tem as falas do examinador e a ordem), e
// este bloco entra como fonte de correção quando as duas divergirem.
//
// Atribuição POSICIONAL (corte 2): o q_idx de cada segmento conta as falas do
// examinador já encerradas — em prova típica isso acompanha a ordem das
// perguntas, mas intervenções curtas deslocam o contador. Por isso o texto do
// bloco instrui a ancorar pelo CONTEÚDO, e "voltar ao assunto anterior" é uso
// legítimo (atribuição múltipla), nunca defeito (D3 da estratégia).
//
// Puro e testável — sem I/O.

function mmss(s) {
    const t = Math.max(0, Math.round(Number(s) || 0));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

// Constrói o bloco a partir do payload de submissions.final_transcript.
// `multiPart` = sessão com retomada (o tee cobre só o último trecho e o
// contador posicional reinicia): cai para o texto contínuo, sem atribuição.
// null = sem retranscrição utilizável (ausente, too_large, vazia).
export function buildAuditBlock({ final, multiPart = false }) {
    if (!final || typeof final !== "object") return null;
    if (final.mode === "segments" && Array.isArray(final.segments) && !multiPart) {
        const lines = [];
        for (const s of final.segments) {
            if (s.error || !s.text) continue;
            const q = Number(s.q_idx) || 0;
            const pos = q >= 1 ? `após a ${q}ª fala do examinador` : "antes da 1ª fala do examinador";
            lines.push(`[${mmss(s.start_s)}–${mmss(s.end_s)} · ${pos}] ${s.text}`);
        }
        if (lines.length) return { mode: "segments", text: lines.join("\n") };
    }
    const text = typeof final.text === "string" ? final.text.trim() : "";
    if (!text) return null;
    return { mode: "continuous", text };
}

// O bloco pronto para concatenar ao input do avaliador ("" quando não há).
export function auditPromptBlock(audit) {
    if (!audit) return "";
    const attrib = audit.mode === "segments"
        ? "Cada trecho traz o tempo e a POSIÇÃO (falado após a N-ésima fala do examinador) — em geral isso acompanha a ordem das perguntas, mas intervenções curtas deslocam o contador: ancore pelo CONTEÚDO. Se o aluno retomou um assunto anterior, o trecho pode pertencer a uma pergunta anterior — isso é legítimo: use o conteúdo na pergunta em que ele couber."
        : "Este bloco não tem atribuição por pergunta — use-o como registro contínuo da fala do aluno.";
    return `

**RETRANSCRIÇÃO DE AUDITORIA (fala do aluno — fonte de maior fidelidade)**
A transcrição da conversa acima foi gerada AO VIVO e pode conter falas do aluno picotadas, trocadas ou corrompidas pela captação. O bloco abaixo foi retranscrito do áudio contínuo da sessão, depois dela, e é mais fiel às PALAVRAS DO ALUNO (só a voz dele — as falas do examinador não aparecem aqui). Quando as duas fontes divergirem sobre o que o aluno DISSE, confie neste bloco. ${attrib}
${audit.text}`;
}
