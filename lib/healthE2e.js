// Verificação de saúde, nível E2E (#375, corte 4b): a perna B do Realtime —
// navegador ↔ NOSSO relay ↔ OpenAI, em produção, sobre o trabalho de saúde
// permanente. Só sob pedido explícito: gera fala de verdade e custa centavos.
//
// Por que existe, se a perna A já valida a OpenAI: a perna A não passa pelo
// nosso relay. É a perna B que testa a autenticação por token de submissão,
// o sorteio das perguntas, o session.update do relay com a voz do trabalho, a
// primeira fala do examinador e o tee/keep-alive — tudo o que um aluno vive
// nos primeiros segundos de uma prova oral. "Tempo até o primeiro som" é o
// número que importa.
//
// O que NÃO testa: o navegador (getUserMedia, câmera, MediaRecorder) — isso
// segue sendo a skill testar-modo-audio. Nenhum áudio de aluno é enviado.
//
// Higiene: cada execução cria UM envio de teste (is_test) no trabalho de
// saúde, com consentimento registrado, abre o relay como aluno, escuta até o
// primeiro som (+1,5 s) ou 20 s, fecha. As sondas anteriores são apagadas no
// início da execução seguinte (nunca a atual — o fechamento do relay ainda
// persiste transcrição e custo em segundo plano). O custo do Realtime é
// lançado pelo próprio relay no trabalho de saúde (recordRealtimeCost);
// aqui ele é lido do ledger para o relatório.

import { WebSocket } from "ws";
import { pool } from "../auth.js";
import * as db from "./db.js";
import { estimateRealtimeCostFromAggregate } from "./billing.js";
import { CONSENT_VERSION } from "../config/consent.js";
import { PORT, REALTIME_MODEL } from "./config.js";
import { orcamentoPermite, DEEP_BUDGET_MS } from "./healthDeep.js";
import log from "./logger.js";

const PROBE_LABEL = "Sonda de saúde";
const LISTEN_MAX_MS = 20_000;
const AFTER_FIRST_AUDIO_MS = 1500;
const MIN_AUDIO_BYTES = 24_000; // ~0,5 s de PCM16 mono 24 kHz
const FIRST_AUDIO_WARN_MS = 8000;

// A sonda fecha no meio da primeira fala — e o relay só recebe o usage da
// OpenAI no response.done, que nunca chega. Sem isto o gasto do Realtime da
// sonda ficaria FORA do ledger (a fatura cobra mesmo assim). Estimativa
// conservadora, gravada como evento realtime no trabalho de saúde, marcada
// no detalhe: instruções da prova ≈ 2 000 tokens de texto de entrada, e
// áudio de saída ≈ 10 tokens por segundo falado. Calibrar na fatura se a
// sonda virar rotina.
const EST_INPUT_TEXT_TOKENS = 2000;
const EST_AUDIO_TOKENS_PER_SEC = 10;

const resultado = (status, detail = {}, cost_usd = 0) => ({ status, detail, cost_usd });
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// As operações de banco da sonda vão por ctx.escritaComPrazo (lib/health.js#
// comClienteRW): pool do health com prazo de aquisição que tira o pedido da
// fila, transação com statement_timeout, cliente descartado se o prazo
// estourar. Um relatório que já voltou por prazo não deixa consulta pendente
// no banco nem corpo abandonado criando envio (revisão do #399, duas
// rodadas). O sinal do check é conferido depois de CADA espera.
const OPS_TIMEOUT_MS = 5000;
function conferirSinal(ctx, etapa) {
    if (ctx.signal?.aborted) throw new Error(`prazo do check estourado antes de ${etapa} — sonda não criada/aberta`);
}

// Operações de banco da sonda, todas por um executor `q(sql, values)` que o
// chamador fornece dentro de uma transação com prazo. Injetáveis para teste
// (deps.ops).
export const OPS = {
    async limparSondasAntigas(q, workId) {
        const r = await q(
            `DELETE FROM submissions WHERE work_id = $1 AND is_test = true AND student_label LIKE $2
               AND created_at < now() - interval '2 minutes'`, [workId, `${PROBE_LABEL}%`]);
        return r.rowCount;
    },
    async criarSonda(q, workId) {
        const [sub] = await db.createSubmissions(workId, `${PROBE_LABEL} ${new Date().toISOString()}`, 1, true, { query: q });
        await q(`UPDATE submissions SET consent_version = $1, updated_at = now() WHERE id = $2`, [CONSENT_VERSION, sub.id]);
        return sub;
    },
    async custoDaSonda(q, submissionId) {
        const r = await q(
            `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS c, count(*)::int AS n FROM work_cost_events
              WHERE submission_id = $1 AND event_type = 'realtime'`, [submissionId]);
        return { cost_usd: Number(r.rows[0]?.c ?? 0), events: r.rows[0]?.n ?? 0 };
    },
    // Mesmo lançamento que lib/billing.js#recordCost faria (evento + spent_usd),
    // mas pelo executor com prazo — recordCost usa o pool do app sem prazo.
    async registrarEstimativa(q, { workId, submissionId, audioSeconds }) {
        const audioTokens = Math.round(audioSeconds * EST_AUDIO_TOKENS_PER_SEC);
        const cost = estimateRealtimeCostFromAggregate({
            model: REALTIME_MODEL, inputTokens: EST_INPUT_TEXT_TOKENS, outputTokens: audioTokens,
            audioFracInput: 0, audioFracOutput: 1,
        });
        if (cost == null) throw new Error(`sem preço para ${REALTIME_MODEL} em pricing.yaml`);
        await q(
            `INSERT INTO work_cost_events (work_id, submission_id, event_type, model, agent_label,
                input_tokens, cached_tokens, output_tokens, input_audio_tokens, cached_audio_tokens, output_audio_tokens, cost_usd)
             VALUES ($1, $2, 'realtime', $3, 'health.realtime_b (estimativa)', $4, 0, $5, 0, 0, $5, $6)`,
            [workId, submissionId, REALTIME_MODEL, EST_INPUT_TEXT_TOKENS, audioTokens, cost]);
        await q(`UPDATE works SET spent_usd = spent_usd + $1, updated_at = now() WHERE id = $2`, [cost, workId]);
        return cost;
    },
};

export async function checkRealtimeB(ctx = {}) {
    const perm = orcamentoPermite(ctx);
    if (!perm.ok) return resultado("skip", { reason: perm.reason });
    const deps = ctx.deps ?? {};
    const WS = deps.WebSocket ?? WebSocket;
    const ops = deps.ops ?? OPS;
    const base = deps.baseWs ?? `ws://127.0.0.1:${PORT}`;
    const workId = perm.workId;

    // Sem executor com prazo (teste sem runHealth) cai no pool do app.
    const escrita = ctx.escritaComPrazo ?? ((fn) => fn((sql, v) => pool.query(sql, v)));
    const t0 = Date.now();
    conferirSinal(ctx, "limpar as sondas antigas");
    const apagadas = await escrita((q) => ops.limparSondasAntigas(q, workId), OPS_TIMEOUT_MS);
    conferirSinal(ctx, "criar o envio de teste");
    const sub = await escrita((q) => ops.criarSonda(q, workId), OPS_TIMEOUT_MS);
    conferirSinal(ctx, "abrir o relay");
    const url = `${base}/s/${sub.submission_token}/oral/relay`;

    const eventos = [];
    let audioBytes = 0, audioFrames = 0, firstAudioMs = null, connectMs = null, fechado = null;
    const ws = new WS(url);
    let acabou; const fim = new Promise(r => { acabou = r; });
    let timerFim = null;
    const terminar = () => { if (timerFim) clearTimeout(timerFim); acabou(); };
    ws.on("open", () => { connectMs = Date.now() - t0; });
    ws.on("message", (data, isBinary) => {
        if (isBinary || Buffer.isBuffer(data) && !data.toString().startsWith("{")) {
            audioBytes += data.length; audioFrames++;
            if (firstAudioMs === null) { firstAudioMs = Date.now() - t0; timerFim = setTimeout(terminar, AFTER_FIRST_AUDIO_MS); }
            return;
        }
        let m; try { m = JSON.parse(data.toString()); } catch { return; }
        eventos.push(m.type + (m.state ? `:${m.state}` : "") + (m.reason ? `:${m.reason}` : ""));
        if (m.type === "ended") terminar();
    });
    ws.on("close", (code) => { fechado = code; terminar(); });
    ws.on("error", (e) => { eventos.push(`error:${e.message}`); terminar(); });
    const aoAbortar = () => { eventos.push("abort:prazo do check"); terminar(); };
    ctx.signal?.addEventListener("abort", aoAbortar, { once: true });
    const teto = setTimeout(terminar, LISTEN_MAX_MS);
    try {
        await fim;
    } finally {
        clearTimeout(teto);
        ctx.signal?.removeEventListener("abort", aoAbortar);
        try { ws.close(1000, "sonda de saúde"); } catch { /* já fechado */ }
    }
    // O fechamento do relay persiste transcrição e custo em segundo plano.
    await dormir(deps.settleMs ?? 1500);
    // Contabilidade CONFIRMADA ou falha: com áudio recebido, o gasto existiu e
    // tem de estar no ledger — lançado pelo relay ou estimado aqui. Um relatório
    // verde com custo zero seria gasto fora do teto mensal (revisão do #399).
    let custo = { cost_usd: 0, events: 0 }, estimado = false, contabilidadeErro = null;
    try {
        custo = await escrita((q) => ops.custoDaSonda(q, sub.id), OPS_TIMEOUT_MS);
        if (custo.events === 0 && audioBytes > 0) {
            // A fala foi cortada antes do response.done: o relay não pôde medir.
            // Estimativa + releitura na MESMA transação: ou as duas valem, ou nenhuma.
            custo = await escrita(async (q) => {
                await ops.registrarEstimativa(q, { workId, submissionId: sub.id, audioSeconds: audioBytes / 48000 });
                return ops.custoDaSonda(q, sub.id);
            }, OPS_TIMEOUT_MS);
            estimado = true;
            if (custo.events === 0) contabilidadeErro = "a estimativa não ficou persistida no ledger";
        }
    } catch (err) { contabilidadeErro = err.message; }

    const detail = {
        submission_token: sub.submission_token, connect_ms: connectMs, first_audio_ms: firstAudioMs,
        audio_bytes: audioBytes, audio_frames: audioFrames, audio_seconds: Math.round(audioBytes / 48000 * 10) / 10,
        events: eventos.slice(0, 20), ws_close_code: fechado, probes_cleaned: apagadas, total_ms: Date.now() - t0,
        realtime_cost_events: custo.events, cost_estimated: estimado, accounting_error: contabilidadeErro, billed_to_work: workId,
    };
    if (connectMs === null) return resultado("fail", { ...detail, reason: `o relay não aceitou a conexão (${eventos.join(", ") || "sem evento"})` }, custo.cost_usd);
    if (audioBytes < MIN_AUDIO_BYTES) return resultado("fail", { ...detail, reason: "o examinador não falou (menos de 0,5 s de áudio)" }, custo.cost_usd);
    if (contabilidadeErro) return resultado("fail", { ...detail, reason: `houve fala, mas o gasto não ficou confirmado no ledger: ${contabilidadeErro}` }, custo.cost_usd);
    return resultado(firstAudioMs > FIRST_AUDIO_WARN_MS ? "warn" : "ok", detail, custo.cost_usd);
}

export const E2E_CHECKS = [
    { id: "realtime_b", label: "Realtime, perna B (navegador ↔ relay ↔ OpenAI)", level: "e2e", db: false, paid: true, budget_ms: DEEP_BUDGET_MS, run: checkRealtimeB },
];
