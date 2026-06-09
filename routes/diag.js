// Página de diagnóstico do pré-gate de áudio (modo experimentação).
//
// Permite testar o comportamento do gate SEM passar por todo o fluxo do ORATIA
// (login, trabalho, submissão, PDF, consentimento, turnos): o usuário entra em
// /diag/audio, grava, e a página mostra exatamente como o sistema decidiria —
// SNR acústico, transcrição do STT, tier de logprob, e o desfecho combinado.
//
// GET  /diag/audio  -> serve a página estática.
// POST /diag/audio  -> recebe o áudio + acoustic_snr, roda STT + os dois gates
//                      (logprob + acústico) e devolve o diagnóstico em JSON.
//
// NÃO persiste áudio. Roda STT de verdade (custo ~$0,001/clip). Por ser uma
// rota não-autenticada que dispara STT, fica DESABILITADA em produção a menos
// que AUDIO_DIAG=1 seja setado explicitamente.

import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { openai } from "../lib/openaiClient.js";
import { transcribeAudio } from "../lib/audio.js";
import { classifyAudio } from "../lib/audioIntelligibility.js";
import { classifyAcoustic, combineTiers } from "../lib/acousticGate.js";
import { STT_MODEL, AUDIO_INTELLIGIBILITY, ACOUSTIC } from "../lib/config.js";
import log from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "..", "static");

// Ligada em dev por padrão; em produção só com AUDIO_DIAG=1.
const DIAG_ENABLED = process.env.AUDIO_DIAG === "1" || process.env.NODE_ENV !== "production";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

function numOrNull(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

router.get("/diag/audio", (_req, res) => {
    if (!DIAG_ENABLED) return res.status(404).send("diagnóstico desabilitado (AUDIO_DIAG=1 para ligar)");
    res.sendFile(path.join(STATIC_DIR, "diag-audio.html"));
});

router.post("/diag/audio", upload.single("audio"), async (req, res) => {
    if (!DIAG_ENABLED) return res.status(404).json({ error: "diag desabilitado" });
    if (!req.file) return res.status(400).json({ error: "audio obrigatório" });

    const snr = numOrNull(req.body?.acoustic_snr);
    const bak = numOrNull(req.body?.acoustic_bak);

    // STT (mesma chamada de produção: logprobs ligados).
    let transcript = "", logprobs = null;
    try {
        const r = await transcribeAudio(openai, STT_MODEL, req.file.buffer, req.file.originalname || "diag.webm");
        transcript = r.text;
        logprobs = r.logprobs ?? null;
    } catch (err) {
        return res.status(502).json({ error: `STT falhou: ${err.message}` });
    }

    // Votante 1: logprob.
    const votes = [];
    let logprobOut = null;
    if (AUDIO_INTELLIGIBILITY.enabled && logprobs) {
        const cls = classifyAudio(logprobs, AUDIO_INTELLIGIBILITY);
        votes.push({ tier: cls.outcome, source: "logprob" });
        logprobOut = {
            tier: cls.outcome,
            metrics: cls.metrics,
            aggregate: cls.aggregate,
            spans: cls.spans.map((s) => s.text),
        };
    }

    // Votante 2: acústico (métricas do navegador).
    const ac = classifyAcoustic({ snr, bak }, ACOUSTIC);
    if (ac.sources.length) votes.push({ tier: ac.tier, source: ac.sources.join("+") });

    const combined = combineTiers(votes);
    const reason = combined.sources.length > 0 && !combined.sources.includes("logprob") ? "acoustic" : "logprob";

    log.info("DIAG:Gate", `snr=${snr ?? "—"} bak=${bak ?? "—"} logprob=${logprobOut?.tier ?? "off"} acustico=${ac.tier} -> ${combined.tier} (${reason})`);

    res.json({
        transcript,
        acoustic: { snr, bak, tier: ac.tier, tiers: ac.tiers },
        logprob: logprobOut,
        combined: { tier: combined.tier, sources: combined.sources, reason },
        config: {
            snr_warn: ACOUSTIC.snr_warn, snr_repeat: ACOUSTIC.snr_repeat,
            snr_enabled: ACOUSTIC.snr_enabled, acoustic_enabled: ACOUSTIC.enabled,
            logprob_enabled: AUDIO_INTELLIGIBILITY.enabled,
        },
    });
});

export default router;
