// Gerador de resposta de aluno simulada (LLM). Núcleo compartilhado entre o
// harness E2E (tests/audio-e2e/student.mjs) e a sugestão de resposta para o
// professor em conversas de TESTE (routes/interview.js → /suggest-answer).
//
// A geração é uma chamada ao FAST_MODEL, opcionalmente ancorada no material do
// trabalho. NÃO toca banco. Billing é OPCIONAL: passe `meterCtx` com `workId`
// para contabilizar; omita (ou null) para uma chamada FORA do orçamento — o caso
// da sugestão de teste e do harness (que nunca contabilizou o simulador).

import { openai } from "./openaiClient.js";
import { FAST_MODEL } from "./config.js";
import { meteredResponses } from "./billing.js";

// Perfis de aluno oferecidos ao professor na sugestão (conversa de teste).
// Genéricos (não amarrados a um trabalho específico); a fala sai ancorada no
// material do trabalho corrente. `contradiz` existe para exercitar a verificação
// de contradições por turno do entrevistador.
export const STUDENT_PROFILES = {
    domina: {
        label: "Domina o trabalho",
        system:
            "Você é o autor do trabalho e DOMINA o conteúdo. Responde com naturalidade, em " +
            "português do Brasil falado (frases curtas, tom de conversa), citando números, premissas " +
            "e seções do trabalho quando fizer sentido. Não enrola nem despeja tudo — responde só o " +
            "que foi perguntado.",
    },
    vago: {
        label: "Vago / enrola",
        system:
            "Você leu o trabalho por cima e NÃO domina os detalhes. Responde de forma vaga e genérica, " +
            "desvia quando perguntam números específicos, usa muitos 'tipo', 'mais ou menos', 'acho que'. " +
            "Português do Brasil falado, frases curtas.",
    },
    inseguro: {
        label: "Inseguro / hesitante",
        system:
            "Você entende o trabalho mas é tímido e inseguro. Hesita, dá respostas curtas, às vezes pede " +
            "pra confirmar se entendeu a pergunta. Português do Brasil falado.",
    },
    contradiz: {
        label: "Contradiz o trabalho",
        system:
            "Você é o autor mas, NESTA resposta, introduza com naturalidade UMA inconsistência com o " +
            "material do trabalho (troque um número, inverta uma premissa, ou afirme algo que o relatório " +
            "nega), como quem se confunde de boa-fé. Mantenha o resto plausível. Português do Brasil " +
            "falado, frases curtas.",
    },
};

// Gera a próxima fala do aluno em texto.
//   systemBehavior : diretriz de comportamento (de um perfil ou persona).
//   history        : [{ role: "interviewer"|"aluno", text }] em ordem cronológica.
//   question       : última fala do entrevistador (responder a isto).
//   workContext    : material do trabalho (texto cru OU work_analysis serializado)
//                    para ancorar a fala; opcional.
//   meterCtx       : { workId, submissionId } para contabilizar; null/omitido =
//                    chamada fora do orçamento (sem débito, sem warn de billing).
export async function generateStudentAnswer({ systemBehavior, history = [], question, workContext = null, meterCtx = null }) {
    const convo = (history || [])
        .map(t => `${t.role === "interviewer" ? "Entrevistador" : "Aluno"}: ${t.text}`)
        .join("\n");

    const instructions =
        (systemBehavior || "") +
        "\n\nVocê está numa entrevista oral sobre o seu trabalho. Responda APENAS com a sua " +
        "próxima fala (sem aspas, sem rótulo de quem fala, sem narração). Mantenha de 1 a 4 frases. " +
        "Se o entrevistador pedir o seu nome, diga um nome plausível. Se pedir um 'ok' ou confirmação " +
        "pra começar, confirme de forma curta e natural." +
        (workContext
            ? "\n\nResponda ANCORADO no material abaixo (o trabalho entregue ou a análise dele). Cite " +
              "números, premissas e seções quando o entrevistador perguntar. Se algo não estiver no " +
              "material, assuma de forma plausível sem inventar dados precisos.\n\n" +
              "=== MATERIAL DO TRABALHO ===\n" + String(workContext).slice(0, 120000) + "\n=== FIM ==="
            : "");

    const input =
        (convo ? `Conversa até agora:\n${convo}\n\n` : "") +
        `Última fala do entrevistador (responda a isto):\n${question}`;

    const call = () => openai.responses.create({ model: FAST_MODEL, instructions, input });
    // Contabiliza só quando há workId; senão chama direto (fora do orçamento).
    const res = (meterCtx && meterCtx.workId)
        ? await meteredResponses({ ...meterCtx, agentLabel: "STUDENT_SIM", model: FAST_MODEL }, call)
        : await call();

    const text = (res.output_text || "").trim();
    if (!text) throw new Error("simulador de aluno devolveu fala vazia");
    return text;
}
