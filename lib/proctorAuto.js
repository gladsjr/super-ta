// Disparo AUTOMÁTICO da análise de vídeo (proctoring) ao fim da sessão (issues
// #209/#210). Desde a fila global (#262), isto é só um atalho fire-and-forget
// para enfileirar com prioridade automática: quem serializa, deduplica, persiste
// estado e trata falha é lib/proctorQueue.js. Nunca lança para o caller.
//
// Se uma retomada chegar depois, o novo upload chama isto de novo — o dedup da
// fila absorve; concluída a análise anterior, a nova entra normalmente.

import { enqueueProctor } from "./proctorQueue.js";

export function runProctorAuto(submissionId, tokenForLog) {
    enqueueProctor(submissionId, { priority: "auto", tokenForLog }).catch(() => {});
}
