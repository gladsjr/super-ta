// Falha do PROVEDOR de IA que o aluno precisa entender, não só o log.
//
// Módulo PURO (sem imports) para ser testável isolado.
//
// Origem (mesmo incidente do `lib/interviewResume.js`): a conta da OpenAI ficou
// sem saldo no meio da janela de entrevistas. O aluno viu "Erro ao processar
// arquivo com a IA" — que soa como "o seu PDF está estragado" e o levou a
// tentar de novo com outro arquivo, quando o problema não era dele nem tinha
// solução do lado dele. Distinguir a recusa por saldo transforma uma tela sem
// saída num recado acionável: avise o professor, depois recarregue.
//
// Por que casar também pelo TEXTO da mensagem, e não só por `status`/`code`: no
// caminho da preparação o erro é reembrulhado (`step=upload failed: ...`) e
// perde os campos do SDK — sobra só o texto. Por isso a checagem desce pela
// cadeia de `cause` E procura os marcadores no texto.

export const PROVIDER_QUOTA = "provider_quota";

// Recusa por saldo/limite de faturamento — o professor precisa recarregar a
// conta. NÃO inclui 429 puro: rate limit é transitório e se resolve sozinho,
// e tratá-lo como "sem saldo" mandaria o aluno atrás do professor à toa.
const QUOTA_MARKERS = [
    "insufficient_quota",
    "exceeded your current quota",
    "billing_hard_limit_reached",
    "billing hard limit",
    "account is not active",
];

export function isProviderQuotaError(err, depth = 0) {
    if (!err || depth > 5) return false;
    const code = err.code ?? err.error?.code ?? err.type ?? err.error?.type ?? null;
    if (typeof code === "string" && QUOTA_MARKERS.includes(code.toLowerCase())) return true;
    const text = String(err.message ?? err.error?.message ?? "").toLowerCase();
    if (QUOTA_MARKERS.some(m => text.includes(m))) return true;
    return isProviderQuotaError(err.cause, depth + 1);
}

// Recado ao aluno. Serve tanto para a falha no envio do trabalho quanto para a
// falha no meio da entrevista: nos dois casos a saída é a mesma — avisar o
// professor e recarregar depois. O `/start` já sabe recomeçar do zero quando
// nada chegou a ser gravado, então "recarregue a página" é conselho honesto.
export const PROVIDER_QUOTA_MESSAGE =
    "O provedor de IA recusou a chamada: a conta está sem saldo. Isso não é problema do seu arquivo. "
    + "Avise o(a) professor(a) e, assim que o saldo for reposto, recarregue esta página para continuar.";
