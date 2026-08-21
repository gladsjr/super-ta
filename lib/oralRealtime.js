// ADAPTADOR da PROVA ORAL (Realtime) sobre o motor genérico de relay
// (lib/realtimeBridge.js — bridge de áudio, VAD, vigia de silêncio, modo de
// encerramento com despedida por TTS, keep-alive, transcript ordenado,
// latência e metering). Aqui fica só o que é DA PROVA ORAL: autenticação por
// kind, sorteio das perguntas do gabarito (e sua persistência), instruções do
// examinador, retomada e a persistência específica (oral_transcript,
// oral_voice_json, no-retake).
//
// Sem legenda ao aluno (decisão de produto: é prova oral). O modelo
// fala-a-fala entende o áudio direto; a transcrição é só registro no servidor.

import * as db from "./db.js";
import log from "./logger.js";
import { attachRealtimeRelay, sampleKeepingOrder, makeLatencyTracker } from "./realtimeBridge.js";
import { detectTranscriptAlerts } from "./transcriptAlerts.js";
import { wouldResume, RESUME_BLOCKED } from "./resumeGate.js";

// Compat: helpers que nasceram aqui e hoje vivem no motor genérico.
export { sampleKeepingOrder, makeLatencyTracker };

// Instruções da sessão: persona fixa de examinador + protocolo + SÓ as
// perguntas (o gabarito nunca sai do servidor).
export function buildExamInstructions(questions, examName) {
    const list = questions.map((item, i) => {
        const q = typeof item === "string" ? { question: item } : item;
        return `${i + 1}. ${q.question}`;
    }).join("\n");
    return `Você é um EXAMINADOR conduzindo uma PROVA ORAL por voz, em português do Brasil${examName ? ` ("${examName}")` : ""}. Seu ÚNICO papel é aplicar a prova abaixo.

PROTOCOLO (siga à risca):
- Comece se apresentando em 1 frase ("Olá, vou conduzir sua prova oral.") e, NA MESMA abertura: (a) avise as REGRAS, de forma breve e cordial — para responder à prova, o aluno NÃO pode receber ajuda de celular, tablet, anotações nem de outra pessoa, e deve manter as MÃOS VISÍVEIS na câmera durante toda a prova; lembre que o vídeo fica GRAVADO e pode passar por revisão; (b) deixe claro que ele pode, A QUALQUER MOMENTO, pedir para você REPETIR a pergunta ou FALAR MAIS DEVAGAR — como faria com um examinador humano; (c) avise que a prova ENCERRA SOZINHA ao final (ele não precisa fazer nada quando terminar), mas que pode encerrar antes se precisar. Depois faça a PRIMEIRA pergunta.
- Faça UMA pergunta por vez, EXATAMENTE como listadas e na ORDEM. Espere o aluno terminar de responder antes de seguir.
- DÊ TEMPO ao aluno: ele pode pausar para pensar NO MEIO da resposta — espere ele CLARAMENTE terminar antes de falar. NUNCA o interrompa, NUNCA o apresse, não complete a fala dele nem emende a próxima pergunta em cima da resposta.
- RESPOSTA APARENTEMENTE CORTADA (pode acontecer por falha de captação do áudio, de forma intermitente): se a fala do aluno terminar de repente no meio de uma frase, numa conjunção solta ("...e", "...que", "...para"), numa enumeração sem o último item ("citou A, B e —"), ou com uma palavra que parece truncada, trate como possível PERDA DE CAPTAÇÃO — NÃO como falha do aluno — e NÃO siga em frente. Peça confirmação de forma NEUTRA e enquadrada como ÁUDIO: cite só o FINALZINHO que você captou (NÃO resuma a resposta inteira) e pergunte se veio mais depois. Ex.: "Acho que posso ter perdido um pedaço do que você falou — entendi até '…<últimas palavras que você ouviu>'. Veio mais alguma coisa depois disso?" ou "Acho que cortou o finalzinho da sua resposta — pode repetir a última parte, por favor?". REGRA DE OURO: o enquadramento é SEMPRE que VOCÊ pode ter perdido a captação; NUNCA diga que a resposta está incompleta, curta, errada ou que faltou algo NO CONTEÚDO (isso seria uma dica). Se, ao repetir, ainda vier cortado, tente no MÁXIMO mais uma vez e então siga sem insistir. Uma resposta que soa COMPLETA — mesmo que curta, ou que você ache fraca — NÃO precisa dessa confirmação: reconheça de forma neutra e siga.
- Se você simplesmente NÃO ENTENDER o que o aluno disse (fala embolada, sem relação com a pergunta), peça para repetir ou CONFIRME o que entendeu ("Só confirmando: você disse que...?").
- BARULHO DE FUNDO: se a fala do aluno chegar REPETIDAMENTE ininteligível, abafada, ou claramente dominada por ruído ambiente (conversas ao redor, TV, rua, eco), trate como problema de AMBIENTE, não de conteúdo. Diga, de forma cordial, que parece haver bastante barulho onde ele está e peça para ele ir a um lugar mais silencioso e tentar de novo. Se o barulho PERSISTIR e impedir a prova, informe que ele pode ENCERRAR agora e REFAZER a prova depois, num ambiente silencioso — a tentativa não é perdida enquanto a prova não for concluída. NUNCA conte o ruído como erro ou resposta do aluno.
- COBERTURA (só a partir do ENUNCIADO, com MUITA PARCIMÔNIA): você NÃO tem gabarito nem lista de tópicos. Só aponte que pode ter faltado algo quando a PRÓPRIA PERGUNTA deixa isso ÓBVIO — tipicamente quando ela pede um NÚMERO de itens ("cite 3 aspectos", "dê dois exemplos") e o aluno deu MENOS. Nesse caso, seja neutro e diga só o que o enunciado pede ("Você mencionou dois; a pergunta pede três. Quer acrescentar?"). Fora esse tipo de caso claríssimo, NÃO cobre complemento: reconheça de forma neutra ("Entendi.", "Prosseguindo.", "Vamos à próxima.") e siga.
- LIMITES (invioláveis): NUNCA diga qual é a resposta certa, NUNCA diga se ele acertou ou errou, NUNCA corrija, ensine ou dê dicas de conteúdo, NUNCA revele gabarito. NUNCA use reconhecimentos que soem como CORREÇÃO ("Certo", "Correto", "Isso", "Exato", "Muito bem", "Perfeito") — eles sugerem que a resposta está certa e vazam feedback no meio da prova; use SEMPRE reconhecimentos NEUTROS ("Entendi.", "Prosseguindo.", "Vamos à próxima."). Prefira PECAR POR NÃO PEDIR a incomodar quem já respondeu.
- NUNCA invente perguntas novas, NUNCA pule perguntas, NUNCA revele respostas ou gabarito.
- ENCERRAMENTO: depois da resposta à ÚLTIMA pergunta, reconheça em meia frase ("Obrigado pela resposta.") e chame IMEDIATAMENTE a ferramenta "encerrar_prova". NÃO faça a despedida você mesmo e NÃO diga que vai "pensar", "avaliar" ou "concluir" — o SISTEMA fala o encerramento (agradece e avisa do envio do vídeo) logo após a chamada. Depois disso, NÃO faça mais nenhuma pergunta nem volte a falar.
- IDIOMA E SOTAQUE: fale SEMPRE em PORTUGUÊS DO BRASIL com PRONÚNCIA BRASILEIRA NATURAL. Nunca use sotaque estrangeiro (americano/europeu) nem misture idiomas.
- Fale de forma clara, pausada e cordial. Mantenha suas falas curtas.

PERGUNTAS DA PROVA (na ordem):
${list}`;
}

// Instruções de RETOMADA: mesma base, mas o examinador recebe o HISTÓRICO parcial
// (o que já foi perguntado/respondido até a queda) e continua de onde parou, sem
// repetir nem recomeçar. Sem contagem manual de turnos — o modelo lê o histórico e
// retoma na 1ª pergunta ainda não respondida.
export function buildResumeInstructions(questions, examName, priorTranscript) {
    const base = buildExamInstructions(questions, examName);
    const hist = (priorTranscript || [])
        .map(t => `${t.role === "student" ? "ALUNO" : "EXAMINADOR"}: ${t.text}`)
        .join("\n");
    return `${base}

RETOMADA (a prova foi INTERROMPIDA e está sendo retomada agora):
- Dê uma saudação de reinício MUITO curta ("Vamos continuar de onde paramos.") e SIGA a partir da PRIMEIRA pergunta da lista acima que AINDA NÃO foi respondida no histórico abaixo.
- NUNCA repita uma pergunta já respondida. NUNCA recomece do zero nem refaça a apresentação e as regras.
- Se TODAS as perguntas já tiverem sido respondidas no histórico, apenas agradeça e chame a ferramenta encerrar_prova.

HISTÓRICO ATÉ A INTERRUPÇÃO:
${hist || "(sem falas registradas)"}`;
}

// Ferramenta que o examinador chama para ENCERRAR a prova por conta própria,
// depois da última pergunta. É o gatilho do auto-encerramento: o servidor
// traduz a chamada em fechar a sessão → o cliente finaliza e sobe o vídeo, sem
// depender de o aluno clicar em nada. A DESPEDIDA é 100% DO SISTEMA (TTS, ver
// FAREWELL_TTS_TEXT): pedir a despedida ao modelo é probabilístico — ele pode
// silenciar (traço documentado da família ao chamar ferramentas), ser cancelado
// por barge-in, ou falar o CONTEÚDO errado (observado: "deixe eu pensar um
// instante para concluir" no lugar da despedida). Sem parâmetros.
const END_EXAM_TOOL = {
    name: "encerrar_prova",
    description:
        "Encerra a prova oral. Chame IMEDIATAMENTE depois de o aluno responder à " +
        "ÚLTIMA pergunta da lista (pode agradecer em meia frase antes, ex.: " +
        "\"Obrigado pela resposta.\"). NÃO faça a despedida e NÃO anuncie que vai " +
        "pensar ou concluir — o SISTEMA fala o encerramento logo após a chamada. " +
        "Nunca chame antes de cobrir todas as perguntas. Sem parâmetros.",
};

// A despedida da prova — FIXA e falada por TTS na voz da prova, SEMPRE (não é
// fallback). Conteúdo de encerramento é requisito determinístico; não se pede
// ao modelo. NÃO é prompt: nunca vai ao LLM.
const FAREWELL_TTS_TEXT = "Era isso. Muito obrigado, sua prova está encerrada. Aguarde alguns instantes enquanto o vídeo é enviado.";

// Autentica o token de submissão e devolve {submission, work, questions} ou erro.
async function authConnect(submissionToken) {
    const found = await db.findSubmissionByToken(String(submissionToken || "").toLowerCase());
    if (!found) return { error: "submission not found" };
    if (found.is_blocked) return { error: "blocked" };
    if (found.work_kind !== "oral_realtime") return { error: "not an oral exam" };
    if (found.work_is_active === false) return { error: "work inactive" };
    // Sem retake: prova já concluída não pode ser refeita (exceto tokens de teste).
    if (found.completion_reason && !found.is_test) return { error: "already_done" };
    // Consentimento (voz+vídeo) é obrigatório e verificado no SERVIDOR — o aluno
    // precisa ter aceitado (POST /oral/consent) antes de abrir a sessão de voz.
    // Fecha o bypass de conectar direto no WebSocket pulando o termo. (#53)
    if (!found.consent_version) return { error: "consent_required" };
    const questions = await db.getOralQuestions(found.work_id);
    if (!questions.length) return { error: "exam not prepared" };
    // Estado para RETOMADA (só alunos REAIS). Se já havia um sorteio persistido
    // (prova começada antes) e transcrição parcial (houve conversa antes da queda),
    // a prova será RETOMADA em vez de recomeçada. Alunos de TESTE sempre recomeçam.
    let priorAsked = null, priorTranscript = [];
    if (!found.is_test) {
        priorAsked = await db.getOralAsked(found.id).catch(() => null);
        if (priorAsked && priorAsked.length) priorTranscript = (await db.getOralTranscript(found.id).catch(() => null)) || [];
    }
    // Retomada exige liberação do professor (#260, ADR 0005): a queda que
    // interrompeu a sessão anterior fragmentou a gravação — quem decide se o
    // aluno continua (ou se o gravado basta) é o professor. A liberação é
    // consumida AQUI, atomicamente: nova queda → novo bloqueio.
    const speechEvents = found.is_test ? 0 : await db.getStudentSpeechEvents(found.id).catch(() => 0);
    if (wouldResume({ isTest: found.is_test, priorTranscript, speechEvents })) {
        const allowed = await db.consumeResumeAllowance(found.id);
        if (!allowed) return { error: RESUME_BLOCKED };
    }
    return { token: found.submission_token, found, questions, priorAsked, priorTranscript };
}

// Monta a config do bridge genérico para UMA conexão da prova oral.
function buildBridgeConfig({ found, questions, priorAsked, priorTranscript }) {
    const token = found.submission_token;
    // RETOMADA vs recomeço. Se há sorteio anterior (aluno real que já começou),
    // REUSA o MESMO sorteio — não re-sorteia (fecha a brecha de "recomeçar do zero"
    // pescando perguntas novas). Se, além disso, houve conversa (transcrição
    // parcial), é RETOMADA: o examinador continua de onde parou. Caso contrário
    // (1ª entrada, ou aluno de teste), sorteia e começa normalmente.
    let sampled, resuming = false;
    if (priorAsked && priorAsked.length) {
        sampled = priorAsked;
        // Só RETOMA se o aluno já respondeu algo. Queda durante a apresentação
        // (só falas do examinador) → recomeça a intro, mas com o MESMO sorteio.
        resuming = Array.isArray(priorTranscript) && priorTranscript.some(t => t.role === "student");
    } else {
        const n0 = Math.min(found.work_question_count || questions.length, questions.length);
        sampled = sampleKeepingOrder(questions, n0);
        // Persiste o sorteio (a avaliação considera SÓ as perguntas feitas a este
        // aluno). Gravado na 1ª conexão; reusado nas reconexões, não reescrito.
        db.setOralAsked(found.id, sampled).catch(err => log.error("ORAL_RELAY", `setOralAsked falhou submission=${token}: ${err.message}`));
    }
    const n = sampled.length;
    return {
        token,
        workId: found.work_id,
        submissionId: found.id,
        // Benchmark de custo: roteia o WebSocket do Realtime e a despedida (TTS)
        // pela chave dedicada quando o work é de benchmark. Ver lib/openaiClient.js.
        workRef: { is_benchmark: !!found.work_is_benchmark },
        voice: found.work_voice || "verse",
        totalQuestions: n,
        resuming,
        seedTranscript: priorTranscript,
        instructions: resuming
            ? buildResumeInstructions(sampled, found.work_name, priorTranscript)
            : buildExamInstructions(sampled, found.work_name),
        endTool: END_EXAM_TOOL,
        minTurnsToEnd: Math.ceil(n / 2),
        farewellText: FAREWELL_TTS_TEXT,
        onTranscript: async (finalTranscript) => {
            await db.setOralTranscript(found.id, finalTranscript);
            // Alertas de transcrição (#137): trechos provavelmente alucinados por
            // silêncio/ruído/eco. Guarda o resumo em oral_voice_json (merge de chaves)
            // p/ o professor ver no batch/detalhe e o aluno na revisão.
            await db.setOralVoice(found.id, { transcript_alerts: detectTranscriptAlerts(finalTranscript) });
        },
        onVoiceSignals: (signals) => db.setOralVoice(found.id, { ...signals, captured_at: new Date().toISOString() }),
        // Gate de vídeo obrigatório: a prova oral é câmera-on por natureza, então
        // só marca 'concluída' com vídeo já recebido; senão fica 'awaiting_video'
        // e a promoção acontece quando o POST /oral/video chega (o vídeo sobe
        // DEPOIS do encerramento da sessão de voz). Tokens de teste ficam isentos.
        onCleanFinish: () => db.finalizeWithVideoGate(found.id, { mandatory: !found.is_test, reason: "complete" }),
    };
}

// Anexa o servidor WebSocket ao http server, tratando o upgrade na rota
// /s/:submissionToken/oral/relay.
export function attachOralRelay(httpServer) {
    attachRealtimeRelay(httpServer, {
        scope: "ORAL_RELAY",
        pathRegex: /^\/s\/([0-9a-f]{12})\/oral\/relay$/i,
        authConnect,
        buildBridgeConfig,
    });
}
