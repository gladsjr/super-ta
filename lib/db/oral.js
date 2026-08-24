// Prova oral (Realtime). Parte do split de lib/db.js (ver lib/db.js, que é o
// barrel que re-exporta tudo). SQL e lógica preservados verbatim do módulo
// monolítico original.

import { pool } from "../../auth.js";
import { batchEligibleSql } from "../batchEligibility.js";

// Perguntas sorteadas/feitas a um aluno específico (subconjunto do gabarito).
export async function setOralAsked(submissionId, questions) {
    await pool.query(
        "UPDATE submissions SET oral_asked_json = $1, updated_at = now() WHERE id = $2",
        [JSON.stringify(questions || []), submissionId]
    );
}
export async function getOralAsked(submissionId) {
    const r = await pool.query("SELECT oral_asked_json FROM submissions WHERE id = $1", [submissionId]);
    const q = r.rows[0]?.oral_asked_json;
    return Array.isArray(q) && q.length ? q : null;
}
// Chave do vídeo gravado da prova oral (object storage).
export async function setOralVideoKey(submissionId, key) {
    await pool.query(
        "UPDATE submissions SET oral_video_key = $1, updated_at = now() WHERE id = $2",
        [key || null, submissionId]
    );
}
export async function getOralVideoKey(submissionId) {
    const r = await pool.query("SELECT oral_video_key FROM submissions WHERE id = $1", [submissionId]);
    return r.rows[0]?.oral_video_key || null;
}
// Anexa um SEGMENTO de vídeo (multi-parte: original + cada retomada).
// oral_video_key guarda o PRIMEIRO segmento. Antes guardava o ÚLTIMO, o que fazia
// qualquer caminho que lesse a "chave única" cair num pedaço arbitrário do fim da
// sessão (#256) — numa sessão fragmentada, o último segmento pode ser o começo do
// fim, e o fallback de getOralVideoParts devolvia justamente ele. A coluna serve a
// `has_oral_video` (IS NOT NULL) e a esse fallback; o primeiro segmento é a escolha
// certa para os dois. A lista completa e ordenada continua em oral_video_parts.
export async function appendOralVideoPart(submissionId, key) {
    await pool.query(
        `UPDATE submissions
            SET oral_video_parts = oral_video_parts || to_jsonb($1::text),
                oral_video_key = COALESCE(oral_video_key, $1),
                updated_at = now()
          WHERE id = $2`,
        [key, submissionId]
    );
}
// Lista ordenada das chaves de segmento. Fallback para [oral_video_key] cobre
// linhas anteriores ao backfill (defensivo; a migration 035 já faz o backfill).
export async function getOralVideoParts(submissionId) {
    const r = await pool.query("SELECT oral_video_parts, oral_video_key FROM submissions WHERE id = $1", [submissionId]);
    const row = r.rows[0];
    if (!row) return [];
    const parts = Array.isArray(row.oral_video_parts) ? row.oral_video_parts.filter(Boolean) : [];
    if (parts.length) return parts;
    return row.oral_video_key ? [row.oral_video_key] : [];
}
// Transcrição da prova oral (registro p/ avaliação). [{role,text}]. INVALIDA os
// alertas de transcrição antigos na MESMA operação (#218): eles são por índice de
// turno — se a transcrição muda (prova refeita) sem recomputá-los, os índices caem
// sobre turnos errados. Quem quiser alertas grava logo depois (onTranscript).
export async function setOralTranscript(submissionId, transcript) {
    await pool.query(
        `UPDATE submissions SET oral_transcript = $1,
                oral_voice_json = COALESCE(oral_voice_json, '{}'::jsonb) - 'transcript_alerts',
                updated_at = now() WHERE id = $2`,
        [JSON.stringify(transcript || []), submissionId]
    );
}
export async function getOralTranscript(submissionId) {
    const r = await pool.query("SELECT oral_transcript FROM submissions WHERE id = $1", [submissionId]);
    const t = r.rows[0]?.oral_transcript;
    return Array.isArray(t) ? t : [];
}
// Transcrição FINAL (retranscrição de auditoria do áudio contínuo do tee,
// #289). Convive com oral_transcript (ao vivo) — nesta fase NÃO substitui a
// fonte da avaliação; é registro para o professor.
export async function setFinalTranscript(submissionId, payload) {
    await pool.query(
        `UPDATE submissions SET final_transcript = $1, final_transcript_at = now(), updated_at = now() WHERE id = $2`,
        [JSON.stringify(payload || {}), submissionId]
    );
}
export async function getFinalTranscript(submissionId) {
    const r = await pool.query("SELECT final_transcript, final_transcript_at FROM submissions WHERE id = $1", [submissionId]);
    const row = r.rows[0];
    return row?.final_transcript ? { ...row.final_transcript, at: row.final_transcript_at } : null;
}

// --- Avaliação da prova oral (relatório de comparação ao gabarito) +
// devolutiva/nota MANUAIS do professor. Nota e publicação reusam as colunas da
// entrevista (grade_final, evaluation_published_at, grade_published_at). ---
export async function setOralEvaluation(submissionId, report) {
    await pool.query(
        "UPDATE submissions SET oral_eval_json = $1, evaluation_at = now(), updated_at = now() WHERE id = $2",
        [JSON.stringify(report || {}), submissionId]
    );
}
export async function setOralDevolutiva(submissionId, text) {
    const t = typeof text === "string" ? text : "";
    await pool.query(
        "UPDATE submissions SET oral_devolutiva = $1, updated_at = now() WHERE id = $2",
        [t, submissionId]
    );
}
export async function publishOralDevolutiva(submissionId, on) {
    await pool.query(
        `UPDATE submissions SET evaluation_published_at = ${on ? "now()" : "NULL"}, updated_at = now() WHERE id = $1`,
        [submissionId]
    );
}
export async function publishOralGrade(submissionId, on) {
    await pool.query(
        `UPDATE submissions SET grade_published_at = ${on ? "now()" : "NULL"}, updated_at = now() WHERE id = $1`,
        [submissionId]
    );
}
// Lote: submissões com transcrição (prova realizada) para avaliar. force=false
// pula as que já têm relatório; force=true reavalia todas.
export async function listOralSubmissionsForEval(workId, force = false) {
    const r = await pool.query(
        `SELECT id, submission_token, student_label
           FROM submissions
          WHERE work_id = $1 AND oral_transcript IS NOT NULL
            AND ${batchEligibleSql()}
            ${force ? "" : "AND oral_eval_json IS NULL"}
          ORDER BY created_at ASC`,
        [workId]
    );
    return r.rows;
}
// Lote: gerar devolutivas. Candidatas = provas já avaliadas (têm oral_eval_json).
// Sem force, pula quem já tem devolutiva escrita (preserva edição/geração anterior).
export async function listOralSubmissionsForDevolutiva(workId, force = false) {
    const r = await pool.query(
        `SELECT id, submission_token, student_label
           FROM submissions
          WHERE work_id = $1 AND oral_eval_json IS NOT NULL
            AND ${batchEligibleSql()}
            ${force ? "" : "AND (oral_devolutiva IS NULL OR oral_devolutiva = '')"}
          ORDER BY created_at ASC`,
        [workId]
    );
    return r.rows;
}
// Lote: publicar/despublicar devolutivas. Ao publicar, só afeta quem tem
// devolutiva escrita; ao despublicar, afeta todas as publicadas do trabalho.
export async function publishAllOralDevolutiva(workId, on) {
    const r = await pool.query(
        `UPDATE submissions
            SET evaluation_published_at = ${on ? "now()" : "NULL"}, updated_at = now()
          WHERE work_id = $1
            ${on ? "AND oral_devolutiva IS NOT NULL AND oral_devolutiva <> '' AND evaluation_published_at IS NULL"
                 : "AND evaluation_published_at IS NOT NULL"}`,
        [workId]
    );
    return r.rowCount;
}
// Lote: publicar/despublicar notas (mesma lógica das devolutivas).
export async function publishAllOralGrade(workId, on) {
    const r = await pool.query(
        `UPDATE submissions
            SET grade_published_at = ${on ? "now()" : "NULL"}, updated_at = now()
          WHERE work_id = $1
            ${on ? "AND grade_final IS NOT NULL AND grade_published_at IS NULL"
                 : "AND grade_published_at IS NOT NULL"}`,
        [workId]
    );
    return r.rowCount;
}
// Estado oral por aluno (painel do professor e visão do aluno).
export async function getOralSubmissionDetail(submissionId) {
    const r = await pool.query(
        `SELECT oral_eval_json, oral_devolutiva, oral_transcript, final_transcript, final_transcript_at, oral_proctor_json, oral_voice_json,
                oral_calibration_json, oral_video_parts,
                grade_final::float8 AS grade_final,
                evaluation_published_at, grade_published_at,
                (oral_video_key IS NOT NULL) AS has_oral_video,
                completion_reason, student_comment
         FROM submissions WHERE id = $1`,
        [submissionId]
    );
    return r.rows[0] || null;
}
// Resultado do proctoring local por vídeo (flags para revisão humana). Gravar um
// relatório = análise CONCLUÍDA → limpa o proctor_status (running/failed), qualquer
// que seja o caminho (automático, single ou lote). Ver setOralProctorStatus (#220).
export async function setOralProctor(submissionId, report) {
    await pool.query(
        `UPDATE submissions SET oral_proctor_json = $1,
                oral_voice_json = COALESCE(oral_voice_json, '{}'::jsonb) - 'proctor_status',
                updated_at = now() WHERE id = $2`,
        [JSON.stringify(report || {}), submissionId]
    );
}
// Estado da análise de proctoring (issues #220/#262):
//   { state:'queued'|'running'|'failed', at, error?, attempts? }
// em oral_voice_json.proctor_status. status=null limpa a chave (usado no sucesso —
// "concluído" é derivado de oral_proctor_json presente; o attempts do sucesso vai
// DENTRO do relatório, ver proctorQueue). Distingue "na fila"/"rodando"/"falhou"
// de "nunca analisada" (prova antiga).
export async function setOralProctorStatus(submissionId, status) {
    if (status === null) {
        await pool.query(
            `UPDATE submissions SET oral_voice_json = COALESCE(oral_voice_json, '{}'::jsonb) - 'proctor_status', updated_at = now() WHERE id = $1`,
            [submissionId]
        );
    } else {
        await pool.query(
            `UPDATE submissions SET oral_voice_json = COALESCE(oral_voice_json, '{}'::jsonb) || jsonb_build_object('proctor_status', $2::jsonb), updated_at = now() WHERE id = $1`,
            [submissionId, JSON.stringify(status)]
        );
    }
}
// Estado atual da análise de uma submissão (para a fila calcular attempts).
export async function getOralProctorStatus(submissionId) {
    const r = await pool.query(
        "SELECT oral_voice_json->'proctor_status' AS st FROM submissions WHERE id = $1",
        [submissionId]
    );
    return r.rows[0]?.st || null;
}
// Reconciliação no BOOT (issue #262): tudo que tem vídeo, não tem relatório e não
// está marcado como 'failed' volta para a fila — cobre `queued`/`running` órfãos de
// um reinício E o legado sem status (prova antiga anterior ao disparo automático).
// 'failed' fica de fora de propósito: sem retentativa automática, reprocessar é
// sempre um ato humano (professor ou admin).
export async function listProctorReconcileCandidates() {
    const r = await pool.query(
        `SELECT id, submission_token
           FROM submissions
          WHERE COALESCE(jsonb_array_length(oral_video_parts), 0) > 0
            AND oral_proctor_json IS NULL
            AND COALESCE(oral_voice_json->'proctor_status'->>'state', '') <> 'failed'
          ORDER BY created_at ASC, id ASC`
    );
    return r.rows;
}
// Visão de OPERAÇÕES (admin, issue #263): enriquece a fila em memória com
// aluno/trabalho (por ids), lista as falhas pendentes e conta reprocessamentos.
export async function getProctorSubmissionInfo(ids) {
    if (!ids?.length) return [];
    const r = await pool.query(
        `SELECT s.id, s.submission_token, s.student_label, s.is_test,
                w.name AS work_name, w.work_token, w.kind, w.interview_variant
           FROM submissions s JOIN works w ON w.id = s.work_id
          WHERE s.id = ANY($1::int[])`,
        [ids]
    );
    return r.rows;
}
export async function listProctorFailures() {
    const r = await pool.query(
        `SELECT s.id, s.submission_token, s.student_label, s.is_test,
                w.name AS work_name, w.work_token, w.kind,
                s.oral_voice_json->'proctor_status' AS status
           FROM submissions s JOIN works w ON w.id = s.work_id
          WHERE s.oral_voice_json->'proctor_status'->>'state' = 'failed'
          ORDER BY s.updated_at DESC
          LIMIT 100`
    );
    return r.rows;
}
// Contadores: falhas pendentes; reprocessos que resolveram (relatório gravado com
// attempts>1 — o attempts do sucesso vive DENTRO de oral_proctor_json); reprocessos
// que falharam de novo (failed com attempts>=2).
export async function getProctorStats() {
    const r = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE oral_voice_json->'proctor_status'->>'state' = 'failed') AS failed_pending,
           COUNT(*) FILTER (WHERE COALESCE((oral_proctor_json->>'attempts')::int, 1) > 1) AS reprocessed_ok,
           COUNT(*) FILTER (WHERE oral_voice_json->'proctor_status'->>'state' = 'failed'
                              AND COALESCE((oral_voice_json->'proctor_status'->>'attempts')::int, 1) >= 2) AS reprocessed_failed
           FROM submissions`
    );
    const row = r.rows[0] || {};
    return {
        failed_pending: Number(row.failed_pending || 0),
        reprocessed_ok: Number(row.reprocessed_ok || 0),
        reprocessed_failed: Number(row.reprocessed_failed || 0),
    };
}
// Sinalizadores de voz. Mescla chaves no JSON existente (latência vem do relay;
// segunda voz / voz sintética vêm depois, da análise de áudio pós-prova).
export async function setOralVoice(submissionId, partial) {
    await pool.query(
        `UPDATE submissions SET oral_voice_json = COALESCE(oral_voice_json, '{}'::jsonb) || $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify(partial || {}), submissionId]
    );
}

// Monitor de captação em sessão (#287, fase "só sinaliza"): contadores por
// submissão em oral_voice_json.stt_monitor — total de respostas transcritas e
// quantas o classificador (#137) marcou como suspeitas. Incremento atômico.
export async function bumpSttMonitor(submissionId, suspect) {
    // `||` + jsonb_build_object, não jsonb_set: jsonb_set NÃO cria o objeto
    // pai ausente ('{stt_monitor,total}' sem 'stt_monitor' = no-op silencioso).
    await pool.query(
        `UPDATE submissions SET oral_voice_json =
            COALESCE(oral_voice_json, '{}'::jsonb) ||
            jsonb_build_object('stt_monitor', jsonb_build_object(
                'total',   COALESCE((oral_voice_json#>>'{stt_monitor,total}')::int, 0) + 1,
                'suspect', COALESCE((oral_voice_json#>>'{stt_monitor,suspect}')::int, 0) + $2
            )), updated_at = now() WHERE id = $1`,
        [submissionId, suspect ? 1 : 0]
    );
}

// Contador de eventos de fala do aluno na última sessão de voz (#283) — o gate
// de retomada o consulta em vez do texto transcrito. 0 se nunca gravado.
export async function getStudentSpeechEvents(submissionId) {
    const r = await pool.query(
        `SELECT (oral_voice_json->>'student_speech_events')::int AS n FROM submissions WHERE id = $1`,
        [submissionId]
    );
    return Number(r.rows[0]?.n) || 0;
}

// Resultado do pré-teste de CALIBRAÇÃO DE FALA do aluno (registro p/ o professor).
// { passed, attempts, worst_wer, missed_terms, target, transcripts }. Ver migration 040.
// MERGE de chaves (#288): a mesma coluna acumula as sondas do sound check v2
// (echo, hfp, waived_at) — gravar a leitura não pode apagar as outras sondas.
export async function setOralCalibrationResult(submissionId, result) {
    await pool.query(
        `UPDATE submissions
            SET oral_calibration_json = COALESCE(oral_calibration_json, '{}'::jsonb) || $1::jsonb,
                updated_at = now()
          WHERE id = $2`,
        [JSON.stringify(result || {}), submissionId]
    );
}

// Marca a prova oral como concluída — idempotente (não sobrescreve se já estava).
// Usado para impedir refazer a prova (no-retake).
export async function markOralExamCompleted(submissionId) {
    await pool.query(
        `UPDATE submissions SET completion_reason = 'complete', completed_at = now(), updated_at = now()
         WHERE id = $1 AND completion_reason IS NULL`,
        [submissionId]
    );
}

// Lote de proctoring por vídeo: submissões com vídeo gravado. Sem force, pula
// as já analisadas; com force, reanalisa todas.
export async function listOralSubmissionsForProctor(workId, force = false) {
    const r = await pool.query(
        `SELECT id, submission_token, student_label
           FROM submissions
          WHERE work_id = $1 AND oral_video_key IS NOT NULL
            AND ${batchEligibleSql()}
            ${force ? "" : "AND oral_proctor_json IS NULL"}
          ORDER BY created_at ASC`,
        [workId]
    );
    return r.rows;
}
