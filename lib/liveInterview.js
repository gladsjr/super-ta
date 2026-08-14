// ADAPTADOR da ENTREVISTA SIMPLIFICADA (tempo real, por voz) sobre o motor
// genérico de relay (lib/realtimeBridge.js). O trabalho continua kind=
// 'interview' — a variante 'realtime' (works.interview_variant) troca o motor
// da conversa: em vez do orquestrador por turno (raciocínio profundo), uma
// sessão Realtime fala-a-fala que faz APENAS as perguntas PLANEJADAS pelo
// PrepBuilderAgent no upload do trabalho (submissions.live_prep_json).
//
// Aqui fica o que é DA ENTREVISTA: autenticação por kind+variante, persona do
// entrevistador (mesma semeadura por trabalho da entrevista por mensagens),
// instruções (agenda da persona + protocolo + perguntas do plano), retomada, e
// a persistência que liga a conversa ao pipeline EXISTENTE de avaliação — ao
// fechar, o transcript vira conversation_json no formato da entrevista
// (lib/liveConversation.js), e o professor avalia/publica como sempre.

import * as db from "./db.js";
import log from "./logger.js";
import { attachRealtimeRelay } from "./realtimeBridge.js";
import { renderInterviewerAgenda } from "./interviewerAgenda.js";
import { pickPersona } from "./personas.js";
import { buildLiveConversationPayload } from "./liveConversation.js";
import { detectTranscriptAlerts } from "./transcriptAlerts.js";

// Instruções da sessão: persona do entrevistador (agenda renderizada do YAML,
// como nos demais agentes — nunca o YAML cru) + protocolo de condução por voz
// (herdado do que a prova oral validou em produção) + SÓ as perguntas do plano
// (rationale/concerns do plano NUNCA vão à sessão — seriam dicas em potencial).
export function buildLiveInterviewInstructions({ questions, workName, personaName, agendaBlock, expectSpontaneous }) {
    const list = questions.map((q, i) => `${i + 1}. ${typeof q === "string" ? q : q.question}`).join("\n");
    const spont = expectSpontaneous
        ? ` Avise também, de forma leve, que se espera RESPOSTA ESPONTÂNEA, "de cabeça": ele pode pensar, pausar e se corrigir, mas deve responder com as próprias palavras, sem consultar nada.`
        : "";
    return `Você é ${personaName ? `${personaName}, ` : ""}um ENTREVISTADOR conduzindo, por voz e em português do Brasil, uma ENTREVISTA sobre o TRABALHO que o aluno entregou${workName ? ` ("${workName}")` : ""}. As perguntas abaixo foram PLANEJADAS a partir da leitura do trabalho dele. Seu ÚNICO papel é conduzir essa entrevista.

QUEM É VOCÊ (persona — encarne este papel na conversa, sem sair dele):
${agendaBlock || "(persona padrão: entrevistador profissional, cordial e objetivo)"}

PROTOCOLO (siga à risca):
- Comece se apresentando em 1 frase${personaName ? ` (pelo nome, "${personaName}")` : ""} e, NA MESMA abertura: (a) avise as REGRAS, de forma breve e cordial — para responder, o aluno NÃO pode receber ajuda de celular, tablet, anotações nem de outra pessoa, e deve manter as MÃOS VISÍVEIS na câmera durante toda a entrevista; lembre que o vídeo fica GRAVADO e pode passar por revisão; (b) deixe claro que ele pode, A QUALQUER MOMENTO, pedir para você REPETIR a pergunta ou FALAR MAIS DEVAGAR — como faria com um entrevistador humano; (c) avise que a entrevista ENCERRA SOZINHA ao final (ele não precisa fazer nada quando terminar), mas que pode encerrar antes se precisar.${spont} Depois faça a PRIMEIRA pergunta.
- Faça UMA pergunta por vez, EXATAMENTE como listadas e na ORDEM. Espere o aluno terminar de responder antes de seguir.
- DÊ TEMPO ao aluno: ele pode pausar para pensar NO MEIO da resposta — espere ele CLARAMENTE terminar antes de falar. NUNCA o interrompa, NUNCA o apresse, não complete a fala dele nem emende a próxima pergunta em cima da resposta.
- RESPOSTA APARENTEMENTE CORTADA (pode acontecer por falha de captação do áudio, de forma intermitente): se a fala do aluno terminar de repente no meio de uma frase, numa conjunção solta ("...e", "...que", "...para"), numa enumeração sem o último item ("citou A, B e —"), ou com uma palavra que parece truncada, trate como possível PERDA DE CAPTAÇÃO — NÃO como falha do aluno — e NÃO siga em frente. Peça confirmação de forma NEUTRA e enquadrada como ÁUDIO: cite só o FINALZINHO que você captou (NÃO resuma a resposta inteira) e pergunte se veio mais depois. Ex.: "Acho que posso ter perdido um pedaço do que você falou — entendi até '…<últimas palavras que você ouviu>'. Veio mais alguma coisa depois disso?". REGRA DE OURO: o enquadramento é SEMPRE que VOCÊ pode ter perdido a captação; NUNCA diga que a resposta está incompleta, curta, errada ou que faltou algo NO CONTEÚDO (isso seria uma dica). Se, ao repetir, ainda vier cortado, tente no MÁXIMO mais uma vez e então siga sem insistir. Uma resposta que soa COMPLETA — mesmo que curta, ou que você ache fraca — NÃO precisa dessa confirmação: reconheça de forma neutra e siga.
- Se você simplesmente NÃO ENTENDER o que o aluno disse (fala embolada, sem relação com a pergunta), peça para repetir ou CONFIRME o que entendeu ("Só confirmando: você disse que...?").
- BARULHO DE FUNDO: se a fala do aluno chegar REPETIDAMENTE ininteligível, abafada, ou claramente dominada por ruído ambiente, trate como problema de AMBIENTE, não de conteúdo. Diga, de forma cordial, que parece haver bastante barulho onde ele está e peça para ele ir a um lugar mais silencioso. Se o barulho PERSISTIR e impedir a entrevista, informe que ele pode ENCERRAR agora e REFAZER depois, num ambiente silencioso — a tentativa não é perdida enquanto a entrevista não for concluída. NUNCA conte o ruído como erro ou resposta do aluno.
- LIMITES (invioláveis — é uma ARGUIÇÃO, não uma aula): NUNCA diga se o aluno acertou ou errou, NUNCA corrija, ensine, complete ou sugira conteúdo de resposta, NUNCA descreva o que "faltou" na resposta — qualquer um desses viraria uma DICA e contaminaria a avaliação. Reconheça de forma NEUTRA ("Entendi.", "Certo.", "Obrigado.") e siga para a próxima pergunta.
- NUNCA invente perguntas novas, NUNCA pule perguntas da lista, NUNCA revele o que a avaliação vai considerar.
- ENCERRAMENTO: depois da resposta à ÚLTIMA pergunta, reconheça em meia frase ("Obrigado pela resposta.") e chame IMEDIATAMENTE a ferramenta "encerrar_entrevista". NÃO faça a despedida você mesmo e NÃO diga que vai "pensar", "avaliar" ou "concluir" — o SISTEMA fala o encerramento (agradece e avisa do envio do vídeo) logo após a chamada. Depois disso, NÃO faça mais nenhuma pergunta nem volte a falar.
- IDIOMA E SOTAQUE: fale SEMPRE em PORTUGUÊS DO BRASIL com PRONÚNCIA BRASILEIRA NATURAL. Nunca use sotaque estrangeiro (americano/europeu) nem misture idiomas.
- Fale de forma clara, pausada e cordial. Mantenha suas falas curtas.

PERGUNTAS DA ENTREVISTA (na ordem):
${list}`;
}

// Instruções de RETOMADA: mesma base + histórico parcial; o entrevistador
// continua da 1ª pergunta ainda não respondida (sem contagem manual de turnos).
export function buildLiveResumeInstructions(params, priorTranscript) {
    const base = buildLiveInterviewInstructions(params);
    const hist = (priorTranscript || [])
        .map(t => `${t.role === "student" ? "ALUNO" : "ENTREVISTADOR"}: ${t.text}`)
        .join("\n");
    return `${base}

RETOMADA (a entrevista foi INTERROMPIDA e está sendo retomada agora):
- Dê uma saudação de reinício MUITO curta ("Certo, vamos continuar de onde paramos.") e SIGA a partir da PRIMEIRA pergunta da lista acima que AINDA NÃO foi respondida no histórico abaixo.
- NUNCA repita uma pergunta já respondida. NUNCA recomece do zero nem refaça a apresentação e as regras.
- Se TODAS as perguntas já tiverem sido respondidas no histórico, apenas agradeça e chame a ferramenta encerrar_entrevista.

HISTÓRICO ATÉ A INTERRUPÇÃO:
${hist || "(sem falas registradas)"}`;
}

const END_INTERVIEW_TOOL = {
    name: "encerrar_entrevista",
    description:
        "Encerra a entrevista. Chame IMEDIATAMENTE depois de o aluno responder à " +
        "ÚLTIMA pergunta da lista (pode agradecer em meia frase antes, ex.: " +
        "\"Obrigado pela resposta.\"). NÃO faça a despedida e NÃO anuncie que vai " +
        "pensar ou concluir — o SISTEMA fala o encerramento logo após a chamada. " +
        "Nunca chame antes de cobrir todas as perguntas. Sem parâmetros.",
};

// Despedida FIXA por TTS (requisito determinístico — mesma lição da prova
// oral: a despedida do LLM falha de três jeitos). Nunca vai ao LLM.
const FAREWELL_TTS_TEXT = "Era isso. Muito obrigado, sua entrevista está encerrada. Aguarde alguns instantes enquanto o vídeo é enviado.";

// Autentica o token e devolve o contexto da sessão, ou {error}.
async function authConnect(submissionToken) {
    const found = await db.findSubmissionByToken(String(submissionToken || "").toLowerCase());
    if (!found) return { error: "submission not found" };
    if (found.is_blocked) return { error: "blocked" };
    if (found.work_kind !== "interview" || found.work_interview_variant !== "realtime") {
        return { error: "not a realtime interview" };
    }
    if (found.work_is_active === false) return { error: "work inactive" };
    // Sem retake: entrevista concluída não pode ser refeita (exceto teste).
    if (found.completion_reason && !found.is_test) return { error: "already_done" };
    // Consentimento (voz+vídeo) verificado no SERVIDOR (mesma regra da oral).
    if (!found.consent_version) return { error: "consent_required" };
    // Preparação: o plano de perguntas nasce no upload (routes/interviewLive.js).
    const prep = await db.getLivePrep(found.id);
    const questions = prep?.plan?.questions;
    if (!Array.isArray(questions) || !questions.length) return { error: "interview not prepared" };
    // Estado para RETOMADA (só alunos REAIS; teste sempre recomeça).
    let priorTranscript = [];
    if (!found.is_test) {
        priorTranscript = (await db.getOralTranscript(found.id).catch(() => null)) || [];
    }
    return { token: found.submission_token, found, prep, priorTranscript };
}

// Monta a config do bridge genérico para UMA conexão da entrevista realtime.
async function buildBridgeConfig({ found, prep, priorTranscript }) {
    const token = found.submission_token;
    const questions = prep.plan.questions;
    const n = questions.length;
    // MESMA persona da entrevista por mensagens: override do professor ou
    // sorteio determinístico semeado pelo work_token (não "troca de nome").
    const persona = pickPersona({
        overrides: { name: found.work_interviewer_name, gender: found.work_interviewer_gender },
        seed: found.work_token,
    });
    // Agenda da persona (YAML → prosa, convenção do CLAUDE.md). Falha de parse
    // não derruba a sessão: cai na persona padrão do prompt.
    let agendaBlock = null;
    try {
        const yamlText = await db.getInterviewerYaml(found.work_id);
        if (yamlText) agendaBlock = renderInterviewerAgenda(yamlText);
    } catch (err) {
        log.error("LIVE_RELAY", `agenda render falhou submission=${token}: ${err.message}`);
    }
    // Só RETOMA se o aluno já respondeu algo (queda na abertura → recomeça a
    // intro; o plano é fixo, não há sorteio para preservar).
    const resuming = Array.isArray(priorTranscript) && priorTranscript.some(t => t.role === "student");
    const instrParams = {
        questions,
        workName: found.work_name,
        personaName: persona?.name || null,
        agendaBlock,
        expectSpontaneous: found.work_expect_spontaneous === true,
    };
    return {
        token,
        workId: found.work_id,
        submissionId: found.id,
        workRef: { is_benchmark: !!found.work_is_benchmark },
        voice: found.work_voice || "verse",
        totalQuestions: n,
        resuming,
        seedTranscript: priorTranscript,
        instructions: resuming
            ? buildLiveResumeInstructions(instrParams, priorTranscript)
            : buildLiveInterviewInstructions(instrParams),
        endTool: END_INTERVIEW_TOOL,
        minTurnsToEnd: Math.ceil(n / 2),
        farewellText: FAREWELL_TTS_TEXT,
        // Ao fechar: transcript cru (retomada + auditoria) E conversation_json no
        // formato da entrevista — é o que liga a conversa ao pipeline existente
        // de avaliação/devolutiva/notas do professor.
        onTranscript: async (finalTranscript, { cleanFinish }) => {
            await db.setOralTranscript(found.id, finalTranscript);
            // Alertas de transcrição (#137): mesma detecção da prova oral.
            await db.setOralVoice(found.id, { transcript_alerts: detectTranscriptAlerts(finalTranscript) });
            const payload = buildLiveConversationPayload({
                submissionToken: token,
                workToken: found.work_token,
                studentLabel: found.student_label,
                persona,
                transcript: finalTranscript,
                plan: prep.plan,
                analysis: prep.analysis ?? null,
                farewellText: FAREWELL_TTS_TEXT,
                cleanFinish,
                startedAt: prep.prepared_at ?? null,
            });
            await db.setConversationJson(found.id, JSON.stringify(payload, null, 2));
        },
        onVoiceSignals: (latency) => db.setOralVoice(found.id, { latency, captured_at: new Date().toISOString() }),
        // Gate de vídeo obrigatório (entrevista simplificada é câmera-on): só marca
        // 'concluída' com vídeo recebido; senão 'awaiting_video' até o POST
        // /live/video chegar. Tokens de teste isentos. Ver oralRealtime.js.
        onCleanFinish: () => db.finalizeWithVideoGate(found.id, { mandatory: !found.is_test, reason: "complete" }),
    };
}

// Anexa o relay da entrevista realtime em /s/:submissionToken/live/relay.
export function attachLiveInterviewRelay(httpServer) {
    attachRealtimeRelay(httpServer, {
        scope: "LIVE_RELAY",
        pathRegex: /^\/s\/([0-9a-f]{12})\/live\/relay$/i,
        authConnect,
        buildBridgeConfig,
    });
}
