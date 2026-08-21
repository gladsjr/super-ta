// Retranscrição pós-sessão do áudio contínuo do tee (issue #289, Fase 3 —
// CONVIVÊNCIA: gera o transcript_final de auditoria sem substituir a fonte da
// avaliação; o flip tem critério de saída próprio na estratégia).
//
// Por que funciona: o transcript ao vivo degrada porque o VAD fabrica trechos
// vazios que o STT alucina; o MESMO provedor sobre o áudio CONTÍNUO recupera o
// conteúdo (bancada #285 — a sessão 100% alucinada da Rebeca virou português
// íntegro). Roda em background após o fechamento (padrão runProctorAuto):
// falha é log + estado, nunca afeta a sessão.
//
// Provedor: a camada #284 (lib/stt.js) — hoje gpt-transcribe com glossário
// mecânico das perguntas da sessão (#293); quando a config apontar Groq/local,
// esta função herda sem mudança.

import { sttTranscribe } from "./stt.js";
import { extractGlossary } from "./sttGlossary.js";
import * as db from "./db.js";
import log from "./logger.js";

// Limite de upload da API de arquivos de áudio (25MB). O OGG do tee a ~24kbps
// fica em ~3,6MB/20min — sessões normais passam folgadas; se estourar, log e
// estado 'too_large' (o fatiamento por marcas entra num próximo corte).
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

// Dispara e esquece. `questions` = perguntas da sessão (plano/sorteio) para o
// glossário mecânico; `openaiClient` = o cliente do trabalho (benchmark ok).
export function runRetranscribeAuto({ submissionId, token, oggBuffer, tee, questions, workName, openaiClient, meterCtx }) {
    retranscribe({ submissionId, token, oggBuffer, tee, questions, workName, openaiClient, meterCtx })
        .catch(err => log.error("RETRANSCRIBE", `submission=${token}: ${err.message}`));
}

async function retranscribe({ submissionId, token, oggBuffer, tee, questions, workName, openaiClient, meterCtx }) {
    if (!oggBuffer || !oggBuffer.length) return;
    if (oggBuffer.length > MAX_UPLOAD_BYTES) {
        log.warn("RETRANSCRIBE", `submission=${token}: ogg ${oggBuffer.length}B > limite — marcado too_large`);
        await db.setFinalTranscript(submissionId, { mode: "too_large", bytes: oggBuffer.length, tee: teePublic(tee) });
        return;
    }
    const texts = [];
    if (workName) texts.push(workName);
    for (const q of questions || []) texts.push(typeof q === "string" ? q : q?.question);
    const keywords = extractGlossary(texts);

    const r = await sttTranscribe({
        openaiClient,
        buffer: oggBuffer,
        filename: `retranscricao-${token}.ogg`,
        keywords: keywords.length ? keywords : null,
        meterCtx, // custo real do trabalho — a retranscrição é parte da sessão
    });
    await db.setFinalTranscript(submissionId, {
        mode: "continuous",
        text: r.text,
        provider: r.provider,
        model: r.model,
        glossary_terms: keywords.length,
        tee: teePublic(tee),
    });
    log.info("RETRANSCRIBE", `ok submission=${token} provider=${r.provider} chars=${r.text.length} glossario=${keywords.length}`);
}

function teePublic(tee) {
    if (!tee) return null;
    return { key: tee.key, duration_s: tee.duration_s, marcas: Array.isArray(tee.index) ? tee.index.length : 0 };
}
