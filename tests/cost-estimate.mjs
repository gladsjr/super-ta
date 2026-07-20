// Estimativa de CUSTO por entrevista — MODO TEXTO, 6 perguntas, aluno enrolado.
//
// Cria UM trabalho (Business Owner, texto, 6 perguntas), N submissões, roda a
// entrevista de cada uma com o "Bruno adversarial" (domina o trabalho mas é
// evasivo nos pontos quantitativos), depois executa o pipeline de lote
// (avaliar → devolutiva → nota → publicar devolutiva → publicar nota). Ao fim,
// lê o custo REAL por submissão em work_cost_events e calcula média/mediana.
//
// O aluno simulado usa o FAST_MODEL e NÃO passa pelo medidor (não é cobrado ao
// trabalho) — é overhead do teste, não da entrevista.
//
// Uso: node -r dotenv/config tests/cost-estimate.mjs
//   Ajustes por env: N_SUBS (default 10), CONC (default 4), BUDGET_USD (50).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { openai } from "../lib/openaiClient.js";
import { FAST_MODEL, PRINCIPAL_REASONING_MODEL, PRINCIPAL_REASONING_EFFORT } from "../lib/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE || "http://127.0.0.1:5000";
const N_SUBS = Number(process.env.N_SUBS || 10);
const CONC = Number(process.env.CONC || 4);
const BUDGET_USD = Number(process.env.BUDGET_USD || 50);
const MINERACAO = "C:/Users/glads/Dropbox/Projetos/ORATIA/mineracao";
const ENUNCIADO_PDF = path.join(MINERACAO, "Enunciado Trabalho Mineração Bitcoin - Cliente.pdf");
const TRABALHO_PDF = path.join(MINERACAO, "Trabalho-Claude-02.pdf");
const MAX_STUDENT_TURNS = 26;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const STUDENT_SYSTEM =
    "Você é Bruno, um aluno que FEZ e ENTENDE o seu trabalho de viabilidade de mineração de Bitcoin " +
    "(fazenda com energia excedente, três cenários, VPL em 10 anos, taxa de desconto, hashrate da rede, " +
    "trajetória de preço do BTC). Está numa entrevista ORAL ao vivo com a cliente/dona, SEM planilha nem " +
    "calculadora agora. Fale português do Brasil falado: frases curtas, tom de conversa, sem listas.\n\n" +
    "POSTURA ADVERSARIAL (de propósito, para estressar a entrevistadora): quando o ponto for QUANTITATIVO, " +
    "seja EVASIVO e fique OFERECENDO calcular — diga coisas como 'se você quiser eu rodo a planilha e te " +
    "trago o número certinho', 'posso refazer essa conta', 'consigo te dar o valor exato depois' — para " +
    "tentar fazer ela PEDIR o número exato. Dê respostas vagas/incompletas que convidem a um 'mas de quanto " +
    "exatamente?'. De vez em quando, aponte de leve uma divergência entre o texto e a tabela do seu relatório.\n\n" +
    "MAS — regra inquebrável: você NUNCA para para 'fazer a conta' e despeja um número recalculado de cabeça. " +
    "Se a entrevistadora insistir no valor exato, reafirma com naturalidade que precisaria abrir a planilha " +
    "depois e oferece DIREÇÃO (sobe/desce), MECANISMO (por quê) e ORDEM DE GRANDEZA. Se ela aceitar o " +
    "qualitativo e seguir, coopere. Responda só o que foi perguntado. Nome: 'Bruno'. Se pedirem ok para começar, confirme curto.";

const sleep = ms => new Promise(r => setTimeout(r, ms));
function pdfBlob(file) { return new Blob([fs.readFileSync(file)], { type: "application/pdf" }); }

function jar() {
    let cookie = "";
    return {
        capture(res) { const s = res.headers.get("set-cookie"); if (s) cookie = s.split(";")[0]; },
        header() { return cookie ? { Cookie: cookie } : {}; },
    };
}
async function jfetch(j, pathname, opts = {}) {
    const res = await fetch(BASE + pathname, { ...opts, headers: { ...(opts.headers || {}), ...j.header() } });
    j.capture(res);
    return res;
}
async function asJson(res, what) {
    const t = await res.text();
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status} — ${t.slice(0, 400)}`);
    try { return JSON.parse(t); } catch { throw new Error(`${what}: não-JSON — ${t.slice(0, 300)}`); }
}
async function jpost(j, pathname, body, what) {
    return asJson(await jfetch(j, pathname, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
    }), what);
}

async function studentReply(history, question) {
    const convo = history.map(h => `${h.role === "interviewer" ? "Entrevistadora" : "Aluno"}: ${h.text}`).join("\n");
    const input = (convo ? `Conversa até agora:\n${convo}\n\n` : "") +
        `Última fala da entrevistadora (responda só a isto, 1 a 4 frases):\n${question}`;
    const res = await openai.responses.create({ model: FAST_MODEL, instructions: STUDENT_SYSTEM, input });
    const text = (res.output_text || "").trim();
    if (!text) throw new Error("aluno simulado devolveu vazio");
    return text;
}

// Roda UMA entrevista até finalizar. Usa jar próprio (endpoints /s/ são
// autenticados pelo token da submissão, não por sessão) → seguro em paralelo.
async function runInterview(subToken, label) {
    const j = jar();
    const t0 = Date.now();
    try {
        await asJson(await jfetch(j, `/s/${subToken}/start`, { method: "POST" }), `start ${label}`);
        let assistant;
        {
            const fd = new FormData();
            fd.append("file", pdfBlob(TRABALHO_PDF), "Trabalho-Claude-02.pdf");
            const up = await asJson(await jfetch(j, `/s/${subToken}/upload`, { method: "POST", body: fd }), `upload ${label}`);
            assistant = up.assistant;
        }
        const history = [];
        const turnLatencies = []; // {ms, phase} — phase ANTES da chamada (intro = agente rápido; interviewing = orquestrador)
        let phase = "intro", turns = 0;
        for (let turn = 1; turn <= MAX_STUDENT_TURNS; turn++) {
            history.push({ role: "interviewer", text: assistant });
            if (phase === "finalizing" || phase === "finalized") break;
            const reply = await studentReply(history, assistant);
            history.push({ role: "student", text: reply });
            // retry leve em falha transitória do /chat
            let chat, lastErr, chatMs = null;
            const phaseBefore = phase;
            for (let a = 0; a < 3; a++) {
                const tChat = Date.now();
                try { chat = await jpost(j, `/s/${subToken}/chat`, { message: reply }, `chat ${label} t${turn}`); chatMs = Date.now() - tChat; break; }
                catch (e) { lastErr = e; await sleep(1500 * (a + 1)); }
            }
            if (!chat) throw lastErr;
            turnLatencies.push({ ms: chatMs, phase: phaseBefore });
            assistant = chat.assistant;
            if (chat.phase) phase = chat.phase;
            turns = turn;
        }
        return { label, subToken, ok: true, turns, phase, turnLatencies, secs: Math.round((Date.now() - t0) / 1000) };
    } catch (err) {
        return { label, subToken, ok: false, error: err.message, secs: Math.round((Date.now() - t0) / 1000) };
    }
}

async function poolRun(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

async function runBatch(j, workToken, pathname, key) {
    const res = await jfetch(j, pathname, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (res.status === 400) { console.log(`  [${key}] nada a fazer: ${(await res.text()).slice(0, 120)}`); return; }
    await asJson(res, `start ${key}`);
    for (;;) {
        await sleep(3000);
        const st = await asJson(await jfetch(j, `/w/${workToken}/evaluations/status`), "status");
        const s = st[key];
        if (!s) continue;
        process.stdout.write(`\r  [${key}] ${s.done}/${s.total} ok=${s.ok} skip=${s.skipped} fail=${s.failed?.length || 0}     `);
        if (!s.running) {
            console.log(`\n  → ${key}: ok=${s.ok} skip=${s.skipped} fail=${s.failed?.length || 0} stop=${s.stopped_reason || "-"}`);
            if (s.failed?.length) console.log("    fails:", JSON.stringify(s.failed).slice(0, 400));
            break;
        }
    }
}

const POS_RE = /InterviewEvaluator|StudentFeedback|Grading/i;
function median(xs) {
    if (!xs.length) return 0;
    const a = [...xs].sort((x, y) => x - y), m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const usd = n => `$${n.toFixed(4)}`;

async function costReport(workToken) {
    // Eventos COM submission_id (conversa: prep + orquestrador + intro) — dão a
    // distribuição por aluno (média/mediana/faixa).
    const { rows: perRows } = await pool.query(
        `SELECT s.submission_token AS tok, e.agent_label AS label, SUM(e.cost_usd)::float8 AS cost
         FROM work_cost_events e
         JOIN submissions s ON s.id = e.submission_id
         WHERE e.work_id = (SELECT id FROM works WHERE work_token = $1)
         GROUP BY s.submission_token, e.agent_label`,
        [workToken]
    );
    // TODOS os eventos (inclui avaliação/devolutiva/nota, gravados SEM
    // submission_id) — dão o total e o detalhamento por rótulo corretos.
    const { rows: allRows } = await pool.query(
        `SELECT e.agent_label AS label, SUM(e.cost_usd)::float8 AS cost,
                SUM(COALESCE(e.output_tokens,0))::bigint AS out_tok, COUNT(*)::int AS n
         FROM work_cost_events e
         WHERE e.work_id = (SELECT id FROM works WHERE work_token = $1)
         GROUP BY e.agent_label`,
        [workToken]
    );
    const perSub = new Map();      // tok -> {conversa} (só eventos com submission_id)
    for (const r of perRows) {
        const sub = perSub.get(r.tok) || { conversa: 0 };
        sub.conversa += r.cost;   // todos os com_sub são de conversa
        perSub.set(r.tok, sub);
    }
    const byLabelAll = new Map();  // label -> {cost, out_tok, n}
    let grandTotal = 0;
    for (const r of allRows) {
        grandTotal += r.cost;
        byLabelAll.set(r.label, { cost: r.cost, out_tok: Number(r.out_tok), n: r.n });
    }
    return { perSub, byLabelAll, grandTotal };
}

async function main() {
    console.log(`[cfg] base=${BASE} N=${N_SUBS} conc=${CONC} budget=$${BUDGET_USD}`);
    const j = jar();
    await jpost(j, "/login", { username: "professor", password: "senha123" }, "login");

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const { work } = await jpost(j, "/admin/works", { name: `CUSTO texto 6q enrolado ${stamp}` }, "create work");
    const workToken = work.work_token;
    console.log(`[work] ${workToken}`);

    // orçamento alto para nada travar no meio
    await pool.query(`UPDATE works SET budget_usd = $1 WHERE work_token = $2`, [BUDGET_USD, workToken]);

    {
        const fd = new FormData();
        fd.append("file", pdfBlob(ENUNCIADO_PDF), "enunciado-mineracao.pdf");
        await asJson(await jfetch(j, `/w/${workToken}/enunciado`, { method: "POST", body: fd }), "upload enunciado");
    }
    {
        const tpl = await jfetch(j, `/interviewers/templates/${encodeURIComponent("Business Owner.yaml")}`);
        await jpost(j, `/w/${workToken}/interviewer`, { yaml: await tpl.text() }, "save interviewer");
    }
    await jpost(j, `/w/${workToken}/question-count`, { question_count: 6 }, "question-count");
    await jpost(j, `/w/${workToken}/interaction`, { mode: "text" }, "interaction mode");
    console.log(`[work] configurado: Business Owner, texto, 6 perguntas`);

    // cria N submissões
    const subs = [];
    for (let i = 0; i < N_SUBS; i++) {
        const { submissions } = await jpost(j, `/w/${workToken}/submissions`,
            { label: `Aluno ${String(i + 1).padStart(2, "0")} (enrolado)` }, `submission ${i + 1}`);
        subs.push({ token: submissions[0].submission_token, label: `Aluno ${String(i + 1).padStart(2, "0")}` });
    }
    console.log(`[subs] ${subs.length} submissões criadas`);

    // ---- PILOTO: 1 entrevista, mede antes de liberar as demais ----
    console.log(`\n=== PILOTO (1 entrevista) ===`);
    const pilot = await runInterview(subs[0].token, subs[0].label);
    console.log(`[piloto] ${pilot.label}: ok=${pilot.ok} turnos=${pilot.turns ?? "-"} fase=${pilot.phase ?? "-"} ${pilot.secs}s ${pilot.error ? "ERRO:" + pilot.error : ""}`);
    if (!pilot.ok) { console.error("PILOTO FALHOU — abortando antes de gastar nas demais."); process.exit(1); }
    {
        const { perSub } = await costReport(workToken);
        const p = perSub.get(subs[0].token);
        console.log(`[piloto] custo da CONVERSA medido: ${p ? usd(p.conversa) : "$0"} (avaliação/nota entram no lote depois)`);
    }

    // ---- as 9 restantes em paralelo ----
    console.log(`\n=== ENTREVISTAS 2..${N_SUBS} (concorrência ${CONC}) ===`);
    const rest = await poolRun(subs.slice(1), CONC, s => runInterview(s.token, s.label));
    const all = [pilot, ...rest];
    for (const r of all) console.log(`  ${r.label}: ok=${r.ok} turnos=${r.turns ?? "-"} fase=${r.phase ?? "-"} ${r.secs}s ${r.error ? "ERRO:" + r.error : ""}`);
    const okCount = all.filter(r => r.ok).length;
    console.log(`[entrevistas] ${okCount}/${N_SUBS} concluídas`);

    // ---- pipeline de lote ----
    console.log(`\n=== LOTE: avaliar → devolutiva → nota → publicar ===`);
    await runBatch(j, workToken, `/w/${workToken}/evaluations`, "batch");
    await runBatch(j, workToken, `/w/${workToken}/evaluations/student-versions`, "derive");
    await runBatch(j, workToken, `/w/${workToken}/evaluations/grades`, "grade");
    await runBatch(j, workToken, `/w/${workToken}/evaluations/publish`, "publish");
    await runBatch(j, workToken, `/w/${workToken}/evaluations/grade-publish`, "grade_publish");

    // ---- relatório de custo ----
    console.log(`\n=== CUSTO (medido em work_cost_events) ===`);
    const { perSub, byLabelAll, grandTotal } = await costReport(workToken);
    const conversas = [...perSub.values()].map(v => v.conversa);
    const sum = xs => xs.reduce((a, b) => a + b, 0);
    const mean = xs => xs.length ? sum(xs) / xs.length : 0;
    const conversaTotal = sum(conversas);
    const posTotal = grandTotal - conversaTotal;   // avaliação+devolutiva+nota (sem submission_id)

    const { rows: wr } = await pool.query(`SELECT spent_usd::float8 AS spent, budget_usd::float8 AS budget FROM works WHERE work_token=$1`, [workToken]);
    const turnsArr = all.filter(r => r.ok).map(r => r.turns);
    const n = okCount || N_SUBS;

    // Latência por turno do /chat (percebida pelo aluno no modo texto):
    // intro = IntroductionAgent (fast); interviewing+ = SuperOrchestrator.
    const allLat = all.filter(r => r.ok).flatMap(r => r.turnLatencies || []).filter(l => Number.isFinite(l.ms));
    const orchMs = allLat.filter(l => l.phase !== "intro").map(l => l.ms);
    const introMs = allLat.filter(l => l.phase === "intro").map(l => l.ms);
    const p90 = xs => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(0.9 * a.length))]; };
    const latencyReport = {
        orchestrator_turn_ms: { n: orchMs.length, mean: Math.round(mean(orchMs)), median: Math.round(median(orchMs)), p90: p90(orchMs) },
        intro_turn_ms: { n: introMs.length, mean: Math.round(mean(introMs)), median: Math.round(median(introMs)) },
    };

    const report = {
        work_token: workToken,
        professor_panel: `${BASE}/w/${workToken}`,
        n_submissions: N_SUBS,
        n_ok: okCount,
        model: `${PRINCIPAL_REASONING_MODEL} (effort ${PRINCIPAL_REASONING_EFFORT || "default"}) principal + ${FAST_MODEL} fast`,
        mode: "texto, 6 perguntas, aluno enrolado (adversarial)",
        latency: latencyReport,
        turns: { mean: +mean(turnsArr).toFixed(1), median: median(turnsArr), min: Math.min(...turnsArr), max: Math.max(...turnsArr) },
        // ponta-a-ponta: total do trabalho ÷ N (o pós não tem submission_id, então
        // média é o que dá para afirmar; conversa tem distribuição por aluno).
        cost_end_to_end_usd: { mean: grandTotal / n, total: grandTotal },
        cost_conversa_usd: { mean: mean(conversas), median: median(conversas), min: Math.min(...conversas), max: Math.max(...conversas) },
        cost_pos_usd: { mean: posTotal / n, total: posTotal },
        work_spent_usd: wr[0]?.spent,
        by_label: Object.fromEntries([...byLabelAll].sort((a, b) => b[1].cost - a[1].cost)
            .map(([k, v]) => [k, { cost: +v.cost.toFixed(4), per_interview: +(v.cost / n).toFixed(4), pct: +(v.cost / grandTotal * 100).toFixed(1), out_tok: v.out_tok, calls: v.n }])),
        per_sub_conversa: [...perSub].map(([tok, v]) => ({ tok: tok.slice(0, 10), conversa: +v.conversa.toFixed(4) })),
    };

    console.log(`\nModo: ${report.mode}`);
    console.log(`Modelo: ${report.model}`);
    console.log(`Entrevistas OK: ${okCount}/${N_SUBS} | turnos méd=${report.turns.mean} (min ${report.turns.min}, max ${report.turns.max})`);
    console.log(`\n── LATÊNCIA POR TURNO (/chat, percebida no modo texto) ──`);
    console.log(`  ORQUESTRADOR (${latencyReport.orchestrator_turn_ms.n} turnos): méd ${(latencyReport.orchestrator_turn_ms.mean / 1000).toFixed(1)}s | med ${(latencyReport.orchestrator_turn_ms.median / 1000).toFixed(1)}s | p90 ${(latencyReport.orchestrator_turn_ms.p90 / 1000).toFixed(1)}s`);
    console.log(`  intro/fast (${latencyReport.intro_turn_ms.n} turnos):   méd ${(latencyReport.intro_turn_ms.mean / 1000).toFixed(1)}s`);
    console.log(`\n── CUSTO POR ENTREVISTA (ponta-a-ponta: prep+conversa+avaliação+devolutiva+nota) ──`);
    console.log(`  MÉDIA (total ÷ ${n}):   ${usd(report.cost_end_to_end_usd.mean)}`);
    console.log(`\n  só a CONVERSA (prep+entrevista):  méd ${usd(report.cost_conversa_usd.mean)} | med ${usd(report.cost_conversa_usd.median)} | faixa ${usd(report.cost_conversa_usd.min)}…${usd(report.cost_conversa_usd.max)}`);
    console.log(`  só o PÓS (avaliação+devolutiva+nota): méd ${usd(report.cost_pos_usd.mean)}`);
    console.log(`\n── ONDE O DINHEIRO VAI (por entrevista, ÷${n}) ──`);
    for (const [k, v] of Object.entries(report.by_label)) console.log(`  ${k.padEnd(34)} ${usd(v.per_interview).padStart(10)}  ${String(v.pct).padStart(5)}%  (${v.calls} chamadas)`);
    console.log(`\nGasto total do trabalho (works.spent_usd): ${usd(report.work_spent_usd)}`);
    console.log(`Painel do professor: ${report.professor_panel}`);

    const outDir = path.join(__dirname, "runs-text");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `cost-estimate-${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\nRelatório JSON: ${outFile}`);
    await pool.end();
}

main().catch(async err => { console.error("ERRO:", err.message); try { await pool.end(); } catch {} process.exit(1); });
