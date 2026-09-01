// Rotas da PROVA ORAL (Realtime). Tipo de trabalho `kind='oral_realtime'`.
// Lado do professor: subir o PDF de perguntas-e-respostas (extração via modelo
// rápido), ver as perguntas e configurar N + voz. Lado do aluno (minting da
// sessão Realtime) entra na Fase B, neste mesmo router.
//
// Auth do professor: requireWorkToken (o token do trabalho é a credencial,
// como no resto do painel do professor). Sem login.

import express from "express";
import multer from "multer";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import { requireWorkToken, requireSubmissionToken, requireProfessorSubmission, requireWithinBudget } from "../lib/middleware.js";
import { sttTranscribe } from "../lib/stt.js";
import { publicBaseUrl } from "../lib/publicUrl.js";
import * as db from "../lib/db.js";
import { wouldResume } from "../lib/resumeGate.js";
import { openai, clientForWork, apiKeyForWork } from "../lib/openaiClient.js";
import { oralExamExtractorAgent, oralExamEvaluatorAgent, oralRubricBuilderAgent, oralCalibrationAgent } from "../lib/agents.js";
import { putAudioFromFile, extFromMimetype } from "../lib/audioStore.js";
import { serveVideo } from "../lib/serveVideo.js";
import { ensureConsolidatedVideo } from "../lib/videoConsolidate.js";
import { scoreCalibration } from "../lib/speechCalib.js";
import { ECHO_SENTENCE, ECHO_LEAK_MIN_MATCHES, countEchoMatches, ladderState, parseHfp, soundCheckPending, soundCheckProgress, SC_SCRIPTS, SCRIPT_LEAK_MIN, scriptLeakMatches } from "../lib/soundCheck.js";
import { buildAuditBlock, auditPromptBlock } from "../lib/auditTranscript.js";
import { synthesizeSpeech } from "../lib/audio.js";
import { VOICES, isValidVoice, isRealtimeVoice, voicesFor, FALLBACK_VOICE } from "../config/voices.js";
import { isValidQuestionCount, REALTIME_MODEL, TTS_MODEL, ORAL_RUBRIC_BLOCK_SIZE } from "../lib/config.js";
import { exceedsPageLimit } from "../lib/pdfPages.js";
import { CONSENT_VERSION } from "../config/consent.js";
import { sampleKeepingOrder, buildExamInstructions } from "../lib/oralRealtime.js";
import { enqueueProctor } from "../lib/proctorQueue.js";
import { mapPool } from "../lib/concurrency.js";
import { rubricQuota, rubricsThatConsume } from "../lib/rubricQuota.js";
import { questionHasRubric } from "../lib/oralRubric.js";
import { weightedFinal } from "../lib/rubric.js";
import { deriveOralDevolutivaNow } from "../lib/oralFeedbackOps.js";
import { REVIEW_WINDOW_DAYS, reviewWindowState } from "../lib/reviewWindow.js";
import { comErroTratado } from "../lib/uploadErrors.js";
import log from "../lib/logger.js";

const MAX_COMMENT_LEN = 2000;

const router = express.Router();
const examUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
// Vídeo da prova (até 300MB): em DISCO (não memória). Com memoryStorage, 50
// uploads simultâneos seguram até 300MB cada na RAM durante toda a transferência
// (lenta no mobile). Em disco, a transferência não pesa na RAM; só lemos o arquivo
// na hora de mandar pro storage, e apagamos o temporário em seguida.
const videoUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 300 * 1024 * 1024 } });
// Clipe curto de áudio do pré-teste de calibração de fala (em memória; poucos segundos).
const calibUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
// Nº máximo de tentativas do pré-teste de calibração antes de o aluno seguir mesmo assim.
const MAX_CALIB_ATTEMPTS = 2;
// Guardrail de custo: teto do BANCO de questões da prova oral (previsibilidade de
// custo — cada questão vira rubrica/avaliação). O nº sorteado por aluno é bem menor.
const MAX_ORAL_QUESTIONS = 100;
// Limites de TAMANHO do material importado (banco de perguntas+respostas), próprios
// da oral — não herdam os globais da entrevista por mensagem (issue #184). Dimensionados
// para ~100 perguntas com resposta esperada dissertativa (Humanas): orço ~650 chars por
// pergunta × 100 ≈ 65k chars ≈ ~20 páginas. O PDF global de 50 páginas caberia 300–500
// perguntas — muito além do cap de 100 (daí o truncamento constante). O cap de 100 +
// aviso (truncated) segue como backstop para arquivo pequeno mas denso.
const MAX_ORAL_PDF_PAGES = 20;
const MAX_ORAL_TXT_CHARS = 65000;

// Alertas de proctoring por VÍDEO para a lista do professor (resumo conservador,
// calculado dos flags brutos — limiares ajustáveis sem reprocessar o vídeo).
function proctorAlerts(p) {
    if (!p || !p.flags) return [];
    const f = p.flags, a = [];
    if (f.absent && f.absent.pct >= 20) a.push("ausência");
    if (f.multiple_people && f.multiple_people.pct >= 20) a.push("+1 pessoa");
    // Celular: calibrado contra vídeo real SEM celular em que o aluno gesticula
    // muito — as mãos perto do rosto geraram 7 frames confirmados (~1%) mesmo após
    // a re-verificação com zoom. Por isso o selo exige ≥5% da prova (uso sustentado)
    // OU ≥10 frames confirmados (provas longas diluem o percentual). Um relance
    // curto não acende o selo, mas segue visível no detalhe por aluno (count/raw_count).
    if (f.phone && (f.phone.pct >= 5 || f.phone.count >= 10)) a.push("celular");
    if (f.hands && f.hands.flag) a.push("mãos fora");
    return a;
}
// Alerta de VOZ: houve pausa longa antes de resposta substancial.
function voiceAlert(v) { return !!(v && v.latency && v.latency.flagged_count > 0); }
// Alerta de CALIBRAÇÃO DE FALA: o pré-teste de captação foi feito e NÃO passou.
function calibrationAlert(c) { return !!(c && c.passed === false); }
// Alerta de TRANSCRIÇÃO (#137): a detecção guardou >=1 trecho suspeito de alucinação
// (silêncio/ruído/eco). Mora em oral_voice_json.transcript_alerts (ver lib/transcriptAlerts).
function transcriptAlertCount(v) { return (v && v.transcript_alerts && v.transcript_alerts.count) || 0; }

// grades_json (mesma forma da entrevista) a partir do relatório do avaliador + os
// pesos das questões. Um único modelo: o avaliador dá um score ANCORADO nos 5
// níveis (0/2,5/5/7,5/10); aqui só arredondamos à âncora mais próxima por robustez.
// Nota final = média ponderada pelos pesos (weightedFinal), sobre as questões do aluno.
const ANCHORS = [0, 2.5, 5, 7.5, 10];
function toAnchor(raw) {
    const s = Number(raw);
    if (!Number.isFinite(s)) return 0;
    return ANCHORS.reduce((best, a) => (Math.abs(a - s) < Math.abs(best - s) ? a : best), 0);
}
// Sessão INTERROMPIDA (#362): a pergunta que nunca chegou a ser feita não pode
// valer zero nem sumir da conta.
//
// Antes ela sumia: o avaliador não a inclui em `per_question`, e o cálculo
// caminhava só sobre as presentes. A média até saía certa — `weightedFinal`
// ignora quem não tem nota —, mas de forma INVISÍVEL: o professor via uma prova
// de 3 questões onde o aluno tinha 4 sorteadas, sem nada dizendo o que houve.
// Numa nota que vai para o histórico do aluno, "parece certo" não basta.
//
// Agora a questão não realizada entra na lista com `score: null` e
// `not_asked: true`. Não puxa a média (é o mesmo comportamento de antes) e
// aparece no painel como o que é: neutralizada porque não foi perguntada.
//
// A distinção que importa: pergunta FEITA e não respondida continua sendo
// avaliada (o aluno a ouviu e não soube responder — isso é desempenho). Só a
// que nunca saiu da boca do examinador é neutralizada. Quem faz essa separação
// é o avaliador, que leu a transcrição: o que ele não pontuou, não aconteceu.
export function gradesFromReport(report, questions) {
    const pq = report && Array.isArray(report.per_question) ? report.per_question : [];
    if (!pq.length) return null;
    const wById = {};
    for (const q of (questions || [])) wById[q.id] = Number(q.weight) > 0 ? Number(q.weight) : 1;
    const criteria = pq.map(q => ({
        id: q.id, name: q.question, weight: wById[q.id] != null ? wById[q.id] : 1,
        score: toAnchor(q.score), justification: q.comment || "",
    }));
    const avaliadas = new Set(pq.map(q => q.id));
    const naoRealizadas = (questions || []).filter(q => !avaliadas.has(q.id));
    for (const q of naoRealizadas) {
        criteria.push({
            id: q.id, name: q.question, weight: wById[q.id] != null ? wById[q.id] : 1,
            score: null, not_asked: true,
            justification: "Não perguntada — a sessão foi interrompida antes. Neutralizada: não entra na média.",
        });
    }
    return {
        criteria,
        final: weightedFinal(criteria),
        // O painel e as exportações leem daqui para dizer "avaliada parcialmente"
        // sem precisar recontar nada.
        partial: naoRealizadas.length > 0 ? { not_asked: naoRealizadas.length, scored: pq.length } : null,
        computed_at: new Date().toISOString(),
    };
}
// Após avaliar: preenche a NOTA como default (= média ponderada da rubrica), sem
// sobrescrever ajuste já feito pelo professor. Os alertas de proctoring NÃO mexem
// na nota — são só indícios para o professor considerar e, se quiser, ajustar a
// nota à mão (proctoring = revisão humana, nunca acusação automática).
async function applyEvalDefaults(work, submissionId, detail, report, questions) {
    if (!detail || detail.grade_final == null) {
        const grades = gradesFromReport(report, questions);
        if (grades) {
            await db.setSubmissionGrades(submissionId, grades);
        }
    }
}

// Garante que o trabalho é uma prova oral antes de seguir.
function requireOral(req, res, next) {
    if (req.work.kind !== "oral_realtime") {
        return res.status(400).json({ error: "este trabalho não é uma prova oral" });
    }
    next();
}

// Ping LEVÍSSIMO para o teste de conexão do aluno (mede RTT antes da prova). Sem
// auth, sem banco — só confirma o caminho até o servidor. no-store p/ não cachear.
router.get("/oral/ping", (_req, res) => { res.set("Cache-Control", "no-store"); res.type("text/plain").send("ok"); });

// Info para a página do professor: config + perguntas extraídas (o professor vê
// perguntas E respostas — é a prova dele) + lista de vozes.
router.get("/w/:workToken/oral/info", requireWorkToken, requireOral, async (req, res) => {
    try {
        const [questions, subs, calibration] = await Promise.all([
            db.getOralQuestions(req.work.id),
            db.listSubmissionsForWork(req.work.id),
            db.getOralCalibration(req.work.id),
        ]);
        res.set("Cache-Control", "no-store");
        res.json({
            work: {
                name: req.work.name,
                kind: req.work.kind,
                has_exam: req.work.has_exam,
                exam_filename: req.work.has_exam ? await db.getExamFilename(req.work.id) : null,
                question_count: req.work.question_count,
                voice: req.work.voice,
                feedback_guidelines: req.work.feedback_guidelines || "",
                include_interviewer_opinion: req.work.include_interviewer_opinion !== false,
                include_strengths: req.work.include_strengths !== false,
                include_improvement_areas: req.work.include_improvement_areas !== false,
                include_study_suggestions: req.work.include_study_suggestions !== false,
                grade_penalty: req.work.grade_penalty_json || null,
                oral_calibration: calibration || null,
            },
            public_base_url: publicBaseUrl(req),   // origem canônica p/ montar o link do aluno
            questions,
            submissions: (subs || []).map(s => ({
                submission_token: s.submission_token,
                student_label: s.student_label,
                status: s.status,
                is_test: !!s.is_test,
                is_blocked: !!s.is_blocked,
                has_oral_video: !!s.has_oral_video,
                oral_video_parts: Number(s.oral_video_parts_count) || (s.has_oral_video ? 1 : 0),
                // Queda de gravação pausou a arguição (#260): o professor decide
                // liberar a retomada ou avaliar o que já foi gravado.
                resume_blocked: !!s.resume_blocked,
                oral_student_turns: Number(s.oral_student_turns) || 0,
                has_oral_eval: !!s.has_oral_eval,
                grade: s.grade_final ?? null,
                // #362: nº de questões neutralizadas por não terem sido feitas.
                // > 0 significa nota apurada sobre uma prova INCOMPLETA.
                grade_not_asked: Number(s.grade_not_asked) || 0,
                devolutiva_published: !!s.evaluation_published_at,
                grade_published: !!s.grade_published_at,
                has_oral_proctor: !!s.has_oral_proctor,
                // Estado da fila global (#262), persistido no banco: o professor vê
                // 'queued'/'running' colapsados em "em análise"; 'failed' ganha o
                // botão de reprocessar (#264).
                proctor_state: s.oral_voice_json?.proctor_status?.state || null,
                proctor_error: s.oral_voice_json?.proctor_status?.error || null,
                proctor_attempts: Number(s.oral_voice_json?.proctor_status?.attempts || 0),
                proctor_alerts: proctorAlerts(s.oral_proctor_json),
                voice_alert: voiceAlert(s.oral_voice_json),
                // Vigilância de posição ao vivo (#267): pausas e estado. Desligada
                // NÃO é silêncio — é sinal (ADR 0018): o professor sabe que aquele
                // vídeo não teve cobrança de posição em tempo real.
                live_nudges: s.oral_voice_json?.live_nudges || null,
                calibration_alert: calibrationAlert(s.oral_calibration_json),
                // Escada do sound check v2 (#288): o professor vê os VERMELHOS
                // antes do dia da prova e pode liberar (waive-soundcheck).
                sound_check: ladderState(s.oral_calibration_json),
                transcript_alerts: transcriptAlertCount(s.oral_voice_json),
            })),
            // #351: a prova oral é Realtime — só oferece o que o modelo aceita.
            voices: voicesFor({ realtime: true }),
        });
    } catch (err) {
        log.error("ORAL", `info failed: ${err.message}`);
        res.status(500).json({ error: "falha ao carregar a prova" });
    }
});

// Download do material da prova que o professor enviou (consulta pós-upload,
// issue #131). Espelha o GET do enunciado da entrevista.
router.get("/w/:workToken/oral/exam-pdf", requireWorkToken, requireOral, async (req, res) => {
    try {
        const blob = await db.getExamBlob(req.work.id);
        if (!blob) return res.status(404).json({ error: "exam not uploaded" });
        const isTxt = (blob.filename || "").toLowerCase().endsWith(".txt");
        res.type(isTxt ? "text/plain; charset=utf-8" : "application/pdf");
        if (blob.filename) res.set("Content-Disposition", `inline; filename="${encodeURIComponent(blob.filename)}"`);
        res.send(blob.pdf);
    } catch (err) {
        log.error("ORAL", `exam-pdf read failed: ${err.message}`);
        res.status(500).json({ error: "failed to read exam" });
    }
});

// Upload do material da prova (PDF ou TXT) → extração das perguntas (modelo
// rápido). PDF vai à OpenAI Files (input_file); TXT entra como texto direto.
router.post("/w/:workToken/oral/exam-pdf", requireWorkToken, requireOral, examUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });
    const name = (req.file.originalname || "").toLowerCase();
    const mime = req.file.mimetype || "";
    const isPdf = mime === "application/pdf" || name.endsWith(".pdf");
    const isTxt = mime === "text/plain" || name.endsWith(".txt");
    if (!isPdf && !isTxt) return res.status(400).json({ error: "envie um arquivo PDF ou TXT" });
    if (isPdf && exceedsPageLimit(req.file.buffer, MAX_ORAL_PDF_PAGES)) {
        return res.status(400).json({ error: `o banco de questões tem mais de ${MAX_ORAL_PDF_PAGES} páginas — envie um PDF menor (limite ${MAX_ORAL_PDF_PAGES}, ~100 perguntas com resposta)` });
    }
    try {
        // Guarda os bytes da fonte (serve de flag has_exam; col. exam_pdf é genérica).
        await db.setExamPdf(req.work.id, req.file.buffer, req.file.originalname);
        // Extrai perguntas + respostas esperadas (gabarito). A rubrica de pontuação é
        // gerada depois, a partir das respostas (OralRubricBuilderAgent).
        let questions;
        if (isTxt) {
            const text = req.file.buffer.toString("utf-8").replace(/^\uFEFF/, "").trim();
            if (!text) return res.status(400).json({ error: "o arquivo .txt está vazio" });
            // Guardrail de custo: o .txt não passava por nenhum teto antes de ir ao
            // modelo (o PDF tem exceedsPageLimit). Dimensionado como o PDF (issues
            // #191/#184): ~65k chars ≈ ~20 páginas ≈ banco de ~100 perguntas com resposta.
            if (text.length > MAX_ORAL_TXT_CHARS) {
                return res.status(400).json({ error: `o banco de questões é muito grande (${text.length} caracteres; limite ${MAX_ORAL_TXT_CHARS}, ~100 perguntas com resposta) — envie um material menor` });
            }
            questions = await oralExamExtractorAgent.extract({ examText: text, meterCtx: { openai: clientForWork(req.work), workId: req.work.id } });
        } else {
            const examFile = await openai.files.create({
                file: await OpenAI.toFile(req.file.buffer, req.file.originalname || "prova.pdf"),
                purpose: "user_data",
            });
            questions = await oralExamExtractorAgent.extract({ examFileId: examFile.id, meterCtx: { openai: clientForWork(req.work), workId: req.work.id } });
        }
        // Peso 1 default; rubrica vazia → rubric_stale=true (o professor gera). Novas
        // (sem id) recebem ids frescos do contador.
        questions = questions.map(q => ({ ...q, rubric: "", weight: 1 }));
        // Guardrail de custo: trunca o banco de questões no teto.
        let truncated = false;
        if (questions.length > MAX_ORAL_QUESTIONS) { questions = questions.slice(0, MAX_ORAL_QUESTIONS); truncated = true; }
        const cleaned = await db.setOralQuestions(req.work.id, questions);
        // Calibração de fala gerada AUTOMÁTICA no upload, em silêncio (o professor não
        // lida com calibração nem vê/edita a frase — some o card de calibração).
        // Best-effort: se falhar, o upload das perguntas NÃO falha.
        let calibrationGenerated = false;
        try {
            const items = cleaned
                .map(q => ({ question: q.question, answer: q.answer }))
                .filter(it => String(it.question || "").trim() || String(it.answer || "").trim());
            if (items.length) {
                const { sentence, key_terms } = await oralCalibrationAgent.build({ items, meterCtx: { openai: clientForWork(req.work), workId: req.work.id } });
                await db.setOralCalibration(req.work.id, { sentence, key_terms });
                calibrationGenerated = true;
            }
        } catch (calErr) {
            log.error("ORAL", `exam calibration auto-gen failed work=${req.work.work_token}: ${calErr.message}`);
        }
        log.info("ORAL", `exam uploaded+extracted work=${req.work.work_token} type=${isTxt ? "txt" : "pdf"} questions=${cleaned.length}`);
        res.json({ ok: true, count: cleaned.length, questions: cleaned, calibration_generated: calibrationGenerated, truncated, max_questions: MAX_ORAL_QUESTIONS });
    } catch (err) {
        log.error("ORAL", `exam-pdf failed: ${err.message}`);
        res.status(500).json({ error: "falha ao processar a prova", detail: err.message });
    }
});

// Config da prova: número de perguntas (N) + voz do examinador.
router.post("/w/:workToken/oral/config", requireWorkToken, requireOral, async (req, res) => {
    const n = Number(req.body?.question_count);
    const voice = req.body?.voice;
    if (!isValidQuestionCount(n)) return res.status(400).json({ error: "question_count inválido (3 a 20)" });
    if (voice != null && voice !== "" && !isValidVoice(voice)) return res.status(400).json({ error: "voz inválida" });
    // #351: a prova oral é Realtime. Voz que só a TTS aceita faz a OpenAI recusar
    // o session.update INTEIRO — e a arguição rodava com o agente padrão dela.
    // Barrar aqui, e não só na UI, porque a rejeição acontece longe daqui.
    if (voice && !isRealtimeVoice(voice)) {
        return res.status(400).json({ error: `a voz "${voice}" não funciona na prova oral (ao vivo) — escolha outra` });
    }
    try {
        await db.setQuestionCount(req.work.id, n);
        if (voice) await db.setWorkVoice(req.work.id, voice);
        log.info("ORAL", `config work=${req.work.work_token} n=${n} voice=${voice || "-"}`);
        res.json({ ok: true, question_count: n, voice: voice || null });
    } catch (err) {
        log.error("ORAL", `config failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar a configuração" });
    }
});

// Perguntas + respostas + rubricas, editadas nos dois editores que COMPARTILHAM a
// mesma lista: a Configuração (enunciado + resposta) e a "Rubrica por questão" na
// aba de avaliação (peso + rubrica). Salva o array COMPLETO. Cada questão carrega
// seu `id` estável; db.setOralQuestions preserva ids, calcula rubric_stale por diff.
router.post("/w/:workToken/oral/questions", requireWorkToken, requireOral, async (req, res) => {
    const raw = Array.isArray(req.body?.questions) ? req.body.questions : null;
    if (!raw) return res.status(400).json({ error: "questions (array) required" });
    if (raw.length > MAX_ORAL_QUESTIONS) return res.status(400).json({ error: `no máximo ${MAX_ORAL_QUESTIONS} questões por prova oral` });
    if (!raw.some(q => String(q?.question || "").trim())) return res.status(400).json({ error: "nenhuma pergunta válida (cada pergunta precisa de enunciado)" });
    try {
        // Salvar é RÁPIDO (sem LLM): só persiste. (A checagem advisory das rubricas
        // não roda mais a cada save — deixava o salvar lento.)
        const cleaned = await db.setOralQuestions(req.work.id, raw);
        log.info("ORAL", `questões salvas work=${req.work.work_token} n=${cleaned.length}`);
        res.json({ ok: true, count: cleaned.length, questions: cleaned });
    } catch (err) {
        log.error("ORAL", `save questions failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar as perguntas" });
    }
});

// Geração de RUBRICAS (a partir das respostas esperadas), em lote — NDJSON, espelha
// evaluate-all. scope=stale → só as pendentes/vazias (com resposta); scope=all →
// todas com resposta (regenera). Requer resposta esperada não-vazia por questão.
router.post("/w/:workToken/oral/rubrics/generate", requireWorkToken, requireOral, requireWithinBudget, async (req, res) => {
    let started = false;
    try {
        const scope = req.query.scope === "all" || req.body?.scope === "all" ? "all" : "stale";
        const all = await db.getOralQuestions(req.work.id);
        // exclude (#193): ids que o professor DESMARCOU no "pendentes" (manter a
        // rubrica atual mesmo estando stale). Só afeta scope=stale (no "todas" o
        // cliente não envia exclude).
        const excludeIds = new Set(String(req.query.exclude || "").split(",").map(s => parseInt(s, 10)).filter(Number.isInteger));
        const targets = all.filter(q => String(q.answer || "").trim()
            && (scope === "all" || q.rubric_stale || !questionHasRubric(q))
            && !excludeIds.has(q.id));
        // COTA (#192): confere ANTES de qualquer chamada ao modelo. Só rubricas
        // NOVAS debitam (regerar existente não conta). Saldo insuficiente → NÃO
        // começa e informa quantas faltam. Sem teto configurado = ilimitado.
        const consumes = rubricsThatConsume(targets);
        const quota = rubricQuota(all);
        if (quota.limit != null && consumes > quota.remaining) {
            return res.status(402).json({
                error: "rubric_quota_exceeded",
                needed: consumes, remaining: quota.remaining, limit: quota.limit, used: quota.used,
                candidates: targets.length,
            });
        }
        const quotaInfo = {
            limit: quota.limit, used: quota.used, will_consume: consumes,
            remaining_after: quota.limit == null ? null : quota.remaining - consumes,
        };
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        started = true;
        const send = (o) => res.write(JSON.stringify(o) + "\n");
        send({ type: "start", ids: targets.map(q => q.id), candidates: targets.length, quota: quotaInfo });
        let generated = 0; const errors = [];
        // Fatia em BLOCOS (#194): cada bloco é UMA chamada ao modelo que devolve N
        // rubricas amarradas por id. Concorrência de BLOCOS (não de questões).
        // Progresso segue item a item (o professor não percebe o bloco) e a falha
        // de um bloco não derruba os outros — os itens do bloco voltam como erro.
        const blocks = [];
        for (let i = 0; i < targets.length; i += ORAL_RUBRIC_BLOCK_SIZE) blocks.push(targets.slice(i, i + ORAL_RUBRIC_BLOCK_SIZE));
        await mapPool(blocks, 4, async (block) => {
            try {
                const rubrics = await oralRubricBuilderAgent.buildBatch({
                    items: block.map(q => ({ id: q.id, question: q.question, answer: q.answer })),
                    meterCtx: { openai: clientForWork(req.work), workId: req.work.id },
                });
                const byId = new Map(rubrics.map(r => [r.id, r]));
                for (const q of block) {
                    const r = byId.get(q.id);
                    if (r) {
                        await db.updateOralQuestionRubric(req.work.id, q.id, { rubric_levels: r.rubric_levels, weight: r.weight });
                        generated++;
                        send({ type: "item", id: q.id, ok: true });
                    } else {
                        errors.push({ id: q.id, error: "rubrica não retornada" });
                        send({ type: "item", id: q.id, ok: false, error: "rubrica não retornada" });
                    }
                }
            } catch (e) {
                log.error("ORAL", `rubric gen block failed (${block.map(q => q.id).join(",")}): ${e.message}`);
                for (const q of block) {
                    errors.push({ id: q.id, error: e.message });
                    send({ type: "item", id: q.id, ok: false, error: e.message });
                }
            }
        });
        const questions = await db.getOralQuestions(req.work.id);
        log.info("ORAL", `rubrics generate work=${req.work.work_token} scope=${scope} geradas=${generated}/${targets.length}`);
        send({ type: "done", generated, candidates: targets.length, consumed: consumes, errors, questions, quota: quotaInfo });
        res.end();
    } catch (err) {
        log.error("ORAL", `rubrics generate failed: ${err.message}`);
        if (started) { try { res.end(); } catch {} return; }
        res.status(500).json({ error: "falha ao gerar rubricas", detail: err.message });
    }
});

// Geração de rubrica de UMA questão (botão por linha). Requer resposta esperada.
router.post("/w/:workToken/oral/questions/:qid/rubric/generate", requireWorkToken, requireOral, requireWithinBudget, async (req, res) => {
    try {
        const qid = Number(req.params.qid);
        const q = (await db.getOralQuestions(req.work.id)).find(x => Number(x.id) === qid);
        if (!q) return res.status(404).json({ error: "questão não encontrada" });
        if (!String(q.answer || "").trim()) return res.status(409).json({ error: "esta questão não tem resposta esperada — escreva a rubrica à mão ou preencha a resposta" });
        const { rubric_levels, weight } = await oralRubricBuilderAgent.build({ question: q.question, answer: q.answer, meterCtx: { openai: clientForWork(req.work), workId: req.work.id } });
        const updated = await db.updateOralQuestionRubric(req.work.id, qid, { rubric_levels, weight });
        res.json({ ok: true, question: updated });
    } catch (err) {
        log.error("ORAL", `rubric gen (single) failed: ${err.message}`);
        res.status(500).json({ error: "falha ao gerar a rubrica", detail: err.message });
    }
});

// --- Frase de CALIBRAÇÃO DE FALA (pré-teste de captação). Salvar (edição do
// professor) e Gerar (a partir das perguntas/respostas). Vazio = pré-teste
// desligado para o trabalho. ---
router.post("/w/:workToken/oral/calibration", requireWorkToken, requireOral, express.json({ limit: "16kb" }), async (req, res) => {
    try {
        const saved = await db.setOralCalibration(req.work.id, {
            sentence: String(req.body?.sentence ?? ""),
            key_terms: Array.isArray(req.body?.key_terms) ? req.body.key_terms : [],
        });
        log.info("ORAL", `calibration saved work=${req.work.work_token} ${saved ? "on" : "off"}`);
        res.json({ ok: true, calibration: saved });
    } catch (err) {
        log.error("ORAL", `save calibration failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar a frase de calibração" });
    }
});
router.post("/w/:workToken/oral/calibration/generate", requireWorkToken, requireOral, requireWithinBudget, async (req, res) => {
    try {
        const qs = await db.getOralQuestions(req.work.id);
        const items = qs
            .map(q => ({ question: q.question, answer: q.answer }))
            .filter(it => String(it.question || "").trim() || String(it.answer || "").trim());
        if (!items.length) return res.status(409).json({ error: "a prova não tem perguntas para extrair termos" });
        const { sentence, key_terms } = await oralCalibrationAgent.build({ items, meterCtx: { openai: clientForWork(req.work), workId: req.work.id } });
        const saved = await db.setOralCalibration(req.work.id, { sentence, key_terms });
        log.info("ORAL", `calibration generated work=${req.work.work_token} terms=${key_terms.length}`);
        res.json({ ok: true, calibration: saved });
    } catch (err) {
        log.error("ORAL", `gen calibration failed: ${err.message}`);
        res.status(500).json({ error: "falha ao gerar a frase de calibração", detail: err.message });
    }
});

// --- Avaliação por aluno (professor) — espelha a entrevista, mas a devolutiva
// e a nota são MANUAIS (sem geração por IA). A avaliação compara a transcrição
// das respostas do aluno com o gabarito. ---

router.post("/w/:workToken/oral/submissions/:subToken/evaluate", requireWorkToken, requireProfessorSubmission, requireWithinBudget, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const [asked, detail, workQ] = await Promise.all([
            db.getOralAsked(req.submission.id),
            db.getOralSubmissionDetail(req.submission.id),
            db.getOralQuestions(req.work.id),
        ]);
        // Avalia SÓ as perguntas feitas a este aluno (fallback: todas, p/ provas
        // antigas), enriquecidas com a rubrica + peso ATUAIS do trabalho (por id).
        const byId = {}; for (const q of workQ) byId[q.id] = q;
        const questions = (asked && asked.length ? asked : workQ)
            .map(q => byId[q.id] ? { ...q, rubric: byId[q.id].rubric, rubric_levels: byId[q.id].rubric_levels, weight: byId[q.id].weight } : { ...q, weight: Number(q.weight) > 0 ? Number(q.weight) : 1 });
        const transcript = Array.isArray(detail?.oral_transcript) ? detail.oral_transcript : [];
        if (!questions.length) return res.status(409).json({ error: "a prova não tem perguntas" });
        if (!transcript.length) return res.status(409).json({ error: "sem transcrição — o aluno ainda não realizou a prova" });
        const semRubrica = questions.filter(q => !questionHasRubric(q));
        if (semRubrica.length) return res.status(409).json({ error: `gere ou escreva a rubrica de ${semRubrica.length} questão(ões) antes de avaliar (aba Avaliação & notas)` });
        // Corte 4 (#289): a retranscrição de auditoria entra como fonte de maior
        // fidelidade da fala do aluno (a conversa ao vivo segue dando a ordem e
        // as falas do examinador). Sessão retomada (multi-parte) = tee cobre só
        // o último trecho -> o bloco cai para o texto contínuo.
        const audit = buildAuditBlock({
            final: detail?.final_transcript,
            multiPart: Array.isArray(detail?.oral_video_parts) && detail.oral_video_parts.length > 1,
        });
        const report = await oralExamEvaluatorAgent.evaluate({
            questions, transcript, auditBlock: auditPromptBlock(audit),
            meterCtx: { openai: clientForWork(req.work), workId: req.work.id, submissionId: req.submission.id },
        });
        await db.setOralEvaluation(req.submission.id, report);
        await applyEvalDefaults(req.work, req.submission.id, detail, report, questions); // nota default (+ penalidade)
        const grades = await db.getSubmissionGrades(req.submission.id); // já com penalidade, se ligada
        res.json({ ok: true, evaluation: report, grade: grades?.final ?? null, grades });
    } catch (err) {
        log.error("ORAL", `evaluate failed: ${err.message}`);
        res.status(500).json({ error: "falha ao avaliar", detail: err.message });
    }
});

router.get("/w/:workToken/oral/submissions/:subToken", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const [d, grades, asked, workQ] = await Promise.all([
            db.getOralSubmissionDetail(req.submission.id),
            db.getSubmissionGrades(req.submission.id),
            db.getOralAsked(req.submission.id),
            db.getOralQuestions(req.work.id),
        ]);
        // Questões feitas a este aluno, enriquecidas com peso/enunciado atuais (por
        // id) — usadas p/ semear o grid de nota manual antes de avaliar.
        const wById = {}; for (const q of workQ) wById[q.id] = q;
        const questions = (asked && asked.length ? asked : workQ).map(q => ({
            id: q.id, question: (wById[q.id]?.question ?? q.question) || "",
            weight: Number(wById[q.id]?.weight) > 0 ? Number(wById[q.id].weight) : (Number(q.weight) > 0 ? Number(q.weight) : 1),
        }));
        // Número de exibição por questão = POSIÇÃO na lista completa (1..N), igual ao
        // que o professor vê nos editores. Assim o relatório do aluno bate com a rubrica.
        const question_numbers = {}; workQ.forEach((q, i) => { question_numbers[q.id] = i + 1; });
        res.set("Cache-Control", "no-store");
        res.json({
            question_numbers,
            work_name: req.work.name,
            student_label: req.submission.student_label,
            completion_reason: d?.completion_reason || null,
            has_oral_video: !!d?.has_oral_video,
            transcript: Array.isArray(d?.oral_transcript) ? d.oral_transcript : [],
            // Retranscrição de auditoria (#289): o texto do áudio contínuo do tee,
            // em CONVIVÊNCIA com o transcript ao vivo (não substitui a avaliação).
            final_transcript: d?.final_transcript || null,
            evaluation: d?.oral_eval_json || null,
            devolutiva: d?.oral_devolutiva || "",
            grade: d?.grade_final ?? null,
            grades: grades || null,
            questions,
            devolutiva_published: !!d?.evaluation_published_at,
            grade_published: !!d?.grade_published_at,
            proctor: d?.oral_proctor_json || null,
            voice: d?.oral_voice_json || null,
            calibration: d?.oral_calibration_json || null,
            student_comment: d?.student_comment || null,
            feedback_guidelines: req.work.feedback_guidelines || "",
        });
    } catch (err) { log.error("ORAL", `detail failed: ${err.message}`); res.status(500).json({ error: "falha ao carregar" }); }
});

router.put("/w/:workToken/oral/submissions/:subToken/devolutiva", requireWorkToken, requireProfessorSubmission, express.json({ limit: "64kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try { await db.setOralDevolutiva(req.submission.id, String(req.body?.text ?? "")); res.json({ ok: true }); }
    catch (err) { log.error("ORAL", `devolutiva failed: ${err.message}`); res.status(500).json({ error: "falha ao salvar devolutiva" }); }
});

// Gera a devolutiva de UM aluno via LLM (StudentFeedbackAgent), a partir da
// avaliação + diretrizes. Espelha /student-version da entrevista, inclusive o
// override ad-hoc: body { guidelines: string|null } vale SÓ para esta geração
// (não altera o padrão do trabalho). Sem o campo, usa as diretrizes do trabalho.
// Com ?force=1 sobrescreve a devolutiva atual; sem force, exige que esteja vazia.
router.post("/w/:workToken/oral/submissions/:subToken/devolutiva/derive", requireWorkToken, requireProfessorSubmission, requireWithinBudget, express.json({ limit: "32kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    const force = req.query.force === "1" || req.body?.force === true;
    const hasOverride = req.body && Object.prototype.hasOwnProperty.call(req.body, "guidelines");
    const rawOverride = req.body?.guidelines;
    if (hasOverride && rawOverride !== null && typeof rawOverride !== "string") {
        return res.status(400).json({ error: "guidelines deve ser string ou null" });
    }
    const guidelinesOverride = hasOverride
        ? (typeof rawOverride === "string" && rawOverride.trim() ? rawOverride.trim() : null)
        : undefined;
    try {
        const r = await deriveOralDevolutivaNow(req.work, req.submission.id, { force, guidelinesOverride });
        if (r.reason === "no_eval") return res.status(409).json({ error: "avalie a prova antes de gerar a devolutiva" });
        const d = await db.getOralSubmissionDetail(req.submission.id);
        res.json({ ok: true, generated: !!r.generated, devolutiva: d?.oral_devolutiva || "" });
    } catch (err) {
        log.error("ORAL", `devolutiva derive failed: ${err.message}`);
        res.status(500).json({ error: "falha ao gerar a devolutiva", detail: err.message });
    }
});


// Edição manual dos scores por questão (grid de nota). Sobrescreve os scores em
// grades_json, marca como manual, recomputa a nota final ponderada.
router.put("/w/:workToken/oral/submissions/:subToken/grades", requireWorkToken, requireProfessorSubmission, express.json({ limit: "16kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    const scores = Array.isArray(req.body?.scores) ? req.body.scores : null;
    if (!scores) return res.status(400).json({ error: "scores (array) required" });
    try {
        let grades = await db.getSubmissionGrades(req.submission.id);
        if (!grades || !Array.isArray(grades.criteria)) {
            // Sem cálculo automático: semeia as questões (feitas ao aluno) com notas
            // em branco para o professor lançar à mão. Pesos = os atuais do trabalho.
            const [asked, workQ] = await Promise.all([db.getOralAsked(req.submission.id), db.getOralQuestions(req.work.id)]);
            const wById = {}; for (const q of workQ) wById[q.id] = Number(q.weight) > 0 ? Number(q.weight) : 1;
            const base = (asked && asked.length ? asked : workQ);
            if (!base.length) return res.status(409).json({ error: "a prova não tem perguntas" });
            grades = {
                criteria: base.map(q => ({ id: q.id, name: q.question, weight: wById[q.id] != null ? wById[q.id] : 1, score: null, justification: "" })),
                final: null, computed_at: new Date().toISOString(),
            };
        }
        const byId = {};
        for (const s of scores) { const v = Number(s.score); if (Number.isFinite(v)) byId[s.id] = Math.max(0, Math.min(10, Math.round(v * 10) / 10)); }
        const criteria = grades.criteria.map(c => (byId[c.id] != null ? { ...c, score: byId[c.id], manual: true } : c));
        const updated = { ...grades, criteria, final: weightedFinal(criteria) };
        await db.setSubmissionGrades(req.submission.id, updated);
        res.json({ ok: true, grades: updated });
    } catch (err) { log.error("ORAL", `grades edit failed: ${err.message}`); res.status(500).json({ error: "falha ao salvar notas" }); }
});

router.post("/w/:workToken/oral/submissions/:subToken/publish", requireWorkToken, requireProfessorSubmission, express.json({ limit: "8kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        // A devolutiva é publicada/despublicada JUNTO com a nota (#207): a flag `grade`
        // move as duas colunas. `devolutiva` isolada foi mantida por compat, mas a UI
        // não a envia mais.
        if (typeof req.body?.grade === "boolean") {
            await db.publishOralGrade(req.submission.id, req.body.grade);
            await db.publishOralDevolutiva(req.submission.id, req.body.grade);
        } else if (typeof req.body?.devolutiva === "boolean") {
            await db.publishOralDevolutiva(req.submission.id, req.body.devolutiva);
        }
        res.json({ ok: true });
    } catch (err) { log.error("ORAL", `publish failed: ${err.message}`); res.status(500).json({ error: "falha ao publicar" }); }
});

// Submissões cuja análise de proctoring está EM ANDAMENTO agora (in-memory, por
// token). Alimenta a ampulheta do batch: distingue "analisando agora" de "tem
// vídeo mas sem análise" — este último (prova antiga cujo upload foi antes do
// disparo automático, ou análise que falhou) NÃO deve ficar com spinner eterno.

// Dispara a análise de vídeo pós-upload (#209): entra na FILA GLOBAL (#262), que
// serializa, deduplica e persiste o estado. Fire-and-forget.
function runOralProctorAuto(submissionId, token) {
    enqueueProctor(submissionId, { priority: "auto", tokenForLog: token }).catch(() => {});
}

// Reprocessar a análise de UMA prova (botão ao lado do 'falhou' no painel, #264).
// Não roda inline: ENFILEIRA com prioridade manual (fura fila sobre o automático)
// e responde na hora — o painel acompanha pelo proctor_state do /oral/info.
router.post("/w/:workToken/oral/submissions/:subToken/proctor", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const parts = await db.getOralVideoParts(req.submission.id);
        if (!parts.length) return res.status(409).json({ error: "esta prova não tem vídeo gravado" });
        enqueueProctor(req.submission.id, { priority: "manual", tokenForLog: req.submission.submission_token }).catch(() => {});
        res.status(202).json({ ok: true, queued: true });
    } catch (err) {
        log.error("ORAL", `proctor enqueue failed: ${err.message}`);
        res.status(500).json({ error: "falha ao enfileirar a análise", detail: err.message });
    }
});

// --- Lote (professor): avaliar todas + publicar/despublicar em massa ---

// Avalia todas as provas realizadas. Sem ?force, pula as que já têm relatório;
// com ?force=1, reavalia todas. Sequencial (uma chamada de LLM por aluno).
router.post("/w/:workToken/oral/evaluate-all", requireWorkToken, requireOral, requireWithinBudget, async (req, res) => {
    let started = false; // se já mandamos headers (streaming), não dá mais p/ responder 500
    try {
        const force = req.query.force === "1" || req.body?.force === true;
        const allQuestions = await db.getOralQuestions(req.work.id);
        if (!allQuestions.length) return res.status(409).json({ error: "a prova não tem perguntas" });
        const byId = {}; for (const q of allQuestions) byId[q.id] = q;
        const subs = await db.listOralSubmissionsForEval(req.work.id, force);

        // Streaming NDJSON: uma linha JSON por evento, sobre o mesmo POST. O cliente
        // põe ampulheta nas linhas anunciadas em "start" e troca cada uma pela nota
        // assim que o respectivo "item" chega. Como os headers já vão cedo, erros
        // depois do start são tratados por item (não dá p/ mandar status 500).
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        started = true;
        const send = (obj) => res.write(JSON.stringify(obj) + "\n");
        send({ type: "start", tokens: subs.map(s => s.submission_token) });

        let evaluated = 0;
        const errors = [];
        // Avalia em PARALELO com concorrência limitada (mapPool): cada avaliação é
        // uma chamada de raciocínio de dezenas de segundos; em série, N alunos =
        // N×esse tempo. O pool reduz o tempo de parede ~Nx sem disparar todas de
        // uma vez (evita estourar limite de taxa da OpenAI). A fn faz o `send` por
        // item (streaming), então trata o próprio erro.
        const ORAL_EVAL_CONCURRENCY = 4;
        await mapPool(subs, ORAL_EVAL_CONCURRENCY, async (s) => {
            try {
                const [asked, detail] = await Promise.all([db.getOralAsked(s.id), db.getOralSubmissionDetail(s.id)]);
                // só as perguntas feitas a este aluno, com rubrica + peso atuais (por id)
                const questions = (asked && asked.length ? asked : allQuestions)
                    .map(q => byId[q.id] ? { ...q, rubric: byId[q.id].rubric, rubric_levels: byId[q.id].rubric_levels, weight: byId[q.id].weight } : { ...q, weight: Number(q.weight) > 0 ? Number(q.weight) : 1 });
                const transcript = Array.isArray(detail?.oral_transcript) ? detail.oral_transcript : [];
                if (!transcript.length) {
                    // Item pulado: avisa o cliente p/ tirar a ampulheta dessa linha.
                    send({ type: "item", submission_token: s.submission_token, ok: false, error: "sem transcrição" });
                    return;
                }
                if (questions.some(q => !questionHasRubric(q))) {
                    send({ type: "item", submission_token: s.submission_token, ok: false, error: "rubrica faltando" });
                    return;
                }
                // Corte 4 (#289): retranscrição de auditoria como fonte de maior
                // fidelidade da fala do aluno (mesmo desenho da rota individual).
                const audit = buildAuditBlock({
                    final: detail?.final_transcript,
                    multiPart: Array.isArray(detail?.oral_video_parts) && detail.oral_video_parts.length > 1,
                });
                const report = await oralExamEvaluatorAgent.evaluate({
                    questions, transcript, auditBlock: auditPromptBlock(audit),
                    meterCtx: { openai: clientForWork(req.work), workId: req.work.id, submissionId: s.id },
                });
                await db.setOralEvaluation(s.id, report);
                await applyEvalDefaults(req.work, s.id, detail, report, questions); // nota default (+ penalidade)
                evaluated++;
                // Lê a nota efetivamente gravada (applyEvalDefaults não sobrescreve
                // ajuste manual do professor, então o default pode não valer).
                const after = await db.getOralSubmissionDetail(s.id);
                send({ type: "item", submission_token: s.submission_token, ok: true, has_oral_eval: true, grade: after?.grade_final ?? null });
            } catch (e) {
                errors.push({ submission: s.submission_token, label: s.student_label, error: e.message });
                log.error("ORAL", `evaluate-all item failed sub=${s.submission_token}: ${e.message}`);
                send({ type: "item", submission_token: s.submission_token, ok: false, error: e.message });
            }
        });
        log.info("ORAL", `evaluate-all work=${req.work.work_token} avaliadas=${evaluated}/${subs.length} force=${force} conc=${ORAL_EVAL_CONCURRENCY}`);
        send({ type: "done", evaluated, candidates: subs.length, errors });
        res.end();
    } catch (err) {
        log.error("ORAL", `evaluate-all failed: ${err.message}`);
        if (started) { try { res.end(); } catch {} return; } // headers já enviados: só encerra
        res.status(500).json({ error: "falha na avaliação em lote", detail: err.message });
    }
});

// Lote: gera as devolutivas (LLM) das provas já avaliadas. Sem force, pula quem
// já tem devolutiva escrita; com ?force=1, regenera todas. Concorrência limitada,
// streaming NDJSON como o evaluate-all.
router.post("/w/:workToken/oral/evaluations/student-versions", requireWorkToken, requireOral, requireWithinBudget, async (req, res) => {
    let started = false;
    try {
        const force = req.query.force === "1" || req.body?.force === true;
        const subs = await db.listOralSubmissionsForDevolutiva(req.work.id, force);
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
        started = true;
        const send = (obj) => res.write(JSON.stringify(obj) + "\n");
        send({ type: "start", tokens: subs.map(s => s.submission_token) });

        let generated = 0;
        const errors = [];
        const CONC = 4;
        await mapPool(subs, CONC, async (s) => {
            try {
                const r = await deriveOralDevolutivaNow(req.work, s.id, { force });
                if (r.generated) generated++;
                send({ type: "item", submission_token: s.submission_token, ok: true, generated: !!r.generated, skipped: !!r.skipped });
            } catch (e) {
                errors.push({ submission: s.submission_token, label: s.student_label, error: e.message });
                log.error("ORAL", `student-versions item failed sub=${s.submission_token}: ${e.message}`);
                send({ type: "item", submission_token: s.submission_token, ok: false, error: e.message });
            }
        });
        log.info("ORAL", `student-versions work=${req.work.work_token} geradas=${generated}/${subs.length} force=${force}`);
        send({ type: "done", generated, candidates: subs.length, errors });
        res.end();
    } catch (err) {
        log.error("ORAL", `student-versions failed: ${err.message}`);
        if (started) { try { res.end(); } catch {} return; }
        res.status(500).json({ error: "falha ao gerar devolutivas em lote", detail: err.message });
    }
});

// Publica/despublica notas em massa — a devolutiva vai JUNTO (#207). Corpo:
// {target:'grade', on:bool}. 'devolutiva' isolado mantido por compat (a UI só usa 'grade').
router.post("/w/:workToken/oral/publish-all", requireWorkToken, requireOral, express.json({ limit: "8kb" }), async (req, res) => {
    const target = req.body?.target;
    const on = req.body?.on === true;
    if (target !== "devolutiva" && target !== "grade") return res.status(400).json({ error: "target inválido (devolutiva|grade)" });
    try {
        let affected;
        if (target === "grade") {
            affected = await db.publishAllOralGrade(req.work.id, on);
            await db.publishAllOralDevolutiva(req.work.id, on); // devolutiva acompanha a nota
        } else {
            affected = await db.publishAllOralDevolutiva(req.work.id, on);
        }
        log.info("ORAL", `publish-all work=${req.work.work_token} target=${target} on=${on} affected=${affected}`);
        res.json({ ok: true, affected });
    } catch (err) {
        log.error("ORAL", `publish-all failed: ${err.message}`);
        res.status(500).json({ error: "falha ao publicar em lote" });
    }
});

// (removido, issue #262) O lote "Analisar vídeos" (proctor-all) saiu: a análise é
// automática ao fim de cada prova (fila global em lib/proctorQueue.js) e o legado
// sem relatório é re-enfileirado na reconciliação do boot. Reprocesso individual:
// POST /oral/submissions/:subToken/proctor (acima).

// --- Lado do ALUNO (Realtime) ---


// Cria um client secret EFÊMERO da OpenAI Realtime, com a sessão já configurada
// (modelo, voz, instruções com as perguntas, VAD de servidor, transcrição da
// fala do aluno). A nossa OPENAI_API_KEY nunca vai ao navegador — só o segredo
// efêmero de ~1 min. Usamos fetch cru para não acoplar à versão do SDK.
async function mintRealtimeSecret({ instructions, voice, apiKey = process.env.OPENAI_API_KEY }) {
    const body = {
        session: {
            type: "realtime",
            model: REALTIME_MODEL,
            instructions,
            audio: {
                input: {
                    // Redução de ruído antes do VAD (barulho ambiente não dispara corte falso).
                    noise_reduction: { type: "far_field" },
                    transcription: { model: "gpt-4o-transcribe" },
                    // VAD semântico paciente: tolera pausas para pensar e ignora ruído
                    // breve antes de assumir fala.
                    turn_detection: { type: "semantic_vad", eagerness: "low" },
                },
                output: { voice },
            },
        },
    };
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`realtime client_secret ${r.status}: ${text.slice(0, 400)}`);
    let j; try { j = JSON.parse(text); } catch { throw new Error("realtime client_secret: resposta não-JSON"); }
    // Defensivo quanto ao shape entre versões da API.
    const value = j.value || j.client_secret?.value || j.client_secret;
    if (!value) throw new Error("realtime client_secret: sem 'value' na resposta");
    return { value, expires_at: j.expires_at || j.client_secret?.expires_at || null };
}

// Inicia uma prova: sorteia N perguntas, monta a sessão e devolve o segredo
// efêmero para o navegador abrir o WebRTC direto com a OpenAI.
router.post("/s/:submissionToken/oral/session", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") {
        return res.status(400).json({ error: "este trabalho não é uma prova oral" });
    }
    try {
        const all = await db.getOralQuestions(req.work.id);
        if (!all.length) return res.status(409).json({ error: "a prova ainda não foi preparada pelo professor (sem perguntas)" });
        const n = Math.min(req.work.question_count || all.length, all.length);
        const sampled = sampleKeepingOrder(all, n);
        // #351: incompatível com Realtime cai no fallback em vez de derrubar a sessão
        const voice = isRealtimeVoice(req.work.voice) ? req.work.voice : FALLBACK_VOICE;
        const instructions = buildExamInstructions(sampled, req.work.name);
        const secret = await mintRealtimeSecret({ instructions, voice, apiKey: apiKeyForWork(req.work) });
        log.info("ORAL", `session minted submission=${req.submission.submission_token} n=${n}/${all.length} voice=${voice}`);
        res.json({
            client_secret: secret.value,
            expires_at: secret.expires_at,
            model: REALTIME_MODEL,
            voice,
            total_questions: n,
        });
    } catch (err) {
        log.error("ORAL", `session failed: ${err.message}`);
        res.status(502).json({ error: "falha ao iniciar a sessão de voz", detail: err.message });
    }
});

// Status para a página do aluno: já realizou a prova? (teste nunca trava).
// resume_blocked (#260): a sessão anterior caiu com fala do aluno e o professor
// ainda não liberou a retomada — a página mostra a tela de pausa em vez de
// tentar conectar (o upgrade do WS rejeitaria de qualquer forma).
router.get("/s/:submissionToken/oral/status", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    const done = !!req.submission.completion_reason && !req.submission.is_test;
    let resumeBlocked = false;
    if (!done && !req.submission.is_test) {
        try {
            const prior = (await db.getOralTranscript(req.submission.id)) || [];
            const speechEvents = await db.getStudentSpeechEvents(req.submission.id).catch(() => 0);
            resumeBlocked = wouldResume({ isTest: false, priorTranscript: prior, speechEvents })
                && !(await db.hasResumeAllowance(req.submission.id));
        } catch {}
    }
    // completed: tentativa concluída, independente de is_test — o teste não
    // "fecha" (refazível de propósito), mas a página usa isto p/ cair na
    // REVISÃO como o aluno, com "Refazer o teste" explícito (#340).
    res.json({ done, is_test: !!req.submission.is_test, completed: !!req.submission.completion_reason, resume_blocked: resumeBlocked });
});

// --- Calibração de fala (pré-teste de captação, ANTES da sessão de voz) ---
// Config p/ a tela do aluno: a frase-alvo a ler e quantas tentativas. Sem frase
// no trabalho, enabled=false → o aluno pula direto para a prova (fail-open).
router.get("/s/:submissionToken/oral/calibrate-config", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const calib = await db.getOralCalibration(req.work.id);
        // Estado atual da escada (#288): a página do aluno precisa dele no reload
        // (um vermelho de ontem continua vermelho hoje, até liberar ou re-testar).
        const prev = (await db.getOralSubmissionDetail(req.submission.id))?.oral_calibration_json || null;
        res.set("Cache-Control", "no-store");
        res.json({
            enabled: !!calib, sentence: calib?.sentence || null, max_attempts: MAX_CALIB_ATTEMPTS,
            sound_check: ladderState(prev),
            // Adendo ADR 0023: o teste (leitura + eco) e obrigatorio para seguir.
            sound_check_pending: !!calib && soundCheckPending(prev, MAX_CALIB_ATTEMPTS),
            // Wizard guiado por voz (#321): reentrada no estágio certo pós-reload.
            sound_check_progress: soundCheckProgress(prev, MAX_CALIB_ATTEMPTS),
        });
    } catch (err) { log.error("ORAL", `calibrate-config failed: ${err.message}`); res.status(500).json({ error: "falha" }); }
});

// Recebe a repetição gravada do aluno, transcreve (o MESMO gpt-4o-transcribe da
// correção) e pontua contra a frase-alvo. NUNCA bloqueia: após MAX_CALIB_ATTEMPTS
// o aluno segue mesmo assim; o resultado fica registrado para o professor.
const CALIB_ADVICE = "Fale em volume médio, num ritmo tranquilo (sem correr) e sem cortar o fim das palavras — assim a captação transcreve melhor a sua fala.";
router.post("/s/:submissionToken/oral/calibrate", requireSubmissionToken, calibUpload.single("file"), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const calib = await db.getOralCalibration(req.work.id);
        if (!calib) return res.status(409).json({ error: "sem frase de calibração" });
        if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: "file required" });
        let attempt = Number(req.body?.attempt);
        if (!Number.isInteger(attempt) || attempt < 1) attempt = 1;
        if (attempt > MAX_CALIB_ATTEMPTS) attempt = MAX_CALIB_ATTEMPTS;

        // Extensão pelo mimetype real: MediaRecorder varia por navegador (webm no
        // Chrome/Firefox, mp4/m4a no Safari) e o STT infere o formato pela extensão.
        // SILÊNCIO não é erro de infra (#313): o STT devolve transcrição vazia e a
        // camada lança "empty transcription" — isso é LEITURA REPROVADA (wer=1),
        // conta tentativa e mantém o gate. Erro real de infra segue como 500
        // (fail-open do cliente, restrito de fato à infra — ADR 0023).
        let text = "";
        try {
            ({ text } = await sttTranscribe({ openaiClient: clientForWork(req.work), buffer: req.file.buffer, filename: `calib.${extFromMimetype(req.file.mimetype)}` }));
        } catch (err) {
            if (!/empty transcription/i.test(String(err.message))) throw err;
        }
        const silent = !text.trim();
        const { ok, wer, missedTerms } = scoreCalibration({ target: calib.sentence, keyTerms: calib.key_terms || [], hypothesis: text });

        // Acumula o registro (todas as tentativas) para o professor.
        const prev = (await db.getOralSubmissionDetail(req.submission.id))?.oral_calibration_json || null;
        const transcripts = (Array.isArray(prev?.transcripts) ? prev.transcripts : []).slice(-3);
        transcripts.push({ attempt, wer: wer == null ? null : Math.round(wer * 1000) / 1000, missed: missedTerms, text });
        const worst = Math.max(Number(prev?.worst_wer) || 0, wer == null ? 0 : wer);
        const patch = {
            passed: ok || prev?.passed === true,
            attempts: attempt,
            worst_wer: Math.round(worst * 1000) / 1000,
            missed_terms: missedTerms,
            target: calib.sentence,
            transcripts,
            updated_at: new Date().toISOString(),
        };
        // Sinal de HFP (#288): detectado no NAVEGADOR (rótulo do dispositivo +
        // penhasco espectral) e reportado junto da gravação. Sempre aviso, nunca
        // bloqueio por si só — heurística não bloqueia.
        const hfp = parseHfp(req.body?.hfp);
        if (hfp) patch.hfp = hfp;
        await db.setOralCalibrationResult(req.submission.id, patch);

        const state = ladderState({ ...(prev || {}), ...patch });
        log.info("ORAL", `calibrate submission=${req.submission.submission_token} attempt=${attempt} ok=${ok} wer=${wer == null ? "—" : wer.toFixed(2)} missed=${missedTerms.length} escada=${state?.state || "—"}`);
        res.json({
            ok, attempt, attempts_left: Math.max(0, MAX_CALIB_ATTEMPTS - attempt),
            wer, missed_terms: missedTerms, transcript: text,
            advice: ok ? null : (silent ? "Não ouvi nenhuma fala na gravação. Verifique se o microfone certo está selecionado e leia a frase em voz alta." : CALIB_ADVICE),
            sound_check: state,
            sound_check_pending: soundCheckPending({ ...(prev || {}), ...patch }, MAX_CALIB_ATTEMPTS),
        });
    } catch (err) {
        log.error("ORAL", `calibrate failed: ${err.message}`);
        res.status(500).json({ error: "falha ao verificar a captação", detail: err.message });
    }
});

// --- Sound check v2 (#288): teste de ECO ---
// A voz do examinador toca no aluno (em silêncio); se os marcadores da frase
// voltam pelo microfone, o eco é real. Frase fixa, TTS na voz do trabalho,
// cache em memória (mesmo padrão do setup-audio da entrevista).
const echoAudioCache = new Map(); // voice -> Buffer mp3
router.get("/s/:submissionToken/oral/echo-audio", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const voice = req.work.voice || "coral";
        let buf = echoAudioCache.get(voice);
        if (!buf) { buf = await synthesizeSpeech(clientForWork(req.work), TTS_MODEL, ECHO_SENTENCE, voice); echoAudioCache.set(voice, buf); }
        res.type("audio/mpeg").send(buf);
    } catch (err) {
        log.error("ORAL", `echo-audio failed: ${err.message}`);
        res.status(500).json({ error: "falha ao gerar o áudio do teste de eco" });
    }
});

router.post("/s/:submissionToken/oral/echo-check", requireSubmissionToken, calibUpload.single("file"), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        if (!req.file || !req.file.buffer?.length) return res.status(400).json({ error: "file required" });
        // Silêncio quase puro faz o STT devolver vazio — sem texto = sem eco (ok).
        // Erro REAL de STT (arquivo rejeitado, provedor fora) NÃO é "sem eco":
        // registrar teste limpo aqui era verde fingido (#328) — devolve 502 sem
        // contar o teste; o cliente retenta e, na 2ª falha, segue em fail-open.
        let text = "";
        try {
            ({ text } = await sttTranscribe({ openaiClient: clientForWork(req.work), buffer: req.file.buffer, filename: `echo.${extFromMimetype(req.file.mimetype)}` }));
        } catch (err) {
            if (!/empty transcription/i.test(String(err.message))) {
                log.error("ORAL", `echo-check stt falhou: ${err.message}`);
                return res.status(502).json({ error: "stt indisponível no teste de eco" });
            }
        }
        // Wizard (#321): a voz-guia é a sonda — o cliente informa QUAL roteiro
        // tocou durante a captura e o vazamento é medido contra o texto
        // conhecido. Sem `script`, vale o caminho legado (frase de marcadores).
        const scriptKey = String(req.body?.script || "");
        const scriptText = SC_SCRIPTS[scriptKey] || null;
        const matches = scriptText ? scriptLeakMatches(text, scriptText) : countEchoMatches(text);
        const leak = matches >= (scriptText ? SCRIPT_LEAK_MIN : ECHO_LEAK_MIN_MATCHES);

        const prev = (await db.getOralSubmissionDetail(req.submission.id))?.oral_calibration_json || null;
        const leaksRecent = (Array.isArray(prev?.echo?.leaks_recent) ? prev.echo.leaks_recent : []).slice(-1);
        leaksRecent.push(leak);
        // RMS medido no CLIENTE sobre a amostra crua (diagnóstico #323):
        // ~0 = captura muda (driver/constraint apagou); alto + transcript vazio
        // = áudio presente que o STT não reconheceu.
        const rms = Number(req.body?.rms);
        const echo = {
            leak, matches, ...(scriptText ? { script: scriptKey } : {}),
            ...(Number.isFinite(rms) ? { rms } : {}),
            tests: (Number(prev?.echo?.tests) || 0) + 1,
            leaks_recent: leaksRecent, // as 2 últimas medições — base do vermelho recuperável
            transcript: text.slice(0, 200),
            at: new Date().toISOString(),
        };
        await db.setOralCalibrationResult(req.submission.id, { echo, updated_at: echo.at });
        const state = ladderState({ ...(prev || {}), echo });
        log.info("ORAL", `echo-check submission=${req.submission.submission_token} leak=${leak} matches=${matches} escada=${state?.state || "—"}`);
        res.json({ leak, matches, tests: echo.tests, sound_check: state, sound_check_pending: soundCheckPending({ ...(prev || {}), echo }, MAX_CALIB_ATTEMPTS) });
    } catch (err) {
        log.error("ORAL", `echo-check failed: ${err.message}`);
        res.status(500).json({ error: "falha no teste de eco", detail: err.message });
    }
});

// Aluno lê o que foi PUBLICADO (devolutiva e/ou nota). O relatório de
// comparação ao gabarito é professor-only e nunca é exposto aqui.
router.get("/s/:submissionToken/oral/result", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        const d = await db.getOralSubmissionDetail(req.submission.id);
        // A devolutiva é publicada JUNTO com a nota (#207): ambas seguem grade_published_at.
        const published = !!d?.grade_published_at;
        res.json({
            devolutiva: published ? (d.oral_devolutiva || "") : null,
            grade: published ? (d.grade_final ?? null) : null,
        });
    } catch (err) { log.error("ORAL", `result failed: ${err.message}`); res.status(500).json({ error: "falha" }); }
});

// Revisão pós-prova (LGPD self-access), espelha o GET /s/:t/review da entrevista:
// dentro da janela de revisão o aluno vê a TRANSCRIÇÃO da própria prova e pode
// deixar UM comentário ao professor. A devolutiva/nota publicadas vêm à parte,
// pelo /oral/result (não expiram com a janela). Após a janela: 410.
router.get("/s/:submissionToken/oral/review", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    if (!req.submission.completion_reason) {
        return res.status(409).json({ error: "not_finalized", detail: "Prova ainda não foi realizada." });
    }
    const win = reviewWindowState(req.submission);
    if (win.expired) return res.status(410).json({ error: "review_window_expired", deadline: win.deadline });
    try {
        const d = await db.getOralSubmissionDetail(req.submission.id);
        res.set("Cache-Control", "no-store");
        res.json({
            submission: {
                student_label: req.submission.student_label,
                completion_reason: req.submission.completion_reason,
                completed_at: req.submission.completed_at,
            },
            review_window: { deadline: win.deadline, days: REVIEW_WINDOW_DAYS },
            comment: {
                value: d?.student_comment ?? null,
                locked: !!d?.student_comment,
            },
            transcript: Array.isArray(d?.oral_transcript) ? d.oral_transcript : [],
            transcript_alerts: d?.oral_voice_json?.transcript_alerts || { count: 0, turns: [] },
            calibration_flagged: calibrationAlert(d?.oral_calibration_json),
            // Corte 4 (#289, D2): o aluno vê a RETRANSCRIÇÃO de auditoria (a
            // versão fiel da própria fala) junto do transcript ao vivo.
            audit_transcript: buildAuditBlock({
                final: d?.final_transcript,
                multiPart: Array.isArray(d?.oral_video_parts) && d.oral_video_parts.length > 1,
                humanLabels: true,
            }),
        });
    } catch (err) {
        log.error("ORAL", `review failed token=${req.submission.submission_token}: ${err.message}`);
        res.status(500).json({ error: "failed_to_load_review" });
    }
});

// Comentário do aluno ao professor. Single-shot (uma vez que student_comment
// estiver setado, não muda), dentro da janela de revisão. Reusa a MESMA coluna
// e o MESMO helper da entrevista.
router.post("/s/:submissionToken/oral/comment", requireSubmissionToken, express.json({ limit: "16kb" }), async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    if (!req.submission.completion_reason) return res.status(409).json({ error: "not_finalized" });
    const win = reviewWindowState(req.submission);
    if (win.expired) return res.status(410).json({ error: "review_window_expired" });
    // Single-shot: lê o valor atual do banco (o req.submission da middleware não
    // carrega student_comment).
    const existing = await db.getOralSubmissionDetail(req.submission.id);
    if (existing?.student_comment) {
        return res.status(409).json({ error: "comment_already_submitted", detail: "Comentário já foi enviado e não pode ser editado." });
    }
    const raw = req.body?.comment;
    if (typeof raw !== "string") return res.status(400).json({ error: "comment é obrigatório (string)" });
    const trimmed = raw.trim().slice(0, MAX_COMMENT_LEN);
    if (!trimmed) return res.status(400).json({ error: "comment vazio" });
    try {
        await db.setSubmissionStudentComment(req.submission.id, trimmed);
        log.info("ORAL", `comment submitted token=${req.submission.submission_token} chars=${trimmed.length}`);
        res.json({ ok: true, comment: trimmed });
    } catch (err) {
        log.error("ORAL", `comment submit failed token=${req.submission.submission_token}: ${err.message}`);
        res.status(500).json({ error: "failed_to_save_comment" });
    }
});

// O portão de SETUP (posição/distância/mãos/celular) agora roda 100% no NAVEGADOR
// (MediaPipe WASM em static/oral-student.html) — sem chamar o servidor. Não há
// mais rota de position-check aqui (a análise de vídeo PÓS-prova segue no servidor).

// Registra o aceite do consentimento (voz + vídeo) ANTES de começar a prova.
router.post("/s/:submissionToken/oral/consent", requireSubmissionToken, async (req, res) => {
    if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
    try {
        await db.setSubmissionConsentVersion(req.submission.id, CONSENT_VERSION);
        log.info("ORAL", `consent registrado submission=${req.submission.submission_token} v=${CONSENT_VERSION}`);
        res.json({ ok: true, version: CONSENT_VERSION });
    } catch (err) {
        log.error("ORAL", `consent failed: ${err.message}`);
        res.status(500).json({ error: "falha ao registrar consentimento" });
    }
});

// Recebe o vídeo gravado da prova e guarda no object storage (não vai à OpenAI).
router.post("/s/:submissionToken/oral/video", requireSubmissionToken, comErroTratado(videoUpload.single("file"), "ORAL"), async (req, res) => {
    try {
        if (req.work.kind !== "oral_realtime") return res.status(400).json({ error: "não é prova oral" });
        if (!req.file) return res.status(400).json({ error: "file required" });
        const ext = extFromMimetype(req.file.mimetype);
        // Chave ÚNICA por segmento (multi-parte): o original e cada retomada são
        // preservados. Antes usava chave fixa por token → a retomada sobrescrevia
        // o segmento anterior e o professor só via a última gravação.
        const key = `oral-video/${req.submission.submission_token}-${Date.now()}.${ext}`;
        // Do temporário em disco direto ao storage (#357): antes o arquivo era
        // lido inteiro para um Buffer aqui, o que desfazia o ganho do multer
        // em disco logo na linha seguinte.
        const r = await putAudioFromFile({ key, filePath: req.file.path, mimetype: req.file.mimetype });
        if (!r.stored) {
            log.error("ORAL", `vídeo não armazenado submission=${req.submission.submission_token}: ${r.reason}`);
            return res.status(502).json({ error: "falha ao armazenar o vídeo", detail: r.reason });
        }
        await db.appendOralVideoPart(req.submission.id, key);
        await db.setObjectSize(key, r.byte_size);   // #349: Range sem baixar p/ medir
        // Gate de vídeo obrigatório: a conclusão da prova é marcada no encerramento
        // da sessão de voz, ANTES do vídeo subir. Se ficou 'aguardando vídeo',
        // promove para concluída agora que o segmento chegou.
        const promoted = await db.promoteAwaitingVideo(req.submission.id);
        log.info("ORAL", `segmento de vídeo armazenado submission=${req.submission.submission_token} key=${key} bytes=${r.byte_size}${promoted ? " (conclui: aguardava vídeo)" : ""}`);
        // Análise de vídeo (proctoring) AUTOMÁTICA (#209): entra na FILA GLOBAL
        // (#262), sem bloquear a resposta (o aluno já encerrou). Analisa TODAS as
        // partes atuais; se uma retomada chegar depois, o novo upload re-enfileira
        // (dedup) e sobrescreve. Falha fica persistida como 'failed' — reprocesso
        // manual pelo botão da lista de alunos ou pela tela de Operações.
        runOralProctorAuto(req.submission.id, req.submission.submission_token);
        res.json({ ok: true });
    } catch (err) {
        log.error("ORAL", `video upload failed: ${err.message}`);
        res.status(500).json({ error: "falha no upload do vídeo", detail: err.message });
    } finally {
        if (req.file && req.file.path) fs.promises.unlink(req.file.path).catch(() => {});
    }
});

// Professor assiste ao vídeo gravado (avaliação posterior). Auth por token do
// trabalho + submissão pertencente a ele.
// #349: a entrega de vídeo virou lib/serveVideo.js — streaming parcial de
// verdade nos dois backends, em vez de ler o objeto inteiro num Buffer.
router.get("/w/:workToken/oral/video/:subToken/:idx?", requireWorkToken, requireProfessorSubmission, async (req, res) => {
    try {
        const parts = await db.getOralVideoParts(req.submission.id);
        if (!parts.length) return res.status(404).json({ error: "sem vídeo para esta submissão" });
        // Com :idx explícito, serve a PARTE crua indicada (compat/depuração). Sem idx
        // (caso do player), serve o CONSOLIDADO seekable — todas as partes numa faixa
        // única cuja timeline bate com os trechos do proctoring. Se a consolidação
        // falhar (ex.: ffmpeg ausente), cai na parte 0 crua (comportamento antigo).
        if (req.params.idx != null) {
            const idx = parseInt(req.params.idx, 10);
            const key = parts[Number.isFinite(idx) ? idx : 0];
            if (!key) return res.status(404).json({ error: "parte de vídeo inexistente" });
            return await serveVideo(req, res, key, `oral=${req.submission.submission_token}`);
        }
        const consolidated = await ensureConsolidatedVideo(req.submission.submission_token, parts);
        return await serveVideo(req, res, consolidated || parts[0], `oral=${req.submission.submission_token}`);
    } catch (err) {
        log.error("ORAL", `video serve failed: ${err.message}`);
        res.status(500).json({ error: "falha ao servir o vídeo" });
    }
});

export default router;
