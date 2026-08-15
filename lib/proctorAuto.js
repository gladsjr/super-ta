// Disparo AUTOMÁTICO da análise de vídeo (proctoring) ao fim da sessão, em
// background (issue #210 — entrevista; espelha o #209 da prova oral). Fire-and-
// forget: analisa TODAS as partes de vídeo atuais e grava oral_proctor_json.
// Nunca lança para o caller — falha vira só log. Compartilhado porque oral e
// entrevista usam as MESMAS colunas (oral_video_parts/oral_proctor_json) e o
// mesmo núcleo de análise (analyzeOralVideoParts).
//
// Se uma retomada chegar depois, o novo upload chama isto de novo e sobrescreve.
// O pipeline de avaliação em lote (routes/work.js) segue como backstop idempotente
// (só reanalisa se ainda não houver relatório, ou sob force).

import * as db from "./db.js";
import { analyzeOralVideoParts } from "./proctor.js";
import log from "./logger.js";

export function runProctorAuto(submissionId, tokenForLog) {
    (async () => {
        try {
            const parts = await db.getOralVideoParts(submissionId);
            if (!parts.length) return;
            const report = await analyzeOralVideoParts(parts);
            await db.setOralProctor(submissionId, report);
            log.info("PROCTOR", `análise automática ok submission=${tokenForLog} frames=${report.frames} ms=${report.ms}`);
        } catch (e) {
            log.error("PROCTOR", `análise automática falhou submission=${tokenForLog}: ${e.message}`);
        }
    })();
}
