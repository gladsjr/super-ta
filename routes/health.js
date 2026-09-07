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
// Validar o token exige o banco — e o banco é justamente uma das coisas que o
// relatório mede. Por isso a validação aqui NÃO é o middleware do analytics:
// tem prazo próprio, e quando o banco não responde à validação a resposta é o
// diagnóstico (503, check `db` em fail), não um 500 de autenticação nem uma
// espera sem fim. O relatório completo não sai (o chamador não se autenticou);
// o que sai é só o que um 503 já diz: o banco está fora.
//
// Neste corte só existe o nível `shallow`, que não escreve, não gasta e não
// chama provedor externo — por isso reaproveitar o token de análise (que é
// somente-leitura por construção) não amplia o que ele pode fazer. Quando o
// nível `deep` entrar, ele escreve no storage e gasta dinheiro: a issue propõe
// um `scope` no token (decisão do Gladstone em 07/09: aprovado, com a tela de
// tokens do admin mudando junto), e é ANTES do deep que isso entra.
//
// O status HTTP reflete o pior resultado — é o que a ferramenta de monitoração
// lê: 200 quando nenhum check falhou (avisos incluídos), 503 quando algum falhou.
// O corpo vai completo nos dois casos.

import express from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../lib/middleware.js";
import { findValidAnalyticsToken } from "../lib/db.js";
import { runHealth, comClienteRO, CHECK_IDS, DEPTHS } from "../lib/health.js";
import log from "../lib/logger.js";

const router = express.Router();

// Liveness puro: responde antes do store de sessão e sem tocar no banco. Uma
// sonda de "o processo está vivo?" não pode depender daquilo que ela vigia.
//
// Sem autenticação de propósito, e por isso NÃO conta nada além de "estou
// vivo": nem commit, nem versão. Exigir o token de análise aqui traria o banco
// (o token vive em tabela) e a expiração de 30 dias para dentro da sonda — os
// dois defeitos que ela existe para não ter. O commit fica no /admin/health.
export function healthz(_req, res) {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, ts: new Date().toISOString() });
}

// O mínimo que se pode dizer sem autenticar: o banco não respondeu. É o mesmo
// contrato do relatório (status, checks[]) para a monitoração ler igual.
function relatorioSemBanco(err) {
    return {
        ok: false,
        status: "fail",
        ts: new Date().toISOString(),
        depth: "shallow",
        unauthenticated: "o banco não respondeu à validação do token; relatório completo indisponível",
        checks: [{ id: "db", label: "Banco de dados", status: "fail", duration_ms: null, detail: { error: err.message }, cost_usd: 0 }],
    };
}

async function autenticarToken(provided, req, res, next) {
    const hash = crypto.createHash("sha256").update(provided).digest("hex");
    // Pelo pool do HEALTH, não pelo do app: prazo de conexão que cancela o
    // pedido, transação somente-leitura com statement_timeout. Uma chamada da
    // monitoração com o banco fora não deixa nada enfileirado em lugar nenhum.
    let row;
    try {
        row = await comClienteRO((q) => findValidAnalyticsToken(hash, q));
    } catch (err) {
        log.warn("HEALTH", `validação do token sem banco: ${err.message}`);
        res.set("Cache-Control", "no-store");
        return res.status(503).json(relatorioSemBanco(err));
    }
    if (!row) return res.status(401).json({ error: "token inválido, revogado ou expirado" });
    req.analyticsToken = row;
    next();
}

// Token, se veio; senão, sessão de admin. Sem nenhum dos dois, 401.
function requireAdminOrToken(req, res, next) {
    const hdr = req.get("authorization") || "";
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    const provided = bearer || req.get("x-api-key") || "";
    if (provided) return autenticarToken(provided, req, res, next);
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
    // `checks` ausente → todos. `checks=` presente mas vazio (ou só vírgulas) →
    // 400 em runHealth: relatório vazio com ok:true seria saúde sem medição.
    const ids = req.query.checks === undefined
        ? null
        : String(req.query.checks).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
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
