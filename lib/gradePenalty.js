// Observações de proctoring para a DEVOLUTIVA do aluno.
//
// A antiga "penalidade automática" (proctoring/autoria → multiplicador na nota via
// GradePenaltyAgent) FOI REMOVIDA: o proctoring é indício para REVISÃO HUMANA, nunca
// acusação automática. Hoje os alertas de vídeo só são MOSTRADOS ao professor (que
// ajusta a nota à mão, se quiser) e podem colorir a devolutiva do aluno. Este módulo
// guarda apenas o helper que descreve o observado, em tom neutro/formativo.

// Observações de proctoring em wording NEUTRO e FORMATIVO para a DEVOLUTIVA do
// aluno — descreve só o OBSERVADO, como orientação, sem vocabulário de acusação (o
// StudentFeedbackAgent ainda passa pela varredura FORBIDDEN_PATTERNS). Null quando
// nada é relevante.
export function renderProctorForStudent(proctor) {
    const f = proctor && proctor.flags;
    if (!f) return null;
    const obs = [];
    if (f.absent && f.absent.pct >= 20) obs.push("em parte da gravação você não apareceu no vídeo");
    if (f.multiple_people && f.multiple_people.pct >= 20) obs.push("em alguns momentos apareceu outra pessoa no enquadramento");
    if (f.phone && f.phone.pct >= 25) obs.push("um celular apareceu durante parte da atividade");
    if (f.hands && f.hands.flag) obs.push("suas mãos ficaram fora do quadro por parte do tempo");
    if (f.framing && f.framing.flag) obs.push("o enquadramento saiu do padrão por um trecho contínuo");
    return obs.length ? obs.join("; ") : null;
}
