// O que fazer quando o aluno abre de novo o link da entrevista por mensagem:
// retomar de onde parou, recusar como submissão legada, ou começar do zero.
//
// Módulo PURO (sem imports) para poder ser testado sem banco nem cliente
// OpenAI — mesmo padrão do `lib/resumeGate.js`, que guarda a decisão gêmea dos
// fluxos de voz.
//
// Origem (incidente de 31/08/2026, trabalho `c4dd3bf6f4ab`): a preparação roda
// em background e a PRIMEIRA coisa que ela faz é gravar o PDF do aluno
// (`db.setStudentPdf`) — antes de existir saudação, conversa ou runtime state.
// Quando a OpenAI recusou as chamadas por falta de saldo, sobrou uma linha com
// `student_pdf` preenchido e `conversation_json`/`runtime_state_json` nulos. O
// `/start` usava o PDF como prova de "tentativa em andamento" e devolvia 409
// "iniciada em uma versão anterior do sistema": mensagem falsa, tela morta e
// nenhuma saída — nem retomar, nem recomeçar — mesmo depois de o saldo voltar.
//
// A prova de tentativa é o LOG DA CONVERSA, porque é ele que se retoma. Sem
// log não há nada a preservar, e recomeçar do zero é sempre seguro: o PDF é
// reenviado e a preparação roda de novo.

export const RESUME_FRESH = "fresh";      // nada a retomar → sessão nova em awaiting_upload
export const RESUME_HYDRATE = "hydrate";  // estado completo → rehidrata do banco
export const RESUME_LEGACY = "legacy";    // conversa de antes da migration 004 → 409

export function resumeDecision({ hasConversationLog, runtimeRow }) {
    if (!hasConversationLog) return RESUME_FRESH;
    // Conversa existe mas o runtime não tem versão de schema: é entrevista de
    // antes da migration 004, que não sabemos rehidratar. Continua sendo 409 —
    // aqui há conteúdo do aluno, e recomeçar por conta própria o apagaria.
    if (!runtimeRow?.runtime_state?.schema_version) return RESUME_LEGACY;
    return RESUME_HYDRATE;
}
