// Trabalhos/config (works). Parte do split de lib/db.js (ver lib/db.js, que é o
// barrel que re-exporta tudo). SQL e lógica preservados verbatim do módulo
// monolítico original.

import { pool } from "../../auth.js";
import { newToken, STATUS_EXPR, appendSectionSets } from "./_shared.js";

// ---------------------------------------------------------------------
// Works
// ---------------------------------------------------------------------

export async function listWorks() {
    const r = await pool.query(`
      SELECT
        w.id,
        w.work_token,
        w.name,
        w.is_active,
        w.kind,
        w.enunciado_pdf IS NOT NULL AS assignment_pdf,
        w.budget_usd::float8 AS budget_usd,
        w.spent_usd::float8  AS spent_usd,
        COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND ${STATUS_EXPR} = 'pending'     THEN 1 ELSE 0 END), 0)::int AS pending,
        COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND ${STATUS_EXPR} = 'in_progress' THEN 1 ELSE 0 END), 0)::int AS in_progress,
        COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND ${STATUS_EXPR} = 'completed'   THEN 1 ELSE 0 END), 0)::int AS completed,
        COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND ${STATUS_EXPR} = 'gave_up'     THEN 1 ELSE 0 END), 0)::int AS gave_up
      FROM works w
      LEFT JOIN submissions s ON s.work_id = w.id
      GROUP BY w.id
      ORDER BY w.created_at DESC, w.id DESC
    `);
    return r.rows;
}

export async function setWorkActive(workId, isActive) {
    const r = await pool.query(
        `UPDATE works
         SET is_active = $1, updated_at = now()
         WHERE id = $2
         RETURNING is_active`,
        [!!isActive, workId]
    );
    return r.rowCount > 0 ? r.rows[0].is_active : null;
}

// Apaga o trabalho e tudo encadeado: submissions e work_cost_events caem por
// ON DELETE CASCADE (ver migrations 001 e 003). Operação irreversível — a UI
// deve confirmar antes.
// client opcional (default pool): participa da transação do caller — a devolução
// de cota e este delete precisam ser atômicos (issue #145).
export async function deleteWork(workId, client = pool) {
    const r = await client.query("DELETE FROM works WHERE id = $1", [workId]);
    return r.rowCount > 0;
}

export async function createWork(name, budgetUsd, kind = "interview", opts = {}) {
    if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd < 0) {
        throw new Error("createWork: budgetUsd must be a non-negative finite number");
    }
    if (kind !== "interview" && kind !== "oral_realtime" && kind !== "scenario") {
        throw new Error(`createWork: invalid kind "${kind}"`);
    }
    // Benchmark de custo (ortogonal a kind): as chamadas OpenAI do work usam a
    // chave dedicada; benchmarkRunId agrupa vários works de um mesmo run.
    const isBenchmark = opts.isBenchmark === true;
    const benchmarkRunId = isBenchmark ? (opts.benchmarkRunId || null) : null;
    // Linkagem institucional OPCIONAL (aditiva). Ausente = trabalho token-only,
    // comportamento de hoje. unit_id/owner_user_id são nullable no schema.
    const unitId = opts.unitId ?? null;
    const ownerUserId = opts.ownerUserId ?? null;
    const source = opts.source || "manual";
    const token = newToken();
    const r = await pool.query(
        `INSERT INTO works (work_token, name, budget_usd, kind, is_benchmark, benchmark_run_id, unit_id, owner_user_id, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, work_token, name, kind, budget_usd::float8 AS budget_usd, spent_usd::float8 AS spent_usd, is_benchmark, benchmark_run_id, unit_id, owner_user_id`,
        [token, name, budgetUsd, kind, isBenchmark, benchmarkRunId, unitId, ownerUserId, source]
    );
    const work = r.rows[0];
    // Entrevista nasce SEMPRE por voz (áudio) com fiscalização por vídeo — ambos
    // FIXOS (o professor não configura mais isso). Prova oral e cenário mantêm seus
    // próprios defaults. Feito por UPDATE pós-insert p/ não tocar o default das outras.
    if (kind === "interview") {
        await pool.query(
            "UPDATE works SET interaction_mode = 'audio', proctoring_enabled = true WHERE id = $1",
            [work.id]
        );
    }
    return work;
}

// Aplica o binding de pacote (Portão B) + a config TRAVADA do item a um trabalho.
// Chamado na criação de um trabalho sob um item de pacote. `locks` vem do
// spec_json do template (entitlement_counters.locks_json); `variant` vem do
// item (interview: "messages" | "realtime") — sem ele, um item realtime criaria
// um trabalho na variante default e o pacote venderia o produto errado.
// Idempotente por UPDATE.
export async function applyWorkPackageBinding(workId, templateKey, itemKey, locks = {}, variant = null) {
    if (variant != null && variant !== "messages" && variant !== "realtime") {
        throw new Error(`applyWorkPackageBinding: invalid variant "${variant}"`);
    }
    const qc = Number.isInteger(locks.question_count) ? locks.question_count : null;
    const mode = locks.interaction_mode || null;
    const mfu = Number.isInteger(locks.max_follow_ups) ? locks.max_follow_ups : null;
    const evalMode = locks.evaluation_mode || null;
    await pool.query(
        `UPDATE works SET
            entitlement_template_key = $1,
            entitlement_item_key     = $2,
            question_count   = COALESCE($3, question_count),
            interaction_mode = COALESCE($4, interaction_mode),
            max_follow_ups   = $5,
            evaluation_mode  = $6,
            interview_variant = COALESCE($7, interview_variant),
            updated_at = now()
          WHERE id = $8`,
        [templateKey, itemKey, qc, mode, mfu, evalMode, variant, workId]
    );
}

// Info mínima do binding de pacote de um trabalho (para o saque de Gate B, sem
// tocar os SELECTs grandes de getWorkByToken/findSubmissionByToken).
export async function getWorkEntitlementInfo(workId) {
    const r = await pool.query(
        `SELECT unit_id, entitlement_template_key, entitlement_item_key, evaluation_mode
           FROM works WHERE id = $1`,
        [workId]
    );
    return r.rows[0] || null;
}

// --- Prova oral (Realtime) ---

// PDF da prova (perguntas e respostas) que o professor sobe.
export async function setExamPdf(workId, buffer, filename) {
    await pool.query(
        "UPDATE works SET exam_pdf = $1, exam_filename = $2, updated_at = now() WHERE id = $3",
        [buffer, filename, workId]
    );
}
export async function getExamBlob(workId) {
    const r = await pool.query("SELECT exam_pdf, exam_filename FROM works WHERE id = $1", [workId]);
    if (r.rowCount === 0 || !r.rows[0].exam_pdf) return null;
    return { pdf: r.rows[0].exam_pdf, filename: r.rows[0].exam_filename };
}
// Só o nome do arquivo (sem carregar os bytes) — para exibir o estado atual.
export async function getExamFilename(workId) {
    const r = await pool.query("SELECT exam_filename FROM works WHERE id = $1", [workId]);
    return r.rows[0]?.exam_filename || null;
}
// Perguntas da prova oral (JSONB [{id,question,answer,rubric,weight,rubric_stale}]).
// `answer` = resposta esperada (opcional, insumo p/ gerar a rubrica); `rubric` = o
// critério detalhado (obrigatório p/ avaliar). Nada disso vai à sessão Realtime do aluno.
//
// IDs ESTÁVEIS: preserva o id de cada questão que já vem com um (id numérico > 0) e
// atribui novo id só a itens sem id, sempre a partir do contador monotônico
// works.oral_next_qid (nunca reusa id de questão apagada). Assim, apagar/reordenar
// questões não desloca os ids das demais — as notas por questão já gravadas
// (grades_json / oral_asked_json) continuam apontando a mesma questão.
//
// rubric_stale (marca de revisão) é RECALCULADO por diff contra o estado atual (por id):
//   - rubrica mudou            → false (o professor definiu/revisou a rubrica);
//   - senão pergunta/resposta mudou → true (a rubrica pode não valer mais);
//   - questão nova             → false se já tem rubrica, true se falta;
//   - sem mudança              → mantém o valor anterior.
// Devolve o array já com ids (o chamador usa na resposta).
export async function setOralQuestions(workId, questions) {
    const incoming = Array.isArray(questions) ? questions : [];
    const kept = incoming.filter(q => String(q?.question ?? "").trim());
    const r = await pool.query("SELECT oral_questions, oral_next_qid FROM works WHERE id = $1", [workId]);
    const prevById = {};
    for (const q of (Array.isArray(r.rows[0]?.oral_questions) ? r.rows[0].oral_questions : [])) {
        if (Number.isInteger(q?.id)) prevById[q.id] = q;
    }
    const maxProvided = kept.reduce((m, q) => (Number.isInteger(q?.id) && q.id > m ? q.id : m), 0);
    let counter = Math.max(Number(r.rows[0]?.oral_next_qid) || 1, maxProvided + 1);
    const seen = new Set();
    const cleaned = kept.map(q => {
        let id = Number.isInteger(q?.id) && q.id > 0 ? q.id : null;
        if (id != null && seen.has(id)) id = null; // id repetido (não deveria ocorrer) → trata como novo
        if (id == null) id = counter++;
        seen.add(id);
        const question = String(q.question).trim();
        const answer = String(q?.answer ?? "").trim();
        const rubric = String(q?.rubric ?? "").trim();
        const prev = id != null ? prevById[id] : null;
        let rubric_stale;
        if (!prev) rubric_stale = rubric ? false : true;
        else if (rubric !== String(prev.rubric ?? "").trim()) rubric_stale = false;
        else if (question !== String(prev.question ?? "").trim() || answer !== String(prev.answer ?? "").trim()) rubric_stale = true;
        else rubric_stale = prev.rubric_stale === true;
        return { id, question, answer, rubric, weight: Number(q?.weight) > 0 ? Number(q.weight) : 1, rubric_stale };
    });
    await pool.query(
        "UPDATE works SET oral_questions = $1, oral_next_qid = $2, updated_at = now() WHERE id = $3",
        [JSON.stringify(cleaned), counter, workId]
    );
    return cleaned;
}

// Atualiza a RUBRICA (+peso) de UMA questão (usado pela geração automática): grava
// rubric/weight no item de id `qid` e limpa rubric_stale. Não mexe nos demais.
export async function updateOralQuestionRubric(workId, qid, { rubric, weight }) {
    const r = await pool.query("SELECT oral_questions FROM works WHERE id = $1", [workId]);
    const arr = Array.isArray(r.rows[0]?.oral_questions) ? r.rows[0].oral_questions : [];
    let touched = false;
    const next = arr.map(q => {
        if (Number(q?.id) !== Number(qid)) return q;
        touched = true;
        return { ...q, rubric: String(rubric ?? "").trim(), weight: Number(weight) > 0 ? Number(weight) : (Number(q.weight) > 0 ? Number(q.weight) : 1), rubric_stale: false };
    });
    if (!touched) return null;
    await pool.query("UPDATE works SET oral_questions = $1, updated_at = now() WHERE id = $2", [JSON.stringify(next), workId]);
    return next.find(q => Number(q.id) === Number(qid)) || null;
}
export async function getOralQuestions(workId) {
    const r = await pool.query("SELECT oral_questions FROM works WHERE id = $1", [workId]);
    const q = r.rows[0]?.oral_questions;
    return Array.isArray(q) ? q : [];
}
// Frase de CALIBRAÇÃO DE FALA da prova oral (pré-teste de captação) — { sentence, key_terms }.
// NULL/ausente = pré-teste DESLIGADO para o trabalho (fail-open). Ver migration 040.
export async function getOralCalibration(workId) {
    const r = await pool.query("SELECT oral_calibration_json FROM works WHERE id = $1", [workId]);
    const c = r.rows[0]?.oral_calibration_json;
    return c && typeof c === "object" && String(c.sentence ?? "").trim() ? c : null;
}
export async function setOralCalibration(workId, calib) {
    const sentence = String(calib?.sentence ?? "").trim();
    const val = sentence
        ? JSON.stringify({
            sentence,
            key_terms: Array.isArray(calib?.key_terms)
                ? [...new Set(calib.key_terms.map(t => String(t ?? "").trim()).filter(Boolean))].slice(0, 6)
                : [],
        })
        : null; // frase vazia = limpa (desliga o pré-teste)
    await pool.query("UPDATE works SET oral_calibration_json = $1, updated_at = now() WHERE id = $2", [val, workId]);
    return val ? JSON.parse(val) : null;
}
// Proctoring por vídeo na entrevista (opt-in do professor). Ver migration 041.
export async function setProctoringEnabled(workId, enabled) {
    await pool.query("UPDATE works SET proctoring_enabled = $1, updated_at = now() WHERE id = $2", [!!enabled, workId]);
    return !!enabled;
}
// Prompt (opcional) do professor p/ a menção do proctoring na devolutiva (linguagem
// suave). NULL = usa o default do StudentFeedbackAgent. Compartilhado oral+entrevista.
export async function setDevolutivaProctorPrompt(workId, prompt) {
    const t = typeof prompt === "string" && prompt.trim() ? prompt.trim() : null;
    await pool.query("UPDATE works SET devolutiva_proctor_prompt = $1, updated_at = now() WHERE id = $2", [t, workId]);
    return t;
}
// Modo de pontuação da prova oral ('deterministico' | 'rubrica'). Ver migration 036.
export async function getOralGradingMode(workId) {
    const r = await pool.query("SELECT oral_grading_mode FROM works WHERE id = $1", [workId]);
    return r.rows[0]?.oral_grading_mode === "rubrica" ? "rubrica" : "deterministico";
}
export async function setOralGradingMode(workId, mode) {
    const m = mode === "rubrica" ? "rubrica" : "deterministico";
    await pool.query("UPDATE works SET oral_grading_mode = $1, updated_at = now() WHERE id = $2", [m, workId]);
    return m;
}
// Voz do examinador (prova oral) — sem tocar em interaction_mode.
export async function setWorkVoice(workId, voice) {
    await pool.query(
        "UPDATE works SET voice = $1, updated_at = now() WHERE id = $2",
        [voice || null, workId]
    );
}

export async function renameWork(workId, newName) {
    const name = String(newName ?? "").trim();
    if (!name) throw new Error("renameWork: name required");
    await pool.query(
        "UPDATE works SET name = $1, updated_at = now() WHERE id = $2",
        [name, workId]
    );
}

export async function updateWorkBudget(workId, budgetUsd) {
    if (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd < 0) {
        throw new Error("updateWorkBudget: budgetUsd must be a non-negative finite number");
    }
    const r = await pool.query(
        `UPDATE works SET budget_usd = $1, updated_at = now() WHERE id = $2
         RETURNING budget_usd::float8 AS budget_usd, spent_usd::float8 AS spent_usd`,
        [budgetUsd, workId]
    );
    return r.rows[0] || null;
}

export async function getWorkByToken(workToken) {
    const r = await pool.query(`
      SELECT
        id,
        work_token,
        name,
        enunciado_pdf IS NOT NULL  AS has_enunciado,
        interviewer_yaml IS NOT NULL AS has_interviewer,
        interaction_mode,
        interview_variant,
        voice,
        question_count,
        interviewer_name,
        interviewer_gender,
        feedback_guidelines,
        include_interviewer_opinion,
        include_strengths,
        include_improvement_areas,
        include_study_suggestions,
        grading_rubric,
        grade_penalty_json,
        expect_spontaneous,
        proctoring_enabled,
        devolutiva_proctor_prompt,
        kind,
        exam_pdf IS NOT NULL AS has_exam,
        COALESCE(jsonb_array_length(oral_questions), 0) AS oral_question_count,
        budget_usd::float8 AS budget_usd,
        spent_usd::float8  AS spent_usd,
        is_benchmark,
        benchmark_run_id
      FROM works
      WHERE work_token = $1
    `, [workToken]);
    return r.rows[0] || null;
}

// Configurações de devolutiva do trabalho: diretrizes + defaults de
// visibilidade das seções (incluindo a opinião do entrevistador). Valem para
// os lotes; ajuste por aluno fica na submissão. `sections` aceita qualquer
// subconjunto das chaves de FEEDBACK_SECTIONS → boolean.
export async function setWorkFeedbackSettings(workId, guidelines, sections = {}) {
    const trimmed = typeof guidelines === "string" && guidelines.trim() ? guidelines.trim() : null;
    const sets = ["feedback_guidelines = $1"];
    const vals = [trimmed];
    appendSectionSets(sets, vals, sections);
    vals.push(workId);
    await pool.query(
        `UPDATE works SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`,
        vals
    );
    return { feedback_guidelines: trimmed };
}

// Identidade do entrevistador (nome + gênero). Aceita os dois preenchidos
// (override do sorteio aleatório no /upload) ou os dois nulos (volta ao
// comportamento padrão). XOR é rejeitado tanto aqui quanto pela CHECK
// constraint no banco (migration 007).
export async function setWorkExpectSpontaneous(workId, expect) {
    await pool.query(
        "UPDATE works SET expect_spontaneous = $1, updated_at = now() WHERE id = $2",
        [!!expect, workId]
    );
}

// Rubrica de notas do trabalho. `criteria` é um array [{id,name,weight,prompt}]
// já validado pela rota (validateRubricShape em lib/rubric.js). Armazenado como
// { criteria } serializado em grading_rubric (TEXT). NULL volta ao DEFAULT_RUBRIC.
export async function setWorkRubric(workId, criteria) {
    await pool.query(
        "UPDATE works SET grading_rubric = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify({ criteria }), workId]
    );
}

// Política do critério de penalidade por alertas (opt-in). `policy` é
// { enabled: bool, prompt: string } — prompt vazio => usa o DEFAULT_PENALTY_PROMPT
// do agente. NULL desliga. Compartilhado por interview e oral_realtime.
export async function setWorkGradePenalty(workId, policy) {
    let val = null;
    if (policy && typeof policy === "object") {
        const enabled = !!policy.enabled;
        const prompt = typeof policy.prompt === "string" && policy.prompt.trim() ? policy.prompt.trim() : null;
        val = JSON.stringify({ enabled, prompt });
    }
    await pool.query(
        "UPDATE works SET grade_penalty_json = $1, updated_at = now() WHERE id = $2",
        [val, workId]
    );
    return val ? JSON.parse(val) : null;
}

export async function setWorkInterviewerIdentity(workId, name, gender) {
    const bothNull = name == null && gender == null;
    const bothSet = typeof name === "string" && name.trim() && (gender === "f" || gender === "m");
    if (!bothNull && !bothSet) {
        throw new Error("setWorkInterviewerIdentity: name e gender devem ser ambos preenchidos ou ambos nulos");
    }
    await pool.query(
        "UPDATE works SET interviewer_name = $1, interviewer_gender = $2, updated_at = now() WHERE id = $3",
        [bothNull ? null : name.trim(), bothNull ? null : gender, workId]
    );
}

export async function listCostEventsForWork(workId, limit = 50) {
    const r = await pool.query(
        `SELECT id, submission_id, event_type, model, agent_label,
                input_tokens, cached_tokens, output_tokens,
                audio_seconds, audio_chars,
                cost_usd::float8 AS cost_usd, created_at
         FROM work_cost_events
         WHERE work_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [workId, limit]
    );
    return r.rows;
}

export async function setInteractionMode(workId, mode, voice) {
    if (mode !== "text" && mode !== "audio") {
        throw new Error(`invalid interaction_mode "${mode}"`);
    }
    const voiceParam = mode === "audio" ? voice : null;
    await pool.query(
        "UPDATE works SET interaction_mode = $1, voice = $2, updated_at = now() WHERE id = $3",
        [mode, voiceParam, workId]
    );
}

// Variante da entrevista (kind='interview'): 'messages' = profunda (por
// mensagens, orquestrador por turno) | 'realtime' = simplificada (tempo real,
// por voz via Realtime). Ver migration 050.
export async function setWorkInterviewVariant(workId, variant) {
    if (variant !== "messages" && variant !== "realtime") {
        throw new Error(`invalid interview_variant "${variant}"`);
    }
    await pool.query(
        "UPDATE works SET interview_variant = $1, updated_at = now() WHERE id = $2",
        [variant, workId]
    );
}

// Número de perguntas planejadas. Guard inline (defesa) espelha a faixa de
// config.js#isValidQuestionCount e a CHECK constraint da migration 010. A rota
// já valida antes; aqui é a última barreira antes do banco.
export async function setQuestionCount(workId, count) {
    if (!Number.isInteger(count) || count < 3 || count > 20) {
        throw new Error(`invalid question_count "${count}"`);
    }
    await pool.query(
        "UPDATE works SET question_count = $1, updated_at = now() WHERE id = $2",
        [count, workId]
    );
}

export async function getEnunciadoBlob(workId) {
    const r = await pool.query(
        "SELECT enunciado_pdf, enunciado_filename FROM works WHERE id = $1",
        [workId]
    );
    if (r.rowCount === 0 || !r.rows[0].enunciado_pdf) return null;
    return { pdf: r.rows[0].enunciado_pdf, filename: r.rows[0].enunciado_filename };
}
// Só o nome do enunciado (sem carregar os bytes) — para exibir o estado atual (#133).
export async function getEnunciadoFilename(workId) {
    const r = await pool.query("SELECT enunciado_filename FROM works WHERE id = $1", [workId]);
    return r.rows[0]?.enunciado_filename || null;
}

export async function setEnunciadoBlob(workId, buffer, filename) {
    await pool.query(
        "UPDATE works SET enunciado_pdf = $1, enunciado_filename = $2, updated_at = now() WHERE id = $3",
        [buffer, filename, workId]
    );
}

export async function getInterviewerYaml(workId) {
    const r = await pool.query(
        "SELECT interviewer_yaml FROM works WHERE id = $1",
        [workId]
    );
    if (r.rowCount === 0) return null;
    return r.rows[0].interviewer_yaml;
}

export async function setInterviewerYaml(workId, yamlText) {
    await pool.query(
        "UPDATE works SET interviewer_yaml = $1, updated_at = now() WHERE id = $2",
        [yamlText, workId]
    );
}

// ---------------------------------------------------------------------
// Enunciado coherence cache
// Cached output of EnunciadoCoherenceAgent. Reset whenever the enunciado PDF
// is replaced (handled in setEnunciadoBlob caller).
// ---------------------------------------------------------------------

export async function getCoherenceCache(workId) {
    const r = await pool.query(
        "SELECT enunciado_coherence_json FROM works WHERE id = $1",
        [workId]
    );
    if (r.rowCount === 0) return null;
    const text = r.rows[0].enunciado_coherence_json;
    if (!text) return null;
    try { return JSON.parse(text); }
    catch { return null; }
}

export async function setCoherenceCache(workId, reportObject) {
    await pool.query(
        "UPDATE works SET enunciado_coherence_json = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify(reportObject), workId]
    );
}

export async function clearCoherenceCache(workId) {
    await pool.query(
        "UPDATE works SET enunciado_coherence_json = NULL, updated_at = now() WHERE id = $1",
        [workId]
    );
}
