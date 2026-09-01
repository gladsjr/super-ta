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

// Recado genérico para falha NOSSA que o aluno não pode resolver sozinho. O
// detalhe técnico fica no log — na tela ele só confunde e, pior, costuma ser
// lido como defeito do arquivo ou do equipamento dele.
export const FALHA_INTERNA_MESSAGE =
    "Tivemos um problema no nosso sistema ao processar o seu envio — não é o seu arquivo nem a sua conexão. "
    + "Avise o(a) professor(a) e tente novamente em alguns minutos.";

// Traduz QUALQUER erro num texto que o aluno possa ler e agir. Use sempre que a
// mensagem for parar na tela dele (#358): `err.message` cru é texto de log, e
// entregá-lo é a diferença entre "avise o professor" e "seu arquivo está ruim".
export function mensagemParaOAluno(err) {
    return isProviderQuotaError(err) ? PROVIDER_QUOTA_MESSAGE : FALHA_INTERNA_MESSAGE;
}

// Erros que a sessão de VOZ não tem como superar continuando (#359).
//
// O relay recebe muitos `error` do Realtime que são ruído inofensivo — item
// inexistente ao cancelar, buffer curto demais, resposta já cancelada. Derrubar
// a arguição por causa deles seria pior que o defeito original. O que NÃO se
// recupera é a sessão perder a autorização ou o modelo: dali em diante a
// conexão fica viva e muda, e o aluno fala para o nada.
const FATAL_MARKERS = [
    "insufficient_quota",
    "exceeded your current quota",
    "billing_hard_limit_reached",
    "billing hard limit",
    "account is not active",
    "invalid_api_key",
    "authentication",
    "permission_denied",
    "model_not_found",
    "server_error",
];

export function erroFatalDoProvedor(erro) {
    if (!erro) return false;
    const alvo = [erro.code, erro.type, erro.message]
        .filter(v => typeof v === "string").join(" ").toLowerCase();
    if (!alvo) return false;
    return FATAL_MARKERS.some(m => alvo.includes(m));
}
