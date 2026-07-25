// Converte o TRANSCRIPT da entrevista SIMPLIFICADA (tempo real, por voz) no
// conversation_json da entrevista — o mesmo formato que o professor lê em
// /w/.../conversation e que alimenta TODO o pipeline de avaliação existente
// (InterviewEvaluatorAgent → devolutiva → notas → publicação), sem mudanças lá.
//
// O transcript vem do relay como [{role: 'examiner'|'student', text}], em ordem
// de conversa. O pareamento em turnos é DETERMINÍSTICO: cada fala do
// entrevistador abre (ou complementa) um turno; as falas do aluno até a próxima
// fala do entrevistador viram a resposta daquele turno. Falas consecutivas do
// entrevistador sem resposta no meio são concatenadas no mesmo turno (ex.:
// checagem de áudio + repetição da pergunta).
//
// O casamento com as perguntas do PLANO (question_metadata.id) é informativo e
// CONSERVADOR (sobreposição de vocabulário): quando não há casamento claro, o
// turno fica sem id — o avaliador o trata como "pergunta espontânea". Não
// emitimos skipped_questions daqui (um casamento fuzzy errado viraria uma
// afirmação falsa para o avaliador).

// Tokens "de conteúdo" para o casamento (palavras com 4+ letras, sem acento).
function contentTokens(text) {
    return new Set(
        String(text || "")
            .toLowerCase()
            .normalize("NFD").replace(/[̀-ͯ]/g, "")
            .split(/[^a-z0-9]+/)
            .filter(w => w.length >= 4)
    );
}

// Fração dos tokens da pergunta do plano presentes na fala do entrevistador.
function overlapScore(planQuestion, spokenText) {
    const plan = contentTokens(planQuestion);
    if (plan.size === 0) return 0;
    const spoken = contentTokens(spokenText);
    let hit = 0;
    for (const t of plan) if (spoken.has(t)) hit++;
    return hit / plan.size;
}

const MATCH_THRESHOLD = 0.7;

// Pareia o transcript em turnos {question, answer} e casa com o plano.
// `farewellText` (fala fixa de encerramento do sistema) é excluída dos turnos.
export function transcriptToTurns(transcript, planQuestions, farewellText) {
    const turns = [];
    let current = null;
    for (const entry of transcript || []) {
        const text = String(entry?.text || "").trim();
        if (!text) continue;
        if (entry.role === "student") {
            if (!current) {
                // Fala do aluno antes de qualquer pergunta (raro; ruído/atraso de
                // transcrição): abre um turno sem pergunta para não perder registro.
                current = { question: "", answers: [] };
                turns.push(current);
            }
            current.answers.push(text);
        } else {
            if (text === farewellText) continue; // despedida do sistema → finalization
            if (current && current.answers.length === 0) {
                // Entrevistador falou de novo sem resposta no meio → mesma pergunta
                // (checagem de áudio, reformulação). Concatena.
                current.question = current.question ? `${current.question}\n${text}` : text;
            } else {
                current = { question: text, answers: [] };
                turns.push(current);
            }
        }
    }

    // Casamento conservador com o plano: cada pergunta do plano casa com no
    // máximo um turno (o de maior sobreposição acima do limiar).
    const plan = Array.isArray(planQuestions) ? planQuestions : [];
    const matchedTurn = new Map(); // turnIndex → plan question object
    const usedTurns = new Set();
    for (const q of plan) {
        let best = -1, bestScore = 0;
        turns.forEach((t, i) => {
            if (usedTurns.has(i)) return;
            const s = overlapScore(q.question, t.question);
            if (s > bestScore) { bestScore = s; best = i; }
        });
        if (best >= 0 && bestScore >= MATCH_THRESHOLD) {
            matchedTurn.set(best, q);
            usedTurns.add(best);
        }
    }

    return turns.map((t, index) => {
        const q = matchedTurn.get(index) || null;
        return {
            index,
            question: t.question,
            rationale: null,
            answer: t.answers.length ? t.answers.join("\n") : null,
            asked_at: null,
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
    });
}

// Payload completo no formato de buildConversationLogPayload (conversationUtils).
export function buildLiveConversationPayload({
    submissionToken, workToken, studentLabel, persona,
    transcript, plan, analysis, farewellText, cleanFinish, startedAt,
}) {
    const turns = transcriptToTurns(transcript, plan?.questions, farewellText);
    return {
        submission_token: submissionToken,
        work_token: workToken,
        student_label: studentLabel ?? null,
        interviewer_persona: persona ?? null,
        // Marcador do CANAL: o avaliador ajusta a leitura dos sinais de forma
        // (fala transcrita ao vivo ≠ texto digitado). Ver InterviewEvaluatorAgent.
        channel: "realtime_voice",
        intro: { messages: [], transitioned_at: null },
        started_at: startedAt ?? null,
        updated_at: new Date().toISOString(),
        completed: !!cleanFinish,
        document_map: analysis ?? null,
        turns,
        server_timings: [],
        skipped_questions: [],
        finalization: cleanFinish ? {
            message: farewellText,
            completion_reason: "complete",
            finalize_reason: "realtime_auto_end",
            at: new Date().toISOString(),
        } : null,
    };
}
