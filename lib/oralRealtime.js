// Relay da PROVA ORAL (Realtime) — o servidor fica NO MEIO da conversa.
//
// Topologia: navegador ↔ (WebSocket) ↔ NOSSO servidor ↔ (WebSocket) ↔ OpenAI.
// O navegador manda o áudio do microfone em PCM16 24kHz (frames binários) e
// recebe o áudio do examinador em PCM16 24kHz (frames binários). Eventos de
// controle vão em JSON (texto). A nossa OPENAI_API_KEY nunca vai ao navegador.
//
// Por que relay (e não WebRTC direto): funciona em rede corporativa (WS/443),
// permite metering autoritativo do custo (lemos response.done.usage no
// servidor) e coloca o servidor no loop para guardrails e contexto adaptativo.
//
// Sem transcrição (decisão de produto: é prova oral; nada de legenda). O modelo
// fala-a-fala entende o áudio direto; a transcrição não é necessária.

import { WebSocketServer, WebSocket } from "ws";
import * as db from "./db.js";
import { REALTIME_MODEL, TTS_MODEL } from "./config.js";
import { openai } from "./openaiClient.js";
import { synthesizeSpeech } from "./audio.js";
import { recordRealtimeCost } from "./billing.js";
import log from "./logger.js";

// Sorteia N itens mantendo a ordem original entre os escolhidos.
export function sampleKeepingOrder(arr, n) {
    if (n >= arr.length) return arr.slice();
    const idx = arr.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return idx.slice(0, n).sort((a, b) => a - b).map(i => arr[i]);
}

// Rastreador de LATÊNCIA de resposta (sinalizador de "cola" por voz): mede o
// tempo entre o examinador terminar a pergunta e o aluno COMEÇAR a responder.
// Pausa longa seguida de resposta substancial é o clássico "foi consultar".
// É só um SINAL para revisão humana — nunca acusação. Função pura, testável.
export function makeLatencyTracker(thresholdSec = 10, minWords = 8) {
    const BYTES_PER_SEC = 48000; // áudio do examinador: PCM16 mono 24kHz
    const turns = [];
    let audioBytes = 0, firstAudioAt = null; // acumulam por resposta do examinador
    let examinerEndAt = null;                // quando o aluno TERMINA DE OUVIR (estimado)
    let pendingGap = null;
    return {
        // cada pedaço de áudio do examinador enviado ao aluno
        examinerAudio(byteLen, t) { if (firstAudioAt == null) firstAudioAt = t; audioBytes += byteLen; },
        examinerDone() {
            // O fim da fala COMO OUVIDA pelo aluno ≈ início do áudio + duração do
            // áudio. response.done dispara quando o modelo termina de GERAR (rápido),
            // mas o aluno ainda está OUVINDO a pergunta tocar — medir do response.done
            // contava o tempo de FALA do examinador (~13s) como se fosse pausa do aluno.
            if (firstAudioAt != null) examinerEndAt = firstAudioAt + (audioBytes / BYTES_PER_SEC) * 1000;
            audioBytes = 0; firstAudioAt = null;
        },
        studentStart(t) {
            if (examinerEndAt != null && pendingGap == null) pendingGap = Math.max(0, (t - examinerEndAt) / 1000);
        },
        studentAnswer(text) {
            if (pendingGap == null) return;
            const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
            // Só registra RESPOSTAS SUBSTANCIAIS (>= minWords). Reconhecimentos
            // curtos, pedidos de repetição, "não sei" e ruído transcrito como 1-2
            // palavras NÃO são respostas — não contam como turno.
            if (words >= minWords) turns.push({ gap_sec: Math.round(pendingGap * 10) / 10, answer_words: words });
            pendingGap = null; examinerEndAt = null;
        },
        summary() {
            const flagged = turns.filter(g => g.gap_sec >= thresholdSec);
            return {
                threshold_sec: thresholdSec,
                min_words: minWords,
                turns,
                max_gap_sec: turns.length ? Math.max(...turns.map(g => g.gap_sec)) : 0,
                flagged_count: flagged.length,
                flagged,
            };
        },
    };
}

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
- COBERTURA (só a partir do ENUNCIADO, com MUITA PARCIMÔNIA): você NÃO tem gabarito nem lista de tópicos. Só aponte que pode ter faltado algo quando a PRÓPRIA PERGUNTA deixa isso ÓBVIO — tipicamente quando ela pede um NÚMERO de itens ("cite 3 aspectos", "dê dois exemplos") e o aluno deu MENOS. Nesse caso, seja neutro e diga só o que o enunciado pede ("Você mencionou dois; a pergunta pede três. Quer acrescentar?"). Fora esse tipo de caso claríssimo, NÃO cobre complemento: reconheça de forma neutra ("Entendi.", "Certo.") e siga.
- LIMITES (invioláveis): NUNCA diga qual é a resposta certa, NUNCA diga se ele acertou ou errou, NUNCA corrija, ensine ou dê dicas de conteúdo, NUNCA revele gabarito. Prefira PECAR POR NÃO PEDIR a incomodar quem já respondeu.
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
- Dê uma saudação de reinício MUITO curta ("Certo, vamos continuar de onde paramos.") e SIGA a partir da PRIMEIRA pergunta da lista acima que AINDA NÃO foi respondida no histórico abaixo.
- NUNCA repita uma pergunta já respondida. NUNCA recomece do zero nem refaça a apresentação e as regras.
- Se TODAS as perguntas já tiverem sido respondidas no histórico, apenas agradeça e chame a ferramenta encerrar_prova.

HISTÓRICO ATÉ A INTERRUPÇÃO:
${hist || "(sem falas registradas)"}`;
}

const FMT = { type: "audio/pcm", rate: 24000 };

// Vigia de silêncio (rede automática): se o áudio do aluno fica sem energia por
// tempo demais e o examinador não está falando, cutucamos o modelo a checar o
// aluno. Limiares diferentes conforme a câmera (pose, Layer 2) mostre o aluno
// PRESENTE (paciência — pode estar pensando) ou AUSENTE (saiu do quadro → agir logo).
const SILENCE_POLL_MS = 3000;
// Recuperação de TRAVAMENTO: o aluno FALOU e parou, mas o VAD não fechou o turno.
// Espera generosa p/ não cortar quem só pausou no meio da resposta.
const STALL_MS = 15000;
// Checagem de SILÊNCIO: o aluno NÃO falou NADA desde a pergunta — pode estar
// pensando. PACIENTE de propósito, senão o examinador "se oferece para repetir"
// no meio do raciocínio da 1ª pergunta. Presente = mais paciência; ausente = menos.
const THINK_PRESENT_MS = 45000;
const THINK_ABSENT_MS = 25000;
const ESCALATE_MS = 30000;           // ainda calado após a checagem → escala (pausa)
const VOICE_RMS = 0.02;              // energia normalizada mínima p/ contar como "voz"

// Ferramenta que o examinador chama para ENCERRAR a prova por conta própria,
// depois da última pergunta. É o gatilho do auto-encerramento: o servidor
// traduz a chamada em fechar a sessão → o cliente finaliza e sobe o vídeo, sem
// depender de o aluno clicar em nada. A DESPEDIDA é 100% DO SISTEMA (TTS, ver
// FAREWELL_TTS_TEXT): pedir a despedida ao modelo é probabilístico — ele pode
// silenciar (traço documentado da família ao chamar ferramentas), ser cancelado
// por barge-in, ou falar o CONTEÚDO errado (observado: "deixe eu pensar um
// instante para concluir" no lugar da despedida). Sem parâmetros.
const END_EXAM_TOOL = {
    type: "function",
    name: "encerrar_prova",
    description:
        "Encerra a prova oral. Chame IMEDIATAMENTE depois de o aluno responder à " +
        "ÚLTIMA pergunta da lista (pode agradecer em meia frase antes, ex.: " +
        "\"Obrigado pela resposta.\"). NÃO faça a despedida e NÃO anuncie que vai " +
        "pensar ou concluir — o SISTEMA fala o encerramento logo após a chamada. " +
        "Nunca chame antes de cobrir todas as perguntas. Sem parâmetros.",
    parameters: { type: "object", properties: {}, required: [] },
};

// A despedida da prova — FIXA e falada por TTS na voz da prova, SEMPRE (não é
// fallback). Conteúdo de encerramento é requisito determinístico; não se pede
// ao modelo. NÃO é prompt: nunca vai ao LLM.
const FAREWELL_TTS_TEXT = "Era isso. Muito obrigado, sua prova está encerrada. Aguarde alguns instantes enquanto o vídeo é enviado.";

// Monta a config da sessão Realtime (server-to-server). Sem transcrição.
function buildSessionConfig({ instructions, voice }) {
    return {
        type: "realtime",
        model: REALTIME_MODEL,
        instructions,
        tools: [END_EXAM_TOOL],
        tool_choice: "auto",
        audio: {
            input: {
                format: FMT,
                // Redução de ruído de entrada: limpa o áudio ANTES do VAD, para
                // barulho ambiente não disparar barge-in falso (corte do examinador).
                // far_field = microfone do notebook/embutido (caso comum do aluno);
                // near_field seria para headset junto à boca.
                noise_reduction: { type: "far_field" },
                // Transcrição SÓ como registro no servidor (não vai ao aluno; sem
                // legenda ao vivo). Serve para a avaliação comparar com o gabarito.
                transcription: { model: "gpt-4o-transcribe" },
                // semantic_vad (classificador de fim-de-turno): mais adequado à prova
                // porque tolera PAUSAS de raciocínio no meio da resposta sem fechar o
                // turno. eagerness="low" = mais paciente. (O corte da última palavra
                // observado foi no gpt-realtime-2.1; no modelo original o semantic_vad
                // se comporta bem.) interrupt_response: barge-in — o examinador para
                // quando o aluno começa a falar.
                turn_detection: { type: "semantic_vad", eagerness: "low", interrupt_response: true, create_response: true },
            },
            output: { format: FMT, voice },
        },
    };
}

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
    return { found, questions, priorAsked, priorTranscript };
}

// Sessões de prova oral ATIVAS no momento (por submission_token) — impede duas
// provas simultâneas com o mesmo token (#52). Em memória; basta nesta instância.
const activeSessions = new Set();

// Ponte de UMA conexão do navegador com a OpenAI.
function bridge(clientWs, { found, questions, priorAsked, priorTranscript }) {
    const token = found.submission_token;
    const voice = found.work_voice || "verse";
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
    const instructions = resuming
        ? buildResumeInstructions(sampled, found.work_name, priorTranscript)
        : buildExamInstructions(sampled, found.work_name);

    const usageAcc = []; // acumula usage de cada response.done (metering)
    // RETOMADA preserva o histórico: semeamos o transcript com a parte já
    // registrada, para que o setOralTranscript final = anterior + continuação
    // (senão a nova sessão sobrescreveria e perderíamos o começo da prova).
    const transcript = resuming ? [...priorTranscript] : []; // [{role,text}] p/ avaliação (não vai ao aluno)
    const lat = makeLatencyTracker(); // sinalizador: latência de resposta
    let oaiOpen = false;
    let cleanFinish = false; // só marca concluída quando o aluno ENCERRA (bye), não quando a aba cai (#54)
    let studentTurns = 0;    // falas do aluno transcritas — salvaguarda contra encerrar cedo
    let endRequested = false; // encerramento aceito → MODO DE ENCERRAMENTO (sem VAD/barge-in/flush)
    let endingState = null;   // null | 'tool_accepted' (esperando o done da resposta que chamou) | 'tts' | 'done'
    let endingTimer = null;   // rede: se o done da resposta final não chegar, despedida por TTS
    let respAudioBytes = 0;   // áudio gerado NA RESPOSTA CORRENTE (decide se a despedida foi falada)
    let ka = null;            // handle do keep-alive (ping periódico das duas pernas)
    let watchdog = null;      // vigia de silêncio (setInterval)
    let lastVoiceAt = Date.now(); // último instante com energia de voz do aluno
    let examinerSpeaking = false; // examinador gerando/falando uma resposta
    let examStarted = false;  // 1ª pergunta já foi feita (não cutuca antes disso)
    let silenceNudges = 0;    // 0=ok, 1=já checou, 2=já escalou (pausa)
    let studentPresent = true; // câmera do aluno (pose, Layer 2) — default presente
    let examinerDoneAt = Date.now(); // fim da última fala do examinador (início do turno do aluno)

    // O examinador chamou a ferramenta "encerrar_prova". Registramos o output
    // (para não deixar a function call pendente no estado da sessão) e:
    // - se veio cedo demais (menos da metade das perguntas), NÃO encerramos —
    //   mandamos o modelo continuar (salvaguarda contra encerramento precoce);
    // - caso contrário, entramos em MODO DE ENCERRAMENTO: a partir do "acabou"
    //   não há mais turnos — desligamos o VAD na sessão (nada mais cancela a
    //   despedida) e paramos de repassar "ouvindo" ao cliente (nada mais
    //   descarta o áudio dela). No done da resposta que chamou a ferramenta,
    //   o SISTEMA fala a despedida por TTS (sempre) e então manda o wrapup.
    function handleEndTool(callId) {
        try {
            oai.send(JSON.stringify({
                type: "conversation.item.create",
                item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: true }) },
            }));
        } catch {}
        if (studentTurns < Math.ceil(n / 2)) {
            log.warn("ORAL_RELAY", `encerrar_prova cedo demais submission=${token} turns=${studentTurns}/${n} — ignorando`);
            try { oai.send(JSON.stringify({ type: "response.create" })); } catch {}
            return;
        }
        if (endRequested) return;
        endRequested = true;
        endingState = "tool_accepted";
        // Sai do regime conversacional: sem VAD não há speech_started → nem
        // cancelamento no servidor, nem flush no cliente (gate no endRequested).
        try { oai.send(JSON.stringify({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: null } } } })); } catch {}
        log.info("ORAL_RELAY", `encerrar_prova aceito submission=${token} turns=${studentTurns} — modo de encerramento (VAD off)`);
        // Rede: se o done da resposta que chamou a ferramenta não chegar, TTS.
        endingTimer = setTimeout(() => {
            if (endingState === "tool_accepted") {
                log.warn("ORAL_RELAY", `encerramento: done não chegou em 10s submission=${token} — despedida por TTS`);
                speakTtsFarewell();
            }
        }, 10000);
        endingTimer.unref?.();
    }

    // No response.done da resposta que chamou a ferramenta: o eventual "obrigado"
    // do modelo já foi transmitido; agora o SISTEMA fala a despedida (TTS, sempre)
    // e só então o wrapup. Não se avalia a fala do modelo — pedir/checar despedida
    // do LLM já falhou de três jeitos (mudo, cancelada, conteúdo errado).
    function handleEndingOnDone(resp) {
        if (endingState !== "tool_accepted") return;
        const status = resp?.status || "?";
        log.info("ORAL_RELAY", `resposta final do modelo (status=${status} audio~${(respAudioBytes / 48000).toFixed(1)}s) submission=${token} — despedida do sistema`);
        speakTtsFarewell();
    }

    // A despedida da prova (voz da prova; PCM 24kHz, igual ao resto do áudio).
    // Requisito determinístico executado por componente determinístico: não
    // depende do modelo e não sofre cancelamento (o VAD já está desligado).
    async function speakTtsFarewell() {
        if (endingState === "done" || endingState === "tts") return;
        endingState = "tts";
        if (endingTimer) { clearTimeout(endingTimer); endingTimer = null; }
        for (const v of [voice, "verse"]) {
            try {
                const pcm = await synthesizeSpeech(openai, TTS_MODEL, FAREWELL_TTS_TEXT, v, "pcm");
                for (let i = 0; i < pcm.length; i += 48000) sendClientAudio(pcm.subarray(i, i + 48000));
                transcript.push({ role: "examiner", text: FAREWELL_TTS_TEXT });
                log.info("ORAL_RELAY", `despedida TTS enviada (~${(pcm.length / 48000).toFixed(1)}s, voz=${v}) submission=${token} — wrapup`);
                break;
            } catch (err) {
                log.error("ORAL_RELAY", `despedida TTS falhou (voz=${v}) submission=${token}: ${err.message}`);
            }
        }
        endingState = "done";
        sendClient({ type: "wrapup" });
    }

    // Cutucada por SILÊNCIO: comita o buffer (captura uma resposta que o VAD não
    // tenha fechado) e pede uma resposta com instrução situacional — o examinador
    // ou prossegue (se houve resposta) ou verifica gentilmente se está tudo bem.
    // Estágio 2 = escala para "vou pausar; recarregue p/ continuar" (→ retomada).
    function nudgeSilence(stage) {
        // Houve voz do aluno DESDE o fim da pergunta? Se sim, é provável uma resposta
        // que o VAD não fechou → comita e deixa o examinador responder normalmente.
        // Se NÃO houve voz nenhuma, é silêncio REAL: não comita (não há resposta) e o
        // examinador só verifica — PROIBIDO inventar fala (era a resposta-fantasma).
        const studentSpoke = lastVoiceAt > examinerDoneAt;
        if (studentSpoke) {
            // Observabilidade: este ramo era INVISÍVEL no log — dificultou diagnóstico.
            log.info("ORAL_RELAY", `vigia: voz sem fechamento de turno (última voz há ${Math.round((Date.now() - lastVoiceAt) / 1000)}s) — commit+resposta submission=${token}`);
            try { oai.send(JSON.stringify({ type: "input_audio_buffer.commit" })); } catch {}
            try { oai.send(JSON.stringify({ type: "response.create" })); }
            catch (err) { log.error("ORAL_RELAY", `nudge(spoke) submission=${token}: ${err.message}`); }
            return;
        }
        const absent = !studentPresent;
        const note = stage >= 2
            ? "SITUAÇÃO: o aluno segue EM SILÊNCIO (não falou nada) mesmo após você verificar. NÃO invente nem presuma resposta. Diga, tranquilo e BREVE, que vai PAUSAR aqui e que ele pode RECARREGAR a página quando puder para continuar de onde parou."
            : `SITUAÇÃO: faz um tempo que o aluno está calado e ainda não começou a responder${absent ? "; a câmera sugere que ele saiu do enquadramento" : ""}. Ele NÃO disse nada — NÃO presuma que ele falou, perguntou ou pediu para repetir a pergunta. De forma breve e gentil, verifique se ele CONSEGUE TE OUVIR e se está tudo bem para continuar (pode ter havido um problema de áudio ou conexão). NÃO repita a pergunta a menos que ele peça.`;
        try {
            oai.send(JSON.stringify({ type: "response.create", response: { instructions: `${instructions}\n\n[${note}]` } }));
            log.info("ORAL_RELAY", `silêncio: cutucada estágio=${stage} submission=${token} present=${studentPresent}`);
        } catch (err) { log.error("ORAL_RELAY", `nudgeSilence submission=${token}: ${err.message}`); }
    }
    const oai = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });

    const sendClient = (obj) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(obj)); };
    const sendClientAudio = (buf) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(buf, { binary: true }); };

    oai.on("open", () => {
        oaiOpen = true;
        oai.send(JSON.stringify({ type: "session.update", session: buildSessionConfig({ instructions, voice }) }));
        // o modelo não inicia sozinho: pedimos a 1ª resposta (apresentação + 1ª pergunta).
        oai.send(JSON.stringify({ type: "response.create" }));
        sendClient({ type: "status", state: "connected", total_questions: n, resuming });
        log.info("ORAL_RELAY", `bridge open submission=${token} n=${n} voice=${voice}`);
        // Keep-alive: durante silêncios/pausas não trafega nada, e proxies (ex.: o
        // dev do Replit) ceifam o WebSocket ocioso → "Conexão encerrada" no meio da
        // prova. Mandamos um data frame ao navegador (reseta o idle-timer do proxy)
        // + ping nas duas pernas. Limpo nos dois handlers de close.
        ka = setInterval(() => {
            try { sendClient({ type: "ka" }); } catch {}
            try { if (oai.readyState === WebSocket.OPEN) oai.ping(); } catch {}
            try { clientWs.ping(); } catch {}
        }, 15000);
        // Vigia de silêncio (ver nudgeSilence). Poll leve; não cutuca enquanto o
        // examinador fala, antes da 1ª pergunta, nem durante o encerramento.
        watchdog = setInterval(() => {
            if (!examStarted || examinerSpeaking || endRequested) return;
            const now = Date.now();
            if (lastVoiceAt > examinerDoneAt) {
                // Aluno FALOU e parou. Só destrava se o VAD não fechar o turno em
                // STALL_MS (generoso, p/ não cortar quem pausou no meio da resposta).
                if (now - lastVoiceAt > STALL_MS) nudgeSilence(0);
            } else {
                // Aluno NÃO falou NADA desde a pergunta (pode estar pensando na 1ª):
                // muito PACIENTE, para não se oferecer para repetir no meio do raciocínio.
                const quiet = now - examinerDoneAt;
                const t = studentPresent ? THINK_PRESENT_MS : THINK_ABSENT_MS;
                if (silenceNudges === 0 && quiet > t) { silenceNudges = 1; nudgeSilence(1); }
                else if (silenceNudges === 1 && quiet > t + ESCALATE_MS) { silenceNudges = 2; nudgeSilence(2); }
            }
        }, SILENCE_POLL_MS);
        watchdog.unref?.();
    });

    oai.on("message", (data, isBinary) => {
        if (isBinary) return; // a OpenAI manda áudio como base64 em JSON, não binário
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        switch (m.type) {
            // áudio do examinador (PCM16 base64) → repassa binário ao navegador
            case "response.output_audio.delta":
            case "response.audio.delta":
                if (m.delta) { const b = Buffer.from(m.delta, "base64"); respAudioBytes += b.length; lat.examinerAudio(b.length, Date.now()); sendClientAudio(b); }
                break;
            case "input_audio_buffer.speech_started":
                lat.studentStart(Date.now()); // início da fala do aluno → fecha o gap
                if (endRequested) break; // modo de encerramento: sem barge-in/flush no cliente
                // Observabilidade: se o examinador estava falando, isto é um BARGE-IN
                // (a fala dele foi cancelada no servidor e descartada no cliente).
                if (examinerSpeaking) log.info("ORAL_RELAY", `barge-in: voz/ruído do aluno interrompeu o examinador submission=${token}`);
                sendClient({ type: "status", state: "listening" });
                break;
            case "input_audio_buffer.speech_stopped":
                if (endRequested) break;
                sendClient({ type: "status", state: "thinking" }); break;
            // ORDEM DA CONVERSA: reserva o lugar da fala do aluno assim que o item
            // entra na conversa — a transcrição chega ATRASADA (assíncrona) e, sem
            // a reserva, entraria DEPOIS da resposta do examinador (registro
            // embaralhado, que já confundiu o diagnóstico do fim mudo).
            case "conversation.item.added":
            case "conversation.item.created":
                if (m.item?.type === "message" && m.item?.role === "user" && m.item?.id
                    && !transcript.some(t => t._item === m.item.id)) {
                    transcript.push({ role: "student", text: "", _item: m.item.id });
                }
                break;
            // Registro da transcrição (server-side, não vai ao aluno).
            case "response.output_audio_transcript.done":
            case "response.audio_transcript.done":
                if (m.transcript) transcript.push({ role: "examiner", text: m.transcript });
                break;
            case "conversation.item.input_audio_transcription.completed":
                if (m.transcript) {
                    const slot = m.item_id ? transcript.find(t => t._item === m.item_id) : null;
                    if (slot) { slot.text = m.transcript; delete slot._item; }
                    else transcript.push({ role: "student", text: m.transcript });
                    lat.studentAnswer(m.transcript); studentTurns++; silenceNudges = 0;
                }
                break;
            case "response.created":
                examinerSpeaking = true; respAudioBytes = 0; break; // nova resposta → zera o contador de áudio
            // O examinador decidiu encerrar (chamou a ferramenta). O item completo
            // (com name/call_id) chega aqui — mais confiável que os eventos de args.
            case "response.output_item.done":
                if (m.item?.type === "function_call" && m.item?.name === "encerrar_prova") handleEndTool(m.item.call_id);
                break;
            case "response.done": {
                if (m.response?.usage) usageAcc.push(m.response.usage);
                const st = m.response?.status;
                if (st && st !== "completed") log.info("ORAL_RELAY", `resposta ${st} (cancelamento/barge-in) audio~${(respAudioBytes / 48000).toFixed(1)}s submission=${token}`);
                lat.examinerDone(); // estima o fim da fala ouvida (início do áudio + duração)
                examinerSpeaking = false; examStarted = true; examinerDoneAt = Date.now(); // terminou → o silêncio conta a partir daqui
                handleEndingOnDone(m.response);
                break;
            }
            case "error":
                log.error("ORAL_RELAY", `openai error submission=${token}: ${JSON.stringify(m.error || m).slice(0, 200)}`);
                break;
        }
    });

    oai.on("close", () => { clearInterval(ka); clearInterval(watchdog); sendClient({ type: "ended" }); try { clientWs.close(); } catch {} });
    oai.on("error", (e) => { log.error("ORAL_RELAY", `openai ws error submission=${token}: ${e.message}`); try { clientWs.close(); } catch {} });

    // navegador → OpenAI
    clientWs.on("message", (data, isBinary) => {
        if (!oaiOpen) return;
        if (isBinary) {
            // Energia do frame (RMS normalizado) → marca "última voz" p/ o vigia de
            // silêncio. Barato: um laço sobre o PCM16. Silêncio/ruído baixo não conta.
            let sum = 0; const nS = data.length >> 1;
            for (let i = 0; i < nS; i++) { const s = data.readInt16LE(i << 1); sum += s * s; }
            if (nS && Math.sqrt(sum / nS) / 32768 > VOICE_RMS) lastVoiceAt = Date.now();
            // frame de áudio do microfone (PCM16 24kHz) → append base64
            oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.from(data).toString("base64") }));
        } else {
            // controle JSON do cliente (ex.: {type:'bye'})
            let m; try { m = JSON.parse(data.toString()); } catch { return; }
            if (m.type === "bye") { cleanFinish = true; try { oai.close(); } catch {} }
            else if (m.type === "presence") { studentPresent = !!m.present; } // câmera (pose) do aluno — Layer 2
        }
    });

    clientWs.on("close", async () => {
        clearInterval(ka); clearInterval(watchdog);
        if (endingTimer) { clearTimeout(endingTimer); endingTimer = null; }
        try { oai.close(); } catch {}
        activeSessions.delete(token); // libera o token p/ uma nova sessão (#52)
        // METERING (R1): grava o custo da sessão a partir do usage acumulado.
        try {
            await recordRealtimeCost({
                workId: found.work_id,
                submissionId: found.id,
                model: REALTIME_MODEL,
                usages: usageAcc,
            });
        } catch (err) {
            log.error("ORAL_RELAY", `metering failed submission=${token}: ${err.message}`);
        }
        // Registro da transcrição (para a avaliação comparar com o gabarito).
        // Limpa: descarta reservas que nunca ganharam texto (ruído/turno vazio)
        // e remove a chave interna de ordenação (_item).
        const finalTranscript = transcript.filter(t => t.text).map(({ role, text }) => ({ role, text }));
        if (finalTranscript.length > 0) {
            try { await db.setOralTranscript(found.id, finalTranscript); }
            catch (err) { log.error("ORAL_RELAY", `setTranscript failed submission=${token}: ${err.message}`); }
        }
        // Sinalizador de voz: latência de resposta (gap pergunta→resposta).
        try {
            await db.setOralVoice(found.id, { latency: lat.summary(), captured_at: new Date().toISOString() });
        } catch (err) { log.error("ORAL_RELAY", `setVoice failed submission=${token}: ${err.message}`); }
        // No-retake: marca como concluída SÓ quando o aluno ENCERROU de fato
        // (clicou "Encerrar" → bye). Fechar a aba/cair no meio NÃO consome a
        // tentativa — o aluno pode reabrir e refazer. (#54) Idempotente.
        if (cleanFinish && usageAcc.length > 0) {
            try { await db.markOralExamCompleted(found.id); }
            catch (err) { log.error("ORAL_RELAY", `markCompleted failed submission=${token}: ${err.message}`); }
        }
        log.info("ORAL_RELAY", `bridge closed submission=${token} clean=${cleanFinish} responses=${usageAcc.length}`);
    });
}

// Anexa o servidor WebSocket ao http server, tratando o upgrade na rota
// /s/:submissionToken/oral/relay.
export function attachOralRelay(httpServer) {
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", async (req, socket, head) => {
        let pathname;
        try { pathname = new URL(req.url, "http://x").pathname; } catch { socket.destroy(); return; }
        const match = pathname.match(/^\/s\/([0-9a-f]{12})\/oral\/relay$/i);
        if (!match) return; // outras rotas de upgrade (se houver) seguem o fluxo normal
        const auth = await authConnect(match[1]);
        if (auth.error) {
            log.warn("ORAL_RELAY", `upgrade rejeitado (${auth.error}) path=${pathname}`);
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
        }
        // Uma sessão por token (#52): rejeita uma 2ª conexão simultânea com o
        // mesmo token. O lock é liberado quando a sessão ativa fecha.
        const tok = auth.found.submission_token;
        if (activeSessions.has(tok)) {
            log.warn("ORAL_RELAY", `upgrade rejeitado (in_use) token=${tok}`);
            socket.write("HTTP/1.1 409 Conflict\r\n\r\n"); socket.destroy(); return;
        }
        activeSessions.add(tok);
        wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, auth));
    });
    log.info("BOOT", "oral relay (WebSocket) anexado em /s/:token/oral/relay");
}
