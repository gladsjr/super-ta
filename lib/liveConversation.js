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

// Melhor pergunta do plano AINDA NÃO USADA para uma fala do entrevistador.
// Devolve null se nada alcança o limiar (fala conversacional, não pergunta).
function casarComPlano(spokenText, plan, usadas) {
    let best = null, bestScore = 0;
    plan.forEach((q, i) => {
        if (usadas.has(i)) return;
        const s = overlapScore(q.question, spokenText);
        if (s > bestScore) { bestScore = s; best = { idx: i, q }; }
    });
    return bestScore >= MATCH_THRESHOLD ? best : null;
}

// Segmentação LEGADA (usada só como rede de segurança): toda fala do entrevistador
// que vem depois de uma fala do aluno abre um turno. Infla a contagem — era este o
// problema da #252 —, mas nunca perde fala; serve de fallback quando o casamento
// com o plano não encontra NADA (plano muito parafraseado, transcrição ruim).
function segmentarPorFala(transcript, farewellText) {
    const turns = [];
    let current = null;
    for (const entry of transcript || []) {
        const text = String(entry?.text || "").trim();
        if (!text) continue;
        if (entry.role === "student") {
            if (!current) { current = { question: "", answers: [], interventions: [], plan: null }; turns.push(current); }
            current.answers.push(text);
        } else {
            if (text === farewellText) continue;
            if (current && current.answers.length === 0) {
                current.question = current.question ? `${current.question}\n${text}` : text;
            } else {
                current = { question: text, answers: [], interventions: [], plan: null };
                turns.push(current);
            }
        }
    }
    return turns;
}

// Segmentação por PLANO (#252): turno = pergunta do plano. As demais falas do
// entrevistador (confirmações, pontes, pedidos de complemento) viram INTERVENÇÕES
// do turno corrente — mesma semântica da entrevista por mensagem, onde esse
// comportamento sempre foi intervenção dentro do turno e nunca turno novo.
//
// Antes, cada "entendi, certo" abria um turno: 14 turnos para 5 perguntas num caso
// real, e o avaliador comentava ponte de transição como se fosse questão avaliável.
function segmentarPorPlano(transcript, plan, farewellText) {
    const turns = [];
    const usadas = new Set();
    let current = null;   // turno corrente
    let openIv = null;    // intervenção aguardando a resposta do aluno

    const abrirTurno = (question, planQ) => {
        current = { question, answers: [], interventions: [], plan: planQ };
        turns.push(current);
        openIv = null;
    };

    for (const entry of transcript || []) {
        const text = String(entry?.text || "").trim();
        if (!text) continue;

        if (entry.role === "student") {
            // Fala do aluno antes de qualquer pergunta (ruído/atraso de transcrição):
            // abre turno sem pergunta para não perder registro.
            if (!current) abrirTurno("", null);
            if (openIv) openIv.student_message = openIv.student_message ? `${openIv.student_message}\n${text}` : text;
            else current.answers.push(text);
            continue;
        }

        if (text === farewellText) continue; // despedida do sistema → finalization

        const m = casarComPlano(text, plan, usadas);
        if (m) { usadas.add(m.idx); abrirTurno(text, m.q); continue; }
        if (!current) { abrirTurno(text, null); continue; } // nada casou ainda

        if (openIv && !openIv.student_message) {
            // Entrevistador emendou outra fala sem resposta no meio: complementa.
            openIv.assistant_response = `${openIv.assistant_response}\n${text}`;
        } else if (!current.answers.length && !current.interventions.length) {
            // Ainda ninguém respondeu nada neste turno → é reformulação da pergunta.
            current.question = current.question ? `${current.question}\n${text}` : text;
        } else {
            openIv = {
                type: "live_exchange", // conversa da via por voz (não é follow_up decidido por orquestrador)
                channel: "voice",
                assistant_response: text,
                student_message: null,
                rationale: null,
                at: null,
            };
            current.interventions.push(openIv);
        }
    }
    return turns;
}

// Pareia o transcript em turnos {question, answer, interventions} e casa com o plano.
// `farewellText` (fala fixa de encerramento do sistema) é excluída dos turnos.
export function transcriptToTurns(transcript, planQuestions, farewellText) {
    const plan = Array.isArray(planQuestions) ? planQuestions : [];
    let turns = plan.length ? segmentarPorPlano(transcript, plan, farewellText) : [];
    // Rede de segurança: se o casamento não achou NENHUMA pergunta do plano, a
    // segmentação por plano degenera num turno só com tudo dentro. Cai para a
    // segmentação por fala — infla, mas preserva a estrutura da conversa.
    if (!turns.some(t => t.plan)) turns = segmentarPorFala(transcript, farewellText);

    return turns.map((t, index) => {
        const q = t.plan || null;
        return {
            index,
            question: t.question,
            rationale: null,
            answer: t.answers.length ? t.answers.join("\n") : null,
            asked_at: null,
            answered_at: null,
            interventions: t.interventions || [],
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
