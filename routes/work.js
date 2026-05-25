// Rotas do professor (auth via work_token Bearer).
// Inclui também as rotas de templates de entrevistador (compartilhadas) que
// vivem fora do prefixo /w/* mas são consumidas no fluxo de configuração.

import express from "express";
import multer from "multer";
import yaml from "js-yaml";
import OpenAI from "openai";
import { requireWorkToken, requireWithinBudget, sanitizeLabel } from "../lib/middleware.js";
import * as db from "../lib/db.js";
import { VOICES, isValidVoice } from "../config/voices.js";
import { AudioCache, synthesizeSpeech } from "../lib/audio.js";
import {
    meteredResponses,
    meteredTts,
    getWorkBalance,
} from "../lib/billing.js";
import { openai } from "../lib/openaiClient.js";
import { configAssistantAgent, enunciadoCoherenceAgent } from "../lib/agents.js";
import { PRINCIPAL_REASONING_MODEL, TTS_MODEL } from "../lib/config.js";
import log from "../lib/logger.js";

const router = express.Router();

const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MB
const enunciadoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: UPLOAD_LIMIT_BYTES },
});

// ============================================================================
// Info do trabalho
// ============================================================================
router.get("/w/:workToken/info", requireWorkToken, async (req, res) => {
    try {
        const submissions = await db.listSubmissionsForWork(req.work.id);
        const balance = await getWorkBalance(req.work.id);
        res.json({
            work: {
                name: req.work.name,
                has_enunciado: !!req.work.assignment_pdf,
                has_interviewer: !!req.work.has_interviewer,
                interaction_mode: req.work.interaction_mode,
                voice: req.work.voice,
                budget_usd: balance?.budget_usd ?? 0,
                spent_usd: balance?.spent_usd ?? 0,
                remaining_usd: balance?.remaining_usd ?? 0,
                percent_used: balance?.percent_used ?? 100,
            },
            submissions,
        });
    } catch (err) {
        log.error("WORK", `info failed: ${err.message}`);
        res.status(500).json({ error: "failed to load work info" });
    }
});

// ============================================================================
// Modo de interação (texto vs áudio) e voz
// ============================================================================
router.get("/w/:workToken/voices", requireWorkToken, (req, res) => {
    res.json({ voices: VOICES.map(v => ({ id: v.id, label: v.label, gender: v.gender })) });
});

const PREVIEW_DEFAULT_TEXT = "Olá, sou seu entrevistador. Vamos começar?";
const previewCache = new AudioCache(20); // chave: voiceId|textHash

function hashText(s) {
    // Hash leve, suficiente pra chave de cache em memória.
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return String(h);
}

router.post("/w/:workToken/voices/preview", requireWorkToken, requireWithinBudget, express.json({ limit: "16kb" }), async (req, res) => {
    const voiceId = String(req.body?.voiceId ?? "");
    const text = String(req.body?.text ?? PREVIEW_DEFAULT_TEXT).slice(0, 200);
    if (!isValidVoice(voiceId)) return res.status(400).json({ error: "voz inválida" });

    const cacheKey = `${voiceId}|${hashText(text)}`;
    let buffer = previewCache.get(cacheKey);
    if (!buffer) {
        try {
            buffer = await meteredTts(
                { workId: req.work.id, model: TTS_MODEL, inputText: text },
                () => synthesizeSpeech(openai, TTS_MODEL, text, voiceId)
            );
            previewCache.set(cacheKey, buffer);
        } catch (err) {
            log.error("VOICES", `preview failed: ${err.message}`);
            return res.status(500).json({ error: "falha ao gerar prévia", detail: err.message });
        }
    }
    res.type("audio/mpeg");
    res.send(buffer);
});

router.post("/w/:workToken/interaction", requireWorkToken, express.json({ limit: "16kb" }), async (req, res) => {
    const mode = String(req.body?.mode ?? "");
    const voice = req.body?.voice ? String(req.body.voice) : null;

    if (mode !== "text" && mode !== "audio") {
        return res.status(400).json({ error: "mode deve ser 'text' ou 'audio'" });
    }
    if (mode === "audio" && !isValidVoice(voice)) {
        return res.status(400).json({ error: "voz inválida ou ausente para o modo áudio" });
    }

    try {
        await db.setInteractionMode(req.work.id, mode, voice);
        log.info("WORK", `interaction mode=${mode} voice=${voice ?? "-"} work=${req.work.work_token}`);
        res.json({ ok: true, interaction_mode: mode, voice: mode === "audio" ? voice : null });
    } catch (err) {
        log.error("WORK", `set interaction failed: ${err.message}`);
        res.status(500).json({ error: "falha ao salvar modo de interação", detail: err.message });
    }
});

// ============================================================================
// Visualização da conversa pelo professor
// ============================================================================
router.get("/w/:workToken/submissions/:subToken/conversation", requireWorkToken, async (req, res) => {
    const subToken = String(req.params.subToken || "").toLowerCase();
    try {
        const found = await db.findSubmissionByToken(subToken);
        if (!found || found.work_id !== req.work.id) {
            return res.status(404).json({ error: "submission not found" });
        }
        const [text, runtime] = await Promise.all([
            db.getConversationJson(found.id),
            db.getSubmissionRuntimeState(found.id),
        ]);
        let conversation = null;
        if (text) {
            try { conversation = JSON.parse(text); }
            catch (err) {
                log.error("WORK", `conversation parse failed submission=${subToken}: ${err.message}`);
                return res.status(500).json({ error: "failed to read conversation" });
            }
        }
        // Acrescenta as perguntas planejadas que ainda não foram feitas. O plano
        // original vive em runtime_state.interview_plan; o cursor question_index
        // aponta para a próxima a considerar (tanto perguntas feitas quanto
        // puladas avançam o cursor). Skipped ficam abaixo do cursor — já são
        // expostos por outra seção. Slice(cursor) é exatamente o "futuro".
        const planQuestions = runtime?.runtime_state?.interview_plan?.questions;
        if (conversation && Array.isArray(planQuestions)) {
            const cursor = typeof runtime.question_index === "number" ? runtime.question_index : 0;
            conversation.pending_questions = planQuestions.slice(cursor).map((q, i) => ({
                index: cursor + i,
                id: q?.id ?? null,
                question: q?.question ?? "",
                rationale: q?.rationale ?? "",
                objectives: q?.objectives ?? [],
                concerns: q?.concerns ?? [],
                decision_criteria: q?.decision_criteria ?? [],
                information_needs: q?.information_needs ?? [],
                evaluation_mode: q?.evaluation_mode ?? [],
            }));
        }
        res.json({
            work: { work_token: req.work.work_token, name: req.work.name },
            submission: { submission_token: subToken, student_label: found.student_label, status: found.status },
            conversation,
        });
    } catch (err) {
        log.error("WORK", `conversation lookup failed submission=${subToken}: ${err.message}`);
        res.status(500).json({ error: "failed to read conversation" });
    }
});

// ============================================================================
// Templates de entrevistador (compartilhados — fora do prefixo /w/*)
// ============================================================================
router.get("/interviewers/templates", async (_req, res) => {
    try {
        const templates = await db.listInterviewerTemplates();
        res.json({ templates });
    } catch (err) {
        log.error("TPL", `list failed: ${err.message}`);
        res.status(500).json({ error: "failed to list templates" });
    }
});

router.get("/interviewers/templates/:filename", async (req, res) => {
    const filename = String(req.params.filename);
    try {
        const content = await db.getInterviewerTemplate(filename);
        if (content == null) return res.status(404).json({ error: "template not found" });
        res.type("text/plain").send(content);
    } catch (err) {
        log.error("TPL", `read failed: ${err.message}`);
        res.status(500).json({ error: "failed to read template" });
    }
});

// ============================================================================
// YAML do entrevistador por trabalho
// ============================================================================
router.get("/w/:workToken/interviewer", requireWorkToken, async (req, res) => {
    try {
        const yamlText = await db.getInterviewerYaml(req.work.id);
        res.json({ yaml: yamlText ?? null });
    } catch (err) {
        log.error("WORK", `interviewer read failed: ${err.message}`);
        res.status(500).json({ error: "failed to read interviewer" });
    }
});

router.post("/w/:workToken/interviewer", requireWorkToken, express.json({ limit: "256kb" }), async (req, res) => {
    const content = String(req.body?.yaml ?? "");
    if (!content.trim()) return res.status(400).json({ error: "yaml content required" });
    try {
        yaml.load(content);
    } catch (err) {
        return res.status(400).json({ error: "invalid YAML", detail: err.message });
    }
    try {
        await db.setInterviewerYaml(req.work.id, content);
        log.info("WORK", `interviewer saved work=${req.work.work_token} bytes=${content.length}`);
        res.json({ ok: true });
    } catch (err) {
        log.error("WORK", `interviewer save failed: ${err.message}`);
        res.status(500).json({ error: "failed to save interviewer" });
    }
});

const INTERVIEWER_ADAPT_INSTRUCTIONS = `Você adapta prompts de entrevistador acadêmico. Receberá:
1) Um YAML com a definição genérica de um entrevistador (agente, cenário, conversa).
2) O enunciado de um trabalho específico, em PDF anexado.

Produza um NOVO YAML que preserve exatamente a mesma estrutura de chaves
e hierarquia do genérico, mas com valores textuais especializados ao trabalho
descrito no enunciado. Os valores passam a referenciar conceitos, termos,
objetivos, métodos e entregáveis concretos do enunciado.

Regras rígidas:
- NÃO invente informações ausentes do enunciado.
- NÃO adicione, remova ou renomeie chaves.
- Mantenha o idioma do YAML genérico.
- Listas mantêm aproximadamente o mesmo número de itens; reescreva cada
  item para soar específico ao trabalho.
- Onde o YAML genérico usar expressões abstratas ("o trabalho", "o aluno
  deve"), substitua por formulações ancoradas no enunciado.
- Campos inerentemente genéricos (ex.: interaction_style com item
  "investigativo") podem ser mantidos se não houver base no enunciado para
  especializá-los.
- O campo scenario.case_context.summary deve descrever, em 1–2 frases, o
  caso concreto entregue pelo aluno conforme o enunciado.

Responda APENAS com o YAML adaptado. Nada antes, nada depois. Sem cercas
de código markdown.`;

function stripYamlFence(text) {
    const trimmed = String(text || "").trim();
    const fenced = trimmed.match(/^```(?:ya?ml)?\s*\n([\s\S]*?)\n```\s*$/i);
    return fenced ? fenced[1].trim() : trimmed;
}

router.post("/w/:workToken/interviewer/adapt", requireWorkToken, requireWithinBudget, express.json({ limit: "256kb" }), async (req, res) => {
    const genericYaml = String(req.body?.yaml ?? "");
    if (!genericYaml.trim()) return res.status(400).json({ error: "yaml content required" });
    try {
        yaml.load(genericYaml);
    } catch (err) {
        return res.status(400).json({ error: "invalid input YAML", detail: err.message });
    }

    const enunciadoBlob = await db.getEnunciadoBlob(req.work.id);
    if (!enunciadoBlob) {
        return res.status(400).json({ error: "envie o enunciado do trabalho antes de adaptar" });
    }

    try {
        log.info("INTERVIEWER_ADAPT", `start work=${req.work.work_token} bytes=${genericYaml.length}`);
        const fileUpload = await openai.files.create({
            file: await OpenAI.toFile(enunciadoBlob.pdf, enunciadoBlob.filename || "enunciado.pdf"),
            purpose: "user_data",
        });
        log.info("INTERVIEWER_ADAPT", `uploaded enunciado file=${fileUpload.id}`);

        const response = await log.span("INTERVIEWER_ADAPT", "responses.create", () =>
            meteredResponses(
                { workId: req.work.id, agentLabel: "INTERVIEWER_ADAPT", model: PRINCIPAL_REASONING_MODEL },
                () => openai.responses.create({
                    model: PRINCIPAL_REASONING_MODEL,
                    instructions: INTERVIEWER_ADAPT_INSTRUCTIONS,
                    input: [{
                        role: "user",
                        content: [
                            { type: "input_text", text: `YAML genérico:\n\n${genericYaml}\n\nEnunciado em anexo. Gere o YAML adaptado.` },
                            { type: "input_file", file_id: fileUpload.id },
                        ],
                    }],
                })
            )
        );

        const adaptedYaml = stripYamlFence(response.output_text || "");
        if (!adaptedYaml) {
            return res.status(502).json({ error: "o modelo não retornou YAML" });
        }
        try {
            yaml.load(adaptedYaml);
        } catch (err) {
            log.warn("INTERVIEWER_ADAPT", `returned YAML did not parse: ${err.message}`);
            return res.status(502).json({ error: "o modelo retornou YAML inválido", yaml: adaptedYaml, detail: err.message });
        }
        log.info("INTERVIEWER_ADAPT", `ok work=${req.work.work_token} out_bytes=${adaptedYaml.length}`);
        res.json({ yaml: adaptedYaml });
    } catch (err) {
        log.error("INTERVIEWER_ADAPT", `failed: ${err.message}`);
        res.status(500).json({ error: "falha ao adaptar o interviewer", detail: err.message });
    }
});

// ============================================================================
// Enunciado
// ============================================================================
router.get("/w/:workToken/enunciado", requireWorkToken, async (req, res) => {
    try {
        const blob = await db.getEnunciadoBlob(req.work.id);
        if (!blob) return res.status(404).json({ error: "enunciado not uploaded" });
        res.type("application/pdf");
        if (blob.filename) {
            res.set("Content-Disposition", `inline; filename="${encodeURIComponent(blob.filename)}"`);
        }
        res.send(blob.pdf);
    } catch (err) {
        log.error("WORK", `enunciado read failed: ${err.message}`);
        res.status(500).json({ error: "failed to read enunciado" });
    }
});

router.post("/w/:workToken/enunciado", requireWorkToken, enunciadoUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "file required" });
    try {
        await db.setEnunciadoBlob(req.work.id, req.file.buffer, req.file.originalname);
        // Cache de coerência fica obsoleto quando o PDF é substituído.
        await db.clearCoherenceCache(req.work.id);
        log.info("WORK", `enunciado uploaded work=${req.work.work_token} bytes=${req.file.size} name=${req.file.originalname}`);
        res.json({ ok: true });
    } catch (err) {
        log.error("WORK", `enunciado save failed: ${err.message}`);
        res.status(500).json({ error: "failed to save enunciado" });
    }
});

// ---- Coerência do enunciado (assistente de configuração) ----
// Avalia se o enunciado está bem encaixado no processo de entrevista.
// NUNCA avalia a qualidade pedagógica/técnica do trabalho em si.
// Resultado é cacheado em works.enunciado_coherence_json até o PDF ser substituído.
router.post("/w/:workToken/enunciado/coherence", requireWorkToken, requireWithinBudget, async (req, res) => {
    const force = String(req.query?.force ?? "").toLowerCase() === "true";

    try {
        if (!force) {
            const cached = await db.getCoherenceCache(req.work.id);
            if (cached) {
                log.info("COHERENCE", `cache hit work=${req.work.work_token}`);
                return res.json({ ...cached, cached: true });
            }
        }

        const enunciadoBlob = await db.getEnunciadoBlob(req.work.id);
        if (!enunciadoBlob) {
            return res.status(400).json({ error: "envie o enunciado do trabalho antes de avaliar" });
        }

        log.info("COHERENCE", `start work=${req.work.work_token} force=${force}`);
        const fileUpload = await openai.files.create({
            file: await OpenAI.toFile(enunciadoBlob.pdf, enunciadoBlob.filename || "enunciado.pdf"),
            purpose: "user_data",
        });
        log.info("COHERENCE", `uploaded enunciado file=${fileUpload.id}`);

        const report = await enunciadoCoherenceAgent.evaluate({
            openaiFileId: fileUpload.id,
            meterCtx: { workId: req.work.id },
        });
        await db.setCoherenceCache(req.work.id, report);
        log.info("COHERENCE", `ok work=${req.work.work_token} overall=${report.overall}`);
        res.json({ ...report, cached: false });
    } catch (err) {
        log.error("COHERENCE", `failed: ${err.message}`);
        res.status(500).json({ error: "falha ao avaliar coerência do enunciado", detail: err.message });
    }
});

// ============================================================================
// Chat efêmero do assistente de configuração
// Histórico vem do cliente em cada turno. Sem persistência server-side e sem
// tocar a Conversations API (ver CLAUDE.md). Modelo: fast_model.
// ============================================================================
router.post("/w/:workToken/config-chat", requireWorkToken, requireWithinBudget, express.json({ limit: "256kb" }), async (req, res) => {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message required" });

    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const history = rawHistory
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map(m => ({ role: m.role, content: m.content }))
        .slice(-30); // bound por segurança

    try {
        const stateBlock = await buildConfigStateBlock(req.work);
        const result = await configAssistantAgent.evaluate({
            history,
            message,
            stateBlock,
            meterCtx: { workId: req.work.id },
        });
        res.json(result);
    } catch (err) {
        log.error("CONFIG_CHAT", `failed: ${err.message}`);
        res.status(500).json({ error: "falha no assistente de configuração", detail: err.message });
    }
});

async function buildConfigStateBlock(work) {
    const coherence = await db.getCoherenceCache(work.id);
    const interviewerYaml = await db.getInterviewerYaml(work.id);

    let originLine = "nenhum (professor ainda não salvou)";
    if (interviewerYaml) {
        const matchedTemplate = await findMatchingTemplateName(interviewerYaml);
        originLine = matchedTemplate
            ? `salvo (baseado em "${matchedTemplate}")`
            : "salvo (customizado ou adaptado — não corresponde byte-a-byte a nenhuma das 6 personas prontas)";
    }

    const header = `- Nome do trabalho: ${work.name}
- Enunciado enviado: ${work.assignment_pdf ? "sim" : "não"}
- Persona/YAML do entrevistador: ${originLine}
- Templates disponíveis: Teacher Assistant.yaml, Business Owner.yaml, Hiring Manager.yaml, Investor.yaml, Executive Sponsor.yaml, Journalist.yaml`;

    if (!coherence) {
        return `${header}
- Diagnóstico de coerência do enunciado: ainda não avaliado (você pode emitir action.type=request_assignment_check se o professor pedir avaliação)`;
    }

    const findingsBlock = (coherence.findings || []).map(f =>
        `    - ${f.criterion} [${f.status}]: ${f.comment}`
    ).join("\n");
    const personasBlock = (coherence.suggested_personas || []).map(p =>
        `    - ${p.filename} (fit=${p.fit}): ${p.reason}`
    ).join("\n");
    const fixesBlock = (coherence.fix_suggestions || []).map(s => `    - ${s}`).join("\n");

    return `${header}
- Diagnóstico de coerência do enunciado JÁ DISPONÍVEL (NÃO emita request_assignment_check de novo — comente este relatório):
    overall: ${coherence.overall}
    summary: ${coherence.summary}
  Achados por critério:
${findingsBlock || "    (nenhum)"}
  Personas sugeridas:
${personasBlock || "    (nenhuma)"}
  Sugestões de correção do enunciado:
${fixesBlock || "    (nenhuma)"}`;
}

async function findMatchingTemplateName(savedYamlText) {
    // Best-effort: identifica se o YAML salvo é byte-identical a um dos 6 templates.
    // Se não for, devolvemos null (provavelmente foi adaptado ou customizado).
    const templates = await db.listInterviewerTemplates();
    for (const t of templates) {
        const tplText = await db.getInterviewerTemplate(t.filename);
        if (tplText && tplText.trim() === savedYamlText.trim()) return t.filename;
    }
    return null;
}

// ============================================================================
// Criação de submissions
// ============================================================================
router.post("/w/:workToken/submissions", requireWorkToken, async (req, res) => {
    let baseLabel;
    try { baseLabel = sanitizeLabel(req.body?.label); }
    catch (err) { return res.status(400).json({ error: err.message }); }

    const rawCount = Number(req.body?.count ?? 1);
    const count = Number.isFinite(rawCount) && rawCount > 0 && rawCount <= 50 ? Math.floor(rawCount) : 1;

    try {
        const rows = await db.createSubmissions(req.work.id, baseLabel, count);
        log.info("SUBMISSION", `created ${count} submission(s) for work=${req.work.work_token}`);
        res.json({ submissions: rows });
    } catch (err) {
        log.error("SUBMISSION", `create failed: ${err.message}`);
        res.status(500).json({ error: "failed to create submissions" });
    }
});

export default router;
