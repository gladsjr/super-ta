// MOTOR genérico de relay Realtime — o servidor fica NO MEIO da conversa.
//
// Topologia: navegador ↔ (WebSocket) ↔ NOSSO servidor ↔ (WebSocket) ↔ OpenAI.
// O navegador manda o áudio do microfone em PCM16 24kHz (frames binários) e
// recebe o áudio do agente em PCM16 24kHz (frames binários). Eventos de
// controle vão em JSON (texto). A nossa OPENAI_API_KEY nunca vai ao navegador.
//
// Extraído de lib/oralRealtime.js (prova oral) SEM mudança de comportamento,
// para servir também à entrevista SIMPLIFICADA (tempo real). O que varia por
// modalidade entra pelo objeto `cfg` que o ADAPTADOR monta após autenticar:
//   - instructions, voice, totalQuestions, resuming, seedTranscript
//   - endTool {name, description} + minTurnsToEnd (salvaguarda) + farewellText
//   - persistência: onTranscript / onVoiceSignals / onCleanFinish
//   - identidade: scope (log), workId, submissionId, token, workRef (benchmark)
// O motor cuida do resto: bridge de áudio, VAD/barge-in, vigia de silêncio,
// modo de encerramento com despedida por TTS, keep-alive, transcript em ordem
// de conversa, rastreador de latência e metering.
//
// Por que relay (e não WebRTC direto): funciona em rede corporativa (WS/443),
// permite metering autoritativo do custo (lemos response.done.usage no
// servidor) e coloca o servidor no loop para guardrails e contexto adaptativo.

import { WebSocketServer, WebSocket } from "ws";
import { REALTIME_MODEL, TTS_MODEL, STT_MODEL } from "./config.js";
import { clientForWork, apiKeyForWork } from "./openaiClient.js";
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
// tempo entre o agente terminar a pergunta e o aluno COMEÇAR a responder.
// Pausa longa seguida de resposta substancial é o clássico "foi consultar".
// É só um SINAL para revisão humana — nunca acusação. Função pura, testável.
export function makeLatencyTracker(thresholdSec = 10, minWords = 8) {
    const BYTES_PER_SEC = 48000; // áudio do agente: PCM16 mono 24kHz
    const turns = [];
    let audioBytes = 0, firstAudioAt = null; // acumulam por resposta do agente
    let examinerEndAt = null;                // quando o aluno TERMINA DE OUVIR (estimado)
    let pendingGap = null;
    return {
        // cada pedaço de áudio do agente enviado ao aluno
        examinerAudio(byteLen, t) { if (firstAudioAt == null) firstAudioAt = t; audioBytes += byteLen; },
        examinerDone() {
            // O fim da fala COMO OUVIDA pelo aluno ≈ início do áudio + duração do
            // áudio. response.done dispara quando o modelo termina de GERAR (rápido),
            // mas o aluno ainda está OUVINDO a pergunta tocar — medir do response.done
            // contava o tempo de FALA do agente (~13s) como se fosse pausa do aluno.
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

const FMT = { type: "audio/pcm", rate: 24000 };

// Vigia de silêncio (rede automática): se o áudio do aluno fica sem energia por
// tempo demais e o agente não está falando, cutucamos o modelo a checar o
// aluno. Limiares diferentes conforme a câmera (pose, Layer 2) mostre o aluno
// PRESENTE (paciência — pode estar pensando) ou AUSENTE (saiu do quadro → agir logo).
const SILENCE_POLL_MS = 3000;
// Recuperação de TRAVAMENTO: o aluno FALOU e parou, mas o VAD não fechou o turno.
// Espera generosa p/ não cortar quem só pausou no meio da resposta.
const STALL_MS = 15000;
// Checagem de SILÊNCIO: o aluno NÃO falou NADA desde a pergunta — pode estar
// pensando. PACIENTE de propósito, senão o agente "se oferece para repetir"
// no meio do raciocínio da 1ª pergunta. Presente = mais paciência; ausente = menos.
const THINK_PRESENT_MS = 45000;
const THINK_ABSENT_MS = 25000;
const ESCALATE_MS = 30000;           // ainda calado após a checagem → escala (pausa)
const VOICE_RMS = 0.02;              // energia normalizada mínima p/ contar como "voz"

// Monta a config da sessão Realtime (server-to-server). Sem legenda ao aluno.
function buildSessionConfig({ instructions, voice, endTool }) {
    return {
        type: "realtime",
        model: REALTIME_MODEL,
        instructions,
        tools: [{
            type: "function",
            name: endTool.name,
            description: endTool.description,
            parameters: { type: "object", properties: {}, required: [] },
        }],
        tool_choice: "auto",
        audio: {
            input: {
                format: FMT,
                // Redução de ruído de entrada: limpa o áudio ANTES do VAD, para
                // barulho ambiente não disparar barge-in falso (corte do agente).
                // far_field = microfone do notebook/embutido (caso comum do aluno);
                // near_field seria para headset junto à boca.
                noise_reduction: { type: "far_field" },
                // Transcrição SÓ como registro no servidor (não vai ao aluno; sem
                // legenda ao vivo). Serve para a avaliação posterior. Usa o STT do
                // config (fonte única) — a transcrição da oral/realtime estava presa
                // no gpt-4o-transcribe antigo enquanto o resto já migrou. O slot de
                // transcrição do Realtime ACEITA gpt-transcribe (doc oficial: caso
                // "transcrição após o turno commitado").
                transcription: { model: STT_MODEL },
                // semantic_vad (classificador de fim-de-turno): mais adequado
                // porque tolera PAUSAS de raciocínio no meio da resposta sem fechar o
                // turno. eagerness="low" = mais paciente. interrupt_response:
                // barge-in — o agente para quando o aluno começa a falar.
                turn_detection: { type: "semantic_vad", eagerness: "low", interrupt_response: true, create_response: true },
            },
            output: { format: FMT, voice },
        },
    };
}

// Ponte de UMA conexão do navegador com a OpenAI. `cfg` vem do adaptador:
// { scope, token, workId, submissionId, workRef, voice, instructions,
//   totalQuestions, resuming, seedTranscript, endTool {name, description},
//   minTurnsToEnd, farewellText,
//   onTranscript(finalTranscript), onVoiceSignals(summary), onCleanFinish() }
export function bridge(clientWs, cfg) {
    const SCOPE = cfg.scope;
    const token = cfg.token;
    const voice = cfg.voice || "verse";
    const workRef = cfg.workRef || {};
    const n = cfg.totalQuestions;
    const resuming = !!cfg.resuming;
    const instructions = cfg.instructions;

    const usageAcc = []; // acumula usage de cada response.done (metering)
    // RETOMADA preserva o histórico: semeamos o transcript com a parte já
    // registrada, para que o onTranscript final = anterior + continuação
    // (senão a nova sessão sobrescreveria e perderíamos o começo).
    const transcript = resuming ? [...cfg.seedTranscript] : []; // [{role,text}] p/ avaliação (não vai ao aluno)
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
    let examinerSpeaking = false; // agente gerando/falando uma resposta
    let examStarted = false;  // 1ª pergunta já foi feita (não cutuca antes disso)
    let silenceNudges = 0;    // 0=ok, 1=já checou, 2=já escalou (pausa)
    let studentPresent = true; // câmera do aluno (pose, Layer 2) — default presente
    let paused = false;       // arguição em espera — não encaminha o áudio do aluno
                              // nem cutuca. Dois motivos possíveis (pausedBy):
                              //   'capture' — a GRAVAÇÃO caiu (proctoring obrigatório);
                              //   'posture' — vigilância de posição ao vivo (#267): o
                              //     aluno saiu da posição e a página pausou até ajustar.
                              // Cada motivo só é liberado pelo seu próprio "ok" — a
                              // câmera voltar não encerra uma pausa de postura.
    let pausedBy = null;
    // Estatísticas da vigilância de posição (#267) — vão ao professor via
    // oral_voice_json (mesmo canal dos transcript_alerts).
    let nudgesState = null;   // 'ativo' | 'desligado_por_desempenho' | 'desligado_apos_queda' | 'indisponivel'
    let posturePauses = 0, posturePausedMs = 0, postureLostAt = 0;
    let examinerDoneAt = Date.now(); // fim da última fala do agente (início do turno do aluno)

    // O agente chamou a ferramenta de encerramento. Registramos o output
    // (para não deixar a function call pendente no estado da sessão) e:
    // - se veio cedo demais (menos de minTurnsToEnd falas do aluno), NÃO
    //   encerramos — mandamos o modelo continuar (salvaguarda contra
    //   encerramento precoce);
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
        if (studentTurns < cfg.minTurnsToEnd) {
            log.warn(SCOPE, `${cfg.endTool.name} cedo demais submission=${token} turns=${studentTurns}/${n} — ignorando`);
            try { oai.send(JSON.stringify({ type: "response.create" })); } catch {}
            return;
        }
        if (endRequested) return;
        endRequested = true;
        endingState = "tool_accepted";
        // Sai do regime conversacional: sem VAD não há speech_started → nem
        // cancelamento no servidor, nem flush no cliente (gate no endRequested).
        try { oai.send(JSON.stringify({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: null } } } })); } catch {}
        log.info(SCOPE, `${cfg.endTool.name} aceito submission=${token} turns=${studentTurns} — modo de encerramento (VAD off)`);
        // Rede: se o done da resposta que chamou a ferramenta não chegar, TTS.
        endingTimer = setTimeout(() => {
            if (endingState === "tool_accepted") {
                log.warn(SCOPE, `encerramento: done não chegou em 10s submission=${token} — despedida por TTS`);
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
        log.info(SCOPE, `resposta final do modelo (status=${status} audio~${(respAudioBytes / 48000).toFixed(1)}s) submission=${token} — despedida do sistema`);
        speakTtsFarewell();
    }

    // A despedida — FIXA e falada por TTS na voz da sessão, SEMPRE (não é
    // fallback). Conteúdo de encerramento é requisito determinístico executado
    // por componente determinístico: não depende do modelo e não sofre
    // cancelamento (o VAD já está desligado). NÃO é prompt: nunca vai ao LLM.
    async function speakTtsFarewell() {
        if (endingState === "done" || endingState === "tts") return;
        endingState = "tts";
        if (endingTimer) { clearTimeout(endingTimer); endingTimer = null; }
        for (const v of [voice, "verse"]) {
            try {
                const pcm = await synthesizeSpeech(clientForWork(workRef), TTS_MODEL, cfg.farewellText, v, "pcm");
                for (let i = 0; i < pcm.length; i += 48000) sendClientAudio(pcm.subarray(i, i + 48000));
                transcript.push({ role: "examiner", text: cfg.farewellText });
                log.info(SCOPE, `despedida TTS enviada (~${(pcm.length / 48000).toFixed(1)}s, voz=${v}) submission=${token} — wrapup`);
                break;
            } catch (err) {
                log.error(SCOPE, `despedida TTS falhou (voz=${v}) submission=${token}: ${err.message}`);
            }
        }
        endingState = "done";
        sendClient({ type: "wrapup" });
    }

    // Cutucada por SILÊNCIO: comita o buffer (captura uma resposta que o VAD não
    // tenha fechado) e pede uma resposta com instrução situacional — o agente
    // ou prossegue (se houve resposta) ou verifica gentilmente se está tudo bem.
    // Estágio 2 = escala para "vou pausar; recarregue p/ continuar" (→ retomada).
    function nudgeSilence(stage) {
        // Houve voz do aluno DESDE o fim da pergunta? Se sim, é provável uma resposta
        // que o VAD não fechou → comita e deixa o agente responder normalmente.
        // Se NÃO houve voz nenhuma, é silêncio REAL: não comita (não há resposta) e o
        // agente só verifica — PROIBIDO inventar fala (era a resposta-fantasma).
        const studentSpoke = lastVoiceAt > examinerDoneAt;
        if (studentSpoke) {
            // Observabilidade: este ramo era INVISÍVEL no log — dificultou diagnóstico.
            log.info(SCOPE, `vigia: voz sem fechamento de turno (última voz há ${Math.round((Date.now() - lastVoiceAt) / 1000)}s) — commit+resposta submission=${token}`);
            try { oai.send(JSON.stringify({ type: "input_audio_buffer.commit" })); } catch {}
            try { oai.send(JSON.stringify({ type: "response.create" })); }
            catch (err) { log.error(SCOPE, `nudge(spoke) submission=${token}: ${err.message}`); }
            return;
        }
        const absent = !studentPresent;
        const note = stage >= 2
            ? "SITUAÇÃO: o aluno segue EM SILÊNCIO (não falou nada) mesmo após você verificar. NÃO invente nem presuma resposta. Diga, tranquilo e BREVE, que vai PAUSAR aqui e que ele pode RECARREGAR a página quando puder para continuar de onde parou."
            : `SITUAÇÃO: faz um tempo que o aluno está calado e ainda não começou a responder${absent ? "; a câmera sugere que ele saiu do enquadramento" : ""}. Ele NÃO disse nada — NÃO presuma que ele falou, perguntou ou pediu para repetir a pergunta. De forma breve e gentil, verifique se ele CONSEGUE TE OUVIR e se está tudo bem para continuar (pode ter havido um problema de áudio ou conexão). NÃO repita a pergunta a menos que ele peça.`;
        try {
            oai.send(JSON.stringify({ type: "response.create", response: { instructions: `${instructions}\n\n[${note}]` } }));
            log.info(SCOPE, `silêncio: cutucada estágio=${stage} submission=${token} present=${studentPresent}`);
        } catch (err) { log.error(SCOPE, `nudgeSilence submission=${token}: ${err.message}`); }
    }
    const oai = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
        headers: { Authorization: `Bearer ${apiKeyForWork(workRef)}` },
    });

    const sendClient = (obj) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(obj)); };
    const sendClientAudio = (buf) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(buf, { binary: true }); };

    oai.on("open", () => {
        oaiOpen = true;
        oai.send(JSON.stringify({ type: "session.update", session: buildSessionConfig({ instructions, voice, endTool: cfg.endTool }) }));
        // o modelo não inicia sozinho: pedimos a 1ª resposta (apresentação + 1ª pergunta).
        oai.send(JSON.stringify({ type: "response.create" }));
        sendClient({ type: "status", state: "connected", total_questions: n, resuming });
        log.info(SCOPE, `bridge open submission=${token} n=${n} voice=${voice}`);
        // Keep-alive: durante silêncios/pausas não trafega nada, e proxies (ex.: o
        // dev do Replit) ceifam o WebSocket ocioso → "Conexão encerrada" no meio da
        // sessão. Mandamos um data frame ao navegador (reseta o idle-timer do proxy)
        // + ping nas duas pernas. Limpo nos dois handlers de close.
        ka = setInterval(() => {
            try { sendClient({ type: "ka" }); } catch {}
            try { if (oai.readyState === WebSocket.OPEN) oai.ping(); } catch {}
            try { clientWs.ping(); } catch {}
        }, 15000);
        // Vigia de silêncio (ver nudgeSilence). Poll leve; não cutuca enquanto o
        // agente fala, antes da 1ª pergunta, nem durante o encerramento.
        watchdog = setInterval(() => {
            if (!examStarted || examinerSpeaking || endRequested || paused) return;
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
            // áudio do agente (PCM16 base64) → repassa binário ao navegador
            case "response.output_audio.delta":
            case "response.audio.delta":
                if (m.delta) { const b = Buffer.from(m.delta, "base64"); respAudioBytes += b.length; lat.examinerAudio(b.length, Date.now()); sendClientAudio(b); }
                break;
            case "input_audio_buffer.speech_started":
                lat.studentStart(Date.now()); // início da fala do aluno → fecha o gap
                if (endRequested) break; // modo de encerramento: sem barge-in/flush no cliente
                // Observabilidade: se o agente estava falando, isto é um BARGE-IN
                // (a fala dele foi cancelada no servidor e descartada no cliente).
                if (examinerSpeaking) log.info(SCOPE, `barge-in: voz/ruído do aluno interrompeu o agente submission=${token}`);
                sendClient({ type: "status", state: "listening" });
                break;
            case "input_audio_buffer.speech_stopped":
                if (endRequested) break;
                sendClient({ type: "status", state: "thinking" }); break;
            // ORDEM DA CONVERSA: reserva o lugar da fala do aluno assim que o item
            // entra na conversa — a transcrição chega ATRASADA (assíncrona) e, sem
            // a reserva, entraria DEPOIS da resposta do agente (registro
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
            // O agente decidiu encerrar (chamou a ferramenta). O item completo
            // (com name/call_id) chega aqui — mais confiável que os eventos de args.
            case "response.output_item.done":
                if (m.item?.type === "function_call" && m.item?.name === cfg.endTool.name) handleEndTool(m.item.call_id);
                break;
            case "response.done": {
                if (m.response?.usage) usageAcc.push(m.response.usage);
                const st = m.response?.status;
                if (st && st !== "completed") log.info(SCOPE, `resposta ${st} (cancelamento/barge-in) audio~${(respAudioBytes / 48000).toFixed(1)}s submission=${token}`);
                lat.examinerDone(); // estima o fim da fala ouvida (início do áudio + duração)
                examinerSpeaking = false; examStarted = true; examinerDoneAt = Date.now(); // terminou → o silêncio conta a partir daqui
                handleEndingOnDone(m.response);
                break;
            }
            case "error":
                log.error(SCOPE, `openai error submission=${token}: ${JSON.stringify(m.error || m).slice(0, 200)}`);
                break;
        }
    });

    oai.on("close", () => { clearInterval(ka); clearInterval(watchdog); sendClient({ type: "ended" }); try { clientWs.close(); } catch {} });
    oai.on("error", (e) => { log.error(SCOPE, `openai ws error submission=${token}: ${e.message}`); try { clientWs.close(); } catch {} });

    // navegador → OpenAI
    clientWs.on("message", (data, isBinary) => {
        if (!oaiOpen) return;
        // Captura de vídeo perdida (proctoring obrigatório): não encaminha o áudio
        // do aluno — a arguição fica congelada até a câmera religar. Mensagens de
        // controle (capture_ok/bye) continuam passando (só o áudio é barrado).
        if (paused && isBinary) return;
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
            // CAPTURA de vídeo caiu/voltou (proctoring obrigatório). Diferente de
            // 'presence' (conteúdo: aluno saiu do quadro) — aqui a gravação em si
            // parou (permissão revogada, webcam desconectada). Pausa/retoma a arguição.
            else if (m.type === "capture_lost") { if (!paused) { paused = true; pausedBy = "capture"; log.info(SCOPE, `captura de vídeo perdida — arguição pausada submission=${token}`); } }
            else if (m.type === "capture_ok") { if (paused && pausedBy === "capture") { paused = false; pausedBy = null; lastVoiceAt = Date.now(); examinerDoneAt = Date.now(); log.info(SCOPE, `captura de vídeo retomada submission=${token}`); } }
            // Vigilância de posição ao vivo (#267): a PÁGINA detectou posição
            // inadequada sustentada e pausou; libera quando o aluno se ajusta.
            // A fiscalização fala pela INTERFACE, nunca pela voz do arguidor
            // (ADR 0004) — aqui só se congela/descongela o fluxo.
            else if (m.type === "posture_lost") { if (!paused) { paused = true; pausedBy = "posture"; posturePauses++; postureLostAt = Date.now(); log.info(SCOPE, `posição inadequada — arguição pausada submission=${token}`); } }
            else if (m.type === "posture_ok") { if (paused && pausedBy === "posture") { paused = false; pausedBy = null; posturePausedMs += Date.now() - postureLostAt; lastVoiceAt = Date.now(); examinerDoneAt = Date.now(); log.info(SCOPE, `posição ajustada — arguição retomada submission=${token}`); } }
            // Estado da vigilância (#267): 'ativo' | 'desligado_por_desempenho' |
            // 'desligado_apos_queda' | 'indisponivel'. Desligado NÃO é silêncio —
            // vira sinal para o professor (ADR 0018).
            else if (m.type === "nudges_state") { nudgesState = String(m.state || "").slice(0, 40) || null; }
        }
    });

    clientWs.on("close", async () => {
        clearInterval(ka); clearInterval(watchdog);
        if (endingTimer) { clearTimeout(endingTimer); endingTimer = null; }
        try { oai.close(); } catch {}
        cfg.releaseLock?.(); // libera o token p/ uma nova sessão (#52)
        // METERING (R1): grava o custo da sessão a partir do usage acumulado.
        try {
            await recordRealtimeCost({
                workId: cfg.workId,
                submissionId: cfg.submissionId,
                model: REALTIME_MODEL,
                usages: usageAcc,
            });
        } catch (err) {
            log.error(SCOPE, `metering failed submission=${token}: ${err.message}`);
        }
        // Registro da transcrição (para a avaliação posterior). Limpa: descarta
        // reservas que nunca ganharam texto (ruído/turno vazio) e remove a chave
        // interna de ordenação (_item).
        const finalTranscript = transcript.filter(t => t.text).map(({ role, text }) => ({ role, text }));
        if (finalTranscript.length > 0) {
            try { await cfg.onTranscript(finalTranscript, { cleanFinish }); }
            catch (err) { log.error(SCOPE, `onTranscript failed submission=${token}: ${err.message}`); }
        }
        // Sinalizador de voz: latência de resposta (gap pergunta→resposta) +
        // vigilância de posição (#267), quando a página a reportou.
        try {
            const signals = { latency: lat.summary() };
            if (nudgesState) {
                // Pausa aberta no fechamento (aluno saiu no meio) conta até aqui.
                if (paused && pausedBy === "posture" && postureLostAt) posturePausedMs += Date.now() - postureLostAt;
                signals.live_nudges = { state: nudgesState, pauses: posturePauses, paused_ms: posturePausedMs };
            }
            await cfg.onVoiceSignals(signals);
        } catch (err) { log.error(SCOPE, `onVoiceSignals failed submission=${token}: ${err.message}`); }
        // No-retake: marca como concluída SÓ quando o aluno ENCERROU de fato
        // (clicou "Encerrar" → bye). Fechar a aba/cair no meio NÃO consome a
        // tentativa — o aluno pode reabrir e refazer. (#54) Idempotente.
        if (cleanFinish && usageAcc.length > 0) {
            try { await cfg.onCleanFinish(); }
            catch (err) { log.error(SCOPE, `onCleanFinish failed submission=${token}: ${err.message}`); }
        }
        log.info(SCOPE, `bridge closed submission=${token} clean=${cleanFinish} responses=${usageAcc.length}`);
    });
}

// Anexa UM relay WebSocket ao http server. O adaptador define o path e como
// autenticar/configurar a sessão:
//   adapter = {
//     scope,                      // rótulo de log (ex.: "ORAL_RELAY")
//     pathRegex,                  // regex com grupo 1 = submission_token
//     authConnect(token) → {error} | auth (com auth.token = submission_token),
//     buildBridgeConfig(auth) → cfg do bridge() (sem scope/releaseLock, que
//                               este anexador injeta),
//   }
// Uma sessão por token (#52): rejeita uma 2ª conexão simultânea com o mesmo
// token ANTES de montar a config (que tem efeitos colaterais, ex.: persistir o
// sorteio). O lock é liberado quando a sessão ativa fecha.
export function attachRealtimeRelay(httpServer, adapter) {
    const wss = new WebSocketServer({ noServer: true });
    const activeSessions = new Set();
    httpServer.on("upgrade", async (req, socket, head) => {
        let pathname;
        try { pathname = new URL(req.url, "http://x").pathname; } catch { socket.destroy(); return; }
        const match = pathname.match(adapter.pathRegex);
        if (!match) return; // outras rotas de upgrade (se houver) seguem o fluxo normal
        const auth = await adapter.authConnect(match[1]);
        if (auth.error) {
            log.warn(adapter.scope, `upgrade rejeitado (${auth.error}) path=${pathname}`);
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
        }
        const tok = auth.token;
        if (activeSessions.has(tok)) {
            log.warn(adapter.scope, `upgrade rejeitado (in_use) token=${tok}`);
            socket.write("HTTP/1.1 409 Conflict\r\n\r\n"); socket.destroy(); return;
        }
        activeSessions.add(tok);
        const cfg = await adapter.buildBridgeConfig(auth);
        cfg.scope = adapter.scope;
        cfg.releaseLock = () => activeSessions.delete(tok);
        wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, cfg));
    });
    log.info("BOOT", `realtime relay (WebSocket) anexado (${adapter.scope})`);
}
