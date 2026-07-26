// Backfill do custo de VOZ Realtime contaminado — os eventos que o bug de preço
// gravou como US$ 0 desde 07/07 (modelo passou a gpt-realtime-2.1 sem entrada em
// pricing.yaml; corrigido no PR #117). Escopo: UMA work por vez (work_token em
// parâmetro), rodado pelo admin via botão em produção.
//
// Princípios:
// - NÃO-destrutivo: não altera os eventos zerados. INSERE uma linha de AJUSTE
//   (agent_label 'BACKFILL:realtime-voice evt=<id>', tokens NULL) por evento
//   contaminado, com o custo ESTIMADO, e soma no works.spent_usd. O histórico do
//   bug fica visível; para desfazer, apagar as linhas BACKFILL e baixar o spent.
// - IDEMPOTENTE: se já houver ajuste BACKFILL na work, o apply recusa (no-op).
//   O seletor de contaminados também exclui linhas 'BACKFILL%'.
// - ESTIMATIVA, não fatura: os eventos antigos não têm o split áudio/texto (só
//   da migration 051 em diante), então o custo vem dos agregados × preço
//   corrigido com frações de áudio calibradas na fatura real
//   (estimateRealtimeCostFromAggregate). Precisão por-work ~boa; o número real
//   definitivo do passado só sai da Costs API da OpenAI.
import { pool } from "../auth.js";
import { estimateRealtimeCostFromAggregate, REALTIME_BACKFILL_AUDIO_FRAC } from "./billing.js";
import log from "./logger.js";

const BACKFILL_LABEL = "BACKFILL:realtime-voice";

async function resolveWork(client, workToken) {
    const r = await client.query(
        "SELECT id, name, work_token, spent_usd::float8 AS spent_usd FROM works WHERE work_token = $1",
        [workToken]
    );
    return r.rows[0] || null;
}

// Eventos realtime contaminados: custo 0, com tokens, e que ainda não são ajustes.
async function contaminatedEvents(client, workId) {
    const r = await client.query(
        `SELECT id, submission_id, model, input_tokens, cached_tokens, output_tokens, created_at
           FROM work_cost_events
          WHERE work_id = $1 AND event_type = 'realtime'
            AND cost_usd = 0
            AND (COALESCE(input_tokens, 0) > 0 OR COALESCE(output_tokens, 0) > 0)
            AND (agent_label IS NULL OR agent_label NOT LIKE 'BACKFILL%')
          ORDER BY id`,
        [workId]
    );
    return r.rows;
}

async function priorBackfill(client, workId) {
    const r = await client.query(
        "SELECT COUNT(*)::int AS n, COALESCE(SUM(cost_usd), 0)::float8 AS usd FROM work_cost_events WHERE work_id = $1 AND agent_label LIKE 'BACKFILL%'",
        [workId]
    );
    return r.rows[0];
}

function estimates(ev) {
    const args = { model: ev.model, inputTokens: ev.input_tokens, cachedTokens: ev.cached_tokens, outputTokens: ev.output_tokens };
    return {
        central: estimateRealtimeCostFromAggregate(args),
        low: estimateRealtimeCostFromAggregate({ ...args, audioFracInput: 0.0, audioFracOutput: 0.60 }),
        high: estimateRealtimeCostFromAggregate({ ...args, audioFracInput: 0.45, audioFracOutput: 0.80 }),
    };
}

// Preview (não escreve nada): mostra o que o apply faria.
export async function previewRealtimeBackfill(workToken) {
    const client = await pool.connect();
    try {
        const work = await resolveWork(client, workToken);
        if (!work) return { ok: false, error: "work não encontrada" };
        const evs = await contaminatedEvents(client, work.id);
        const prior = await priorBackfill(client, work.id);
        let central = 0, low = 0, high = 0, priced = 0, unpriced = 0;
        const bySub = new Map();
        for (const ev of evs) {
            const est = estimates(ev);
            if (est.central == null) { unpriced++; continue; }
            priced++;
            central += est.central; low += est.low; high += est.high;
            const k = ev.submission_id ?? "sem-submissão";
            const cur = bySub.get(k) || { submission_id: ev.submission_id, events: 0, central: 0 };
            cur.events++; cur.central += est.central; bySub.set(k, cur);
        }
        return {
            ok: true,
            work: { work_token: work.work_token, name: work.name, spent_usd: work.spent_usd },
            already_backfilled: prior.n > 0,
            prior_backfill: { events: prior.n, usd: prior.usd },
            contaminated_events: evs.length,
            priced_events: priced,
            unpriced_events: unpriced,
            per_submission: [...bySub.values()].sort((a, b) => (a.submission_id || 0) - (b.submission_id || 0)),
            estimate: { central, low, high },
            new_spent_usd_estimate: work.spent_usd + central,
            assumptions: REALTIME_BACKFILL_AUDIO_FRAC,
        };
    } finally {
        client.release();
    }
}

// Apply (transacional + idempotente): insere as linhas de ajuste e soma no spent.
export async function applyRealtimeBackfill(workToken) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const work = await resolveWork(client, workToken);
        if (!work) { await client.query("ROLLBACK"); return { ok: false, error: "work não encontrada" }; }
        const prior = await priorBackfill(client, work.id);
        if (prior.n > 0) {
            await client.query("ROLLBACK");
            return { ok: false, error: "backfill já aplicado nesta work", already_backfilled: true, prior_backfill: { events: prior.n, usd: prior.usd } };
        }
        const evs = await contaminatedEvents(client, work.id);
        let added = 0, count = 0, unpriced = 0;
        for (const ev of evs) {
            const cost = estimateRealtimeCostFromAggregate({ model: ev.model, inputTokens: ev.input_tokens, cachedTokens: ev.cached_tokens, outputTokens: ev.output_tokens });
            if (cost == null) { unpriced++; continue; }
            await client.query(
                `INSERT INTO work_cost_events (work_id, submission_id, event_type, model, agent_label, cost_usd)
                 VALUES ($1, $2, 'realtime', $3, $4, $5)`,
                [work.id, ev.submission_id, ev.model, `${BACKFILL_LABEL} evt=${ev.id}`, cost]
            );
            added += cost; count++;
        }
        await client.query("UPDATE works SET spent_usd = spent_usd + $1, updated_at = now() WHERE id = $2", [added, work.id]);
        await client.query("COMMIT");
        log.info("BACKFILL", `realtime voice work=${work.work_token} events=${count} added=$${added.toFixed(4)} unpriced=${unpriced}`);
        return { ok: true, applied: true, events: count, unpriced_events: unpriced, added_usd: added, new_spent_usd: work.spent_usd + added };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => { });
        log.error("BACKFILL", `apply falhou: ${err.message}`);
        return { ok: false, error: err.message };
    } finally {
        client.release();
    }
}
