// Driver de entrevista para o teste A/B — chama o SuperOrchestratorAgent
// DIRETAMENTE (sem servidor HTTP, sem Postgres), espelhando a semântica do
// despachante de routes/interview.js (push pra Conversations API antes da
// chamada, tratamento por action.kind, guardrails de turno).
//
// Modos:
//  - Entrevista completa independente: o `orchestratorModel` conduz a sua
//    própria conversa contra o aluno simulado.
//  - Counterfactual pareado (opcional via `counterfactual`): a CADA turno,
//    ANTES da chamada que de fato conduz a conversa, avaliamos o OUTRO modelo
//    no MESMO estado congelado (mesma history, mesmo turnLog, mesma memory),
//    numa conversa-sombra efêmera. Isso dá comparação pareada de qualidade da
//    próxima pergunta/follow-up sob contexto idêntico.

import { SuperOrchestratorAgent } from "../../agents/SuperOrchestratorAgent.js";
import { openai } from "../../lib/openaiClient.js";

// Heurística (copiada dos harnesses de texto existentes): a fala da
// entrevistadora está exigindo um número recalculado ao vivo? Viola o
// "princípio da resposta formulável de cabeça".
function looksLikeRecomputeDemand(text) {
    const t = String(text || "").toLowerCase();
    return /(de quanto|quanto (cai|sobe|muda|fica|seria|passa|ganha|perde|tira)|qual (o |a )?(vpl|tir|valor)|recalcul|me d[áa] o n[úu]mero|valor exato|n[úu]mero exato|em quanto|chega a quanto|d[áa] quanto)/.test(t);
}

// Constrói um turno a partir de uma pergunta do plano (espelha
// lib/conversationUtils.js#turnFromPlanQuestion — reimplementado aqui para não
// puxar conversationUtils -> db.js/Postgres).
function turnFromPlanQuestion(index, q) {
    return {
        index,
        question: q?.question ?? "",
        answer: null,
        asked_at: new Date().toISOString(),
        answered_at: null,
        question_metadata: {
            id: q?.id ?? null,
            objectives: q?.objectives ?? [],
            concerns: q?.concerns ?? [],
            decision_criteria: q?.decision_criteria ?? [],
            information_needs: q?.information_needs ?? [],
            evaluation_mode: q?.evaluation_mode ?? [],
        },
    };
}

// Aluno simulado. Modelo fixo (não instrumentado — não conta no custo do
// orquestrador). Responde só à última fala da entrevistadora.
async function studentReply(studentModel, persona, transcript, question) {
    const convo = transcript
        .map((h) => `${h.role === "interviewer" ? "Entrevistadora" : "Aluno"}: ${h.text}`)
        .join("\n");
    const input =
        (convo ? `Conversa ate agora:\n${convo}\n\n` : "") +
        `Ultima fala da entrevistadora (responda so a isto, 1 a 4 frases):\n${question}`;
    const res = await openai.responses.create({ model: studentModel, instructions: persona.system, input });
    const text = (res.output_text || "").trim();
    return text || "(sem resposta)";
}

function simplifyAction(parsed) {
    const a = parsed.action;
    return {
        kind: a.kind,
        message: a.message,
        follow_up_reason: a.follow_up_reason ?? null,
        finalize_reason: a.finalize_reason ?? null,
        plan_question_id: a.plan_question_id ?? null,
        hint: a.hint ?? null,
        rationale: parsed.rationale,
    };
}

// Avalia o modelo counterfactual no estado congelado, numa conversa-sombra
// efêmera semeada com a history atual (= mesmo conteúdo do convId principal).
async function runCounterfactual({ cf, convMirror, sharedInputs, turnLog, memory, studentMessage }) {
    let shadowId = null;
    try {
        const shadow = await openai.conversations.create({});
        shadowId = shadow.id;
        if (convMirror.length) {
            await openai.conversations.items.create(shadowId, {
                items: convMirror.map((m) => ({ role: m.role, content: m.content })),
            });
        }
        const cfAgent = new SuperOrchestratorAgent(cf.client, cf.model);
        const parsed = await cfAgent.evaluate({
            ...sharedInputs,
            memory,
            turnLog,
            studentMessage,
            conversationId: shadowId,
        });
        return simplifyAction(parsed);
    } catch (err) {
        return { kind: "error", message: String(err.message), rationale: "counterfactual falhou" };
    } finally {
        if (shadowId) { try { await openai.conversations.delete(shadowId); } catch { /* best-effort */ } }
    }
}

// Roda UMA entrevista. Retorna { transcript, turnLog, finalizeReason, phase,
//   counterfactualSamples, recomputeFlags, asks, followUps, askRepeats }.
export async function runInterview({
    label,
    orchestratorModel,
    orchestratorClient,
    studentModel,
    persona,
    interviewerYaml,
    analysis,
    plan,
    vectorStoreId,
    questionCount,
    maxStudentTurns = 24,
    counterfactual = null, // { model, client } | null
}) {
    const agent = new SuperOrchestratorAgent(orchestratorClient, orchestratorModel);
    const minTurns = Math.ceil(questionCount / 2);
    const maxTurns = questionCount * 3;

    const conv = await openai.conversations.create({});
    const convId = conv.id;

    const convMirror = []; // espelho local de convId (mesmos {role,content})
    const turnLog = [];
    const transcript = []; // { role: "interviewer"|"student", text, kind? }
    const counterfactualSamples = [];
    const recomputeFlags = [];
    let memory = null;
    let phase = "interviewing";
    let finalizeReason = null;
    let asks = 0, followUps = 0, askRepeats = 0, metaModals = 0, hints = 0;

    // Inputs estáveis (iguais pro braço e pro counterfactual).
    const sharedInputs = {
        interviewerYamlText: interviewerYaml,
        workAnalysis: analysis,
        interviewPlan: plan,
        vectorStoreId,
        studentName: persona.name,
        studentGenderHint: null,
        interactionMode: "text",
        meterCtx: { workId: null },
        minTurnsBeforeFinalize: minTurns,
        maxTurns,
    };

    const pushToConv = async (role, content) => {
        convMirror.push({ role, content });
        await openai.conversations.items.create(convId, { items: [{ role, content }] });
    };

    let studentMessage = persona.opening || "Oi, pode comecar.";

    for (let t = 1; t <= maxStudentTurns; t++) {
        const turnsAnswered = turnLog.filter((x) => x.answered_at).length;

        // Guardrail 1: cap duro -> finalize forçado (espelha o despachante).
        if (turnsAnswered >= maxTurns) {
            const forced = "Obrigado, acho que ja temos material suficiente para encerrar.";
            await pushToConv("user", studentMessage);
            const open = turnLog.length ? turnLog[turnLog.length - 1] : null;
            if (open && open.answer == null) { open.answer = studentMessage; open.answered_at = new Date().toISOString(); }
            await pushToConv("assistant", forced);
            transcript.push({ role: "student", text: studentMessage });
            transcript.push({ role: "interviewer", text: forced, kind: "finalize" });
            phase = "finalizing"; finalizeReason = "max_turns";
            break;
        }

        // Push da fala do aluno ANTES da chamada (o agente lê history via
        // Conversations API).
        await pushToConv("user", studentMessage);
        transcript.push({ role: "student", text: studentMessage });

        // Counterfactual: avalia o OUTRO modelo no mesmo estado congelado.
        let cfSample = null;
        if (counterfactual) {
            cfSample = {
                turnIndex: t,
                persona: persona.name,
                studentMessage,
                contextTail: transcript.slice(-7),
                counterfactualAction: await runCounterfactual({
                    cf: counterfactual, convMirror, sharedInputs, turnLog, memory, studentMessage,
                }),
                driverAction: null, // preenchido após a chamada do braço condutor
            };
        }

        // Chamada do braço que conduz a conversa.
        let parsed;
        try {
            parsed = await agent.evaluate({ ...sharedInputs, memory, turnLog, studentMessage, conversationId: convId });
        } catch (err) {
            parsed = {
                rationale: `fallback: ${err.message}`,
                action: { kind: "ask_repeat", message: "Desculpa, tive um problema aqui. Pode repetir a sua ultima resposta?" },
                memory,
            };
        }
        if (parsed.memory && typeof parsed.memory === "object") memory = parsed.memory;

        // Guardrail 2: bloqueio de finalize precoce.
        if (parsed.action.kind === "finalize" && turnsAnswered < minTurns && parsed.action.finalize_reason !== "student_disengaged") {
            parsed.action = { kind: "ask_repeat", message: "Vamos seguir um pouco mais — pode detalhar a sua ultima resposta?" };
        }

        const kind = parsed.action.kind;
        const assistantMessage = parsed.action.message;
        if (cfSample) { cfSample.driverAction = simplifyAction(parsed); counterfactualSamples.push(cfSample); }
        if (looksLikeRecomputeDemand(assistantMessage)) recomputeFlags.push({ turn: t, kind, text: assistantMessage });

        const currentTurn = turnLog.length ? turnLog[turnLog.length - 1] : null;

        // ===== Despacha por kind =====
        if (kind === "meta_modal") {
            // Meta NÃO entra em conv_chat. O despachante reverte o push local do
            // user; no remoto fica. Para manter o espelho fiel ao convId (que
            // mantém o user), NÃO removemos do convMirror. Personas sintéticas
            // não disparam meta — tratamos minimamente.
            metaModals++;
            transcript.push({ role: "interviewer", text: assistantMessage, kind: "meta_modal" });
            studentMessage = await studentReply(studentModel, persona, transcript, assistantMessage);
            continue;
        }

        if (kind === "follow_up" || kind === "ask_repeat" || kind === "hint") {
            if (kind === "follow_up") followUps++;
            else if (kind === "ask_repeat") askRepeats++;
            else hints++;
            await pushToConv("assistant", assistantMessage);
            transcript.push({ role: "interviewer", text: assistantMessage, kind, follow_up_reason: parsed.action.follow_up_reason ?? null });
            if (currentTurn) {
                if (!Array.isArray(currentTurn.interventions)) currentTurn.interventions = [];
                currentTurn.interventions.push({ type: kind, follow_up_reason: parsed.action.follow_up_reason ?? null });
            }
            studentMessage = await studentReply(studentModel, persona, transcript, assistantMessage);
            continue;
        }

        if (kind === "ask") {
            asks++;
            if (currentTurn && currentTurn.answer == null) {
                currentTurn.answer = studentMessage;
                currentTurn.answered_at = new Date().toISOString();
            }
            const planQId = parsed.action.plan_question_id ?? null;
            const planQuestion = planQId != null ? (plan?.questions ?? []).find((q) => q.id === planQId) : null;
            const nextTurn = planQuestion
                ? turnFromPlanQuestion(turnLog.length, planQuestion)
                : {
                    index: turnLog.length, question: assistantMessage, answer: null,
                    asked_at: new Date().toISOString(), answered_at: null,
                    question_metadata: {
                        id: null, spontaneous: true, revisit_topic: parsed.action.revisit_topic ?? null,
                        objectives: parsed.action.objectives ?? [], concerns: parsed.action.concerns ?? [],
                        decision_criteria: parsed.action.decision_criteria ?? [],
                        information_needs: parsed.action.information_needs ?? [],
                        evaluation_mode: parsed.action.evaluation_mode ?? [],
                    },
                };
            nextTurn.question = assistantMessage;
            turnLog.push(nextTurn);
            await pushToConv("assistant", assistantMessage);
            transcript.push({ role: "interviewer", text: assistantMessage, kind: "ask", plan_question_id: planQId });
            studentMessage = await studentReply(studentModel, persona, transcript, assistantMessage);
            continue;
        }

        if (kind === "finalize") {
            if (currentTurn && currentTurn.answer == null) {
                currentTurn.answer = studentMessage;
                currentTurn.answered_at = new Date().toISOString();
            }
            phase = "finalizing"; finalizeReason = parsed.action.finalize_reason ?? null;
            await pushToConv("assistant", assistantMessage);
            transcript.push({ role: "interviewer", text: assistantMessage, kind: "finalize", finalize_reason: finalizeReason });
            break;
        }

        // kind inesperado — defensivo
        await pushToConv("assistant", assistantMessage);
        transcript.push({ role: "interviewer", text: assistantMessage, kind: `unknown:${kind}` });
        studentMessage = await studentReply(studentModel, persona, transcript, assistantMessage);
    }

    // Limpeza best-effort da conversa principal.
    try { await openai.conversations.delete(convId); } catch { /* ignore */ }

    return {
        label,
        persona: persona.name,
        orchestratorModel,
        transcript,
        turnLog,
        phase,
        finalizeReason,
        counterfactualSamples,
        recomputeFlags,
        counts: { asks, followUps, askRepeats, metaModals, hints, interviewerTurns: transcript.filter((h) => h.role === "interviewer").length },
    };
}
