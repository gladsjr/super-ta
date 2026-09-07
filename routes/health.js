// Endpoint de verificação de saúde (#375).
//
//   GET /healthz                                   liveness: sem auth, sem banco
//   GET /admin/health?checks=db,jobs&depth=shallow  o relatório completo
//
// Duas portas de entrada para o relatório, porque são dois usos:
//   - a TELA de Operações, com sessão de admin;
//   - a MONITORAÇÃO externa, com o token de análise (Authorization: Bearer ou
//     X-Api-Key), sem sessão — o mesmo mecanismo do /api/analytics/query, que
//     já é revogável, rastreável e tem tela de geração.
//
// Neste corte só existe o nível `shallow`, que não escreve, não gasta e não
// chama provedor externo — por isso reaproveitar o token de análise (que é
// somente-leitura por construção) não amplia o que ele pode fazer. Quando o
// nível `deep` entrar, ele escreve no storage e gasta dinheiro: aí a issue
// propõe um `scope` no token, e é ANTES disso que a decisão precisa ser tomada.
//
// O status HTTP reflete o pior resultado — é o que a ferramenta de monitoração
// lê: 200 quando nenhum check falhou (avisos incluídos), 503 quando algum falhou.
// O corpo vai completo nos dois casos.

import express from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../lib/middleware.js";
import { requireAnalyticsToken } from "./analytics.js";
import { runHealth, CHECK_IDS, DEPTHS, COMMIT } from "../lib/health.js";
import log from "../lib/logger.js";

const router = express.Router();

// Liveness puro: responde antes do store de sessão e sem tocar no banco. Uma
// sonda de "o processo está vivo?" não pode depender daquilo que ela vigia.
export function healthz(_req, res) {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, commit: COMMIT, ts: new Date().toISOString() });
}

// Token, se veio; senão, sessão de admin. Sem nenhum dos dois, 401.
function requireAdminOrToken(req, res, next) {
    const temToken = !!(req.get("authorization") || req.get("x-api-key"));
    if (temToken) return requireAnalyticsToken(req, res, next);
    if (req.session?.user) return requireAdmin(req, res, next);
    return res.status(401).json({ error: "informe um bearer token ou entre como administrador" });
}

// O nível shallow é barato, mas não é de graça para o banco: um robô mal
// configurado batendo 10× por segundo vira carga. Teto folgado para uso normal.
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "muitas verificações — aguarde um instante" },
});

router.get("/admin/health", limiter, requireAdminOrToken, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const depth = String(req.query.depth || "shallow").toLowerCase();
    const raw = String(req.query.checks || "").trim();
    const ids = raw ? raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : null;
    try {
        const relatorio = await runHealth({ ids, depth });
        res.status(relatorio.status === "fail" ? 503 : 200).json(relatorio);
    } catch (err) {
        const code = err.httpStatus ?? 500;
        if (code >= 500) log.error("HEALTH", `relatório falhou: ${err.message}`);
        res.status(code).json({ error: err.message, checks_available: CHECK_IDS, depths: DEPTHS });
    }
});

export default router;
