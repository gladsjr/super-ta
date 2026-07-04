// Janela de revisão pós-encerramento (LGPD self-access), compartilhada entre a
// entrevista padrão e a prova oral. Após `completed_at`, o aluno tem
// REVIEW_WINDOW_DAYS dias para ver a conversa/transcrição e mandar UM comentário
// ao professor. A devolutiva/nota publicadas NÃO dependem desta janela (a
// publicação pode ocorrer depois e a visibilidade é controlada pelo professor).
export const REVIEW_WINDOW_DAYS = 7;

export function reviewWindowState(submission) {
    if (!submission?.completion_reason || !submission?.completed_at) {
        return { eligible: false, expired: false, deadline: null };
    }
    const completed = new Date(submission.completed_at);
    const deadline = new Date(completed.getTime() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const now = new Date();
    return { eligible: now < deadline, expired: now >= deadline, deadline: deadline.toISOString() };
}
