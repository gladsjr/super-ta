// Fase 1 — avaliação de QUALIDADE das conversas multiagente (TEXTO).
//
// Roda cada cenário da matriz ponta a ponta: ScenarioOrchestratorAgent (real)
// conduz as personas; um ALUNO SIMULADO (modelo barato) responde; um JUIZ-LLM
// pontua a conversa. Tudo em texto.
//
// CUSTO: embrulha openai.responses.create num contador com TETO DURO pré-checado
// (--max-usd). Avisa ao cruzar o limiar de alerta e PARA antes do teto.
//
// Uso:
//   node tests/scenario-eval.mjs --dry                 # stubs, ZERO token, valida o pipeline
//   node tests/scenario-eval.mjs --max-usd 60          # run real (precisa OPENAI_API_KEY)
//   node tests/scenario-eval.mjs --only m_banca,m_clinico --max-usd 30
//
// Relatório (run real): tests/runs-text/scenario-eval-<ts>.json + resumo no stdout.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
    scenarioFrame, interactionStartLive, respondLive, buildRunMemory,
} from "../lib/scenarios/liveEngine.js";
import { extractJsonObject } from "../lib/scenarios/scenarioActionSchema.js";
import { MATRIX } from "./scenario-matrix.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- args ----
const args = process.argv.slice(2);
const has = f => args.includes(f);
const valOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = has("--dry");
const MAX_USD = parseFloat(valOf("--max-usd", "60"));
const WARN_USD = parseFloat(valOf("--warn-usd", String(Math.min(40, MAX_USD * 0.66))));
const ONLY = (valOf("--only", "") || "").split(",").map(s => s.trim()).filter(Boolean);
const MAX_TURNS_PER_INTERACTION = parseInt(valOf("--max-turns", "4"), 10); // teto de custo por etapa (≤ teto do engine)

const scenarios = ONLY.length ? MATRIX.filter(s => ONLY.includes(s.id)) : MATRIX;

// ---- contador de custo + teto ----
const tally = { spent: 0, calls: 0, byModel: {} };
function note(model, cost) { tally.spent += cost; tally.calls++; tally.byModel[model] = (tally.byModel[model] || 0) + cost; }
function guard() {
    if (tally.spent >= MAX_USD) {
        throw new Error(`TETO DE CUSTO atingido: $${tally.spent.toFixed(2)} ≥ $${MAX_USD.toFixed(2)} — execução interrompida.`);
    }
}
let warned = false;
function maybeWarn() {
    if (!warned && tally.spent >= WARN_USD) { warned = true; console.log(`\n⚠️  ALERTA DE CUSTO: já gastei $${tally.spent.toFixed(2)} (limiar $${WARN_USD.toFixed(2)}; teto $${MAX_USD.toFixed(2)}).\n`); }
}

// ---- modos: stubs (dry) ou agentes reais ----
let agent, askStudent, askJudge, PRINCIPAL, FAST;

if (DRY) {
    PRINCIPAL = "(dry)"; FAST = "(dry)";
    agent = {
        interactionOpener: async ({ interaction }) => ({ speaker_persona_id: interaction.opener_persona_id, action: { kind: "speak", message: "[DRY] abertura da persona conforme a instrução." }, rationale: "dry", memory: {} }),
        studentTurn: async ({ interaction, position, total }) => {
            // alterna falante e avança após algumas trocas (simula o teto natural)
            const p = interaction.participants;
            const advance = Math.random() < 0; // determinístico-ish via contador externo
            return { speaker_persona_id: p[0].persona_id, action: { kind: "speak", message: "[DRY] a persona reage e pergunta algo." }, rationale: "dry", memory: { free_notes: `etapa ${position}/${total}` } };
        },
        personaExchange: async ({ interaction }) => ({ lines: interaction.participants.map(p => ({ speaker_persona_id: p.persona_id, message: "[DRY] fala entre as personas sobre o foco." })), rationale: "dry" }),
    };
    askStudent = async () => "[DRY] resposta do aluno simulado.";
    askJudge = async () => ({ scores: { role_fidelity: 4, objective_adherence: 4, persona_distinctiveness: 4, turn_routing: 4, persona_exchange_realism: null, context_carryover: 4, no_leakage: 5, naturalness: 4, termination: 4 }, overall: 4, notes: "[DRY] sem julgamento real.", flags: [] });
} else {
    const dotenv = await import("dotenv");
    dotenv.config();
    if (!process.env.OPENAI_API_KEY) { console.error("Falta OPENAI_API_KEY (defina no .env)."); process.exit(2); }
    const OpenAI = (await import("openai")).default;
    const { ScenarioOrchestratorAgent } = await import("../agents/ScenarioOrchestratorAgent.js");
    const cfg = await import("../lib/config.js");
    const billing = await import("../lib/billing.js");
    billing.loadPricing();
    PRINCIPAL = cfg.PRINCIPAL_REASONING_MODEL; FAST = cfg.FAST_MODEL;

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    // Embrulha responses.create: pré-checa o teto e soma o custo de cada chamada.
    const origCreate = client.responses.create.bind(client.responses);
    client.responses.create = async (payload) => {
        guard();
        const resp = await origCreate(payload);
        try { const { cost_usd } = billing.computeResponsesCost(resp?.usage, payload.model); note(payload.model, cost_usd); maybeWarn(); }
        catch (e) { console.error("falha ao computar custo:", e.message); }
        return resp;
    };

    agent = new ScenarioOrchestratorAgent(client, PRINCIPAL);

    // Aluno simulado (modelo barato). Texto puro. Cego ao framing de "avaliação".
    askStudent = async ({ scenario, interaction, personaLine, history }) => {
        const sys = `Você é a OUTRA PONTA de uma cena de role-play: o protagonista que apresenta/defende o próprio trabalho no contexto descrito. Responda à última fala da persona de forma plausível e natural, como alguém que domina razoavelmente o assunto mas pode ter lacunas — nem perfeito, nem evasivo. 1 a 3 frases, em primeira pessoa, sem markdown. Não quebre o personagem nem comente que é um teste.`;
        const usr = `CENÁRIO: ${scenario.name} — ${scenario.description}\nETAPA: ${interaction.title} (instrução: ${interaction.instruction || "—"}).\n\nHISTÓRICO RECENTE:\n${history || "(início)"}\n\nÚLTIMA FALA DA PERSONA:\n"""${personaLine || ""}"""\n\nSua resposta:`;
        const r = await client.responses.create({ model: FAST, instructions: sys, input: [{ role: "user", content: usr }], truncation: "auto" });
        return (r.output_text || "").trim();
    };

    // Juiz (modelo principal). Lê o transcript completo + a definição do cenário.
    askJudge = async ({ scenario, transcript }) => {
        const sys = `Você é um avaliador de QUALIDADE de conversas multiagente de role-play. Recebe a definição de um cenário (personas, objetivos, interações ordenadas) e o TRANSCRIPT de uma execução. Pontue de 1 a 5 cada dimensão e dê uma nota geral. Retorne SOMENTE JSON:
{"scores":{"role_fidelity":1-5,"objective_adherence":1-5,"persona_distinctiveness":1-5,"turn_routing":1-5,"persona_exchange_realism":1-5 ou null se não houve troca persona↔persona,"context_carryover":1-5,"no_leakage":1-5,"naturalness":1-5,"termination":1-5},"overall":1-5,"notes":"2-4 frases","flags":["problemas pontuais, se houver"]}
Dimensões: role_fidelity=cada persona se manteve no papel/autoridade/tom; objective_adherence=a interação cumpriu seu objetivo; persona_distinctiveness=personas distintas (não borradas); turn_routing=quem falou fez sentido e houve alternância adequada; persona_exchange_realism=a troca entre personas soou como deliberação real referenciando o aluno; context_carryover=personas referenciaram o que ouviram antes; no_leakage=nenhuma quebra (mencionar "aluno"/"avaliação"/"enunciado"/IA dentro da cena); naturalness=fluência; termination=encerramento sensato.`;
        const usr = `DEFINIÇÃO DO CENÁRIO:\n${JSON.stringify({ name: scenario.name, description: scenario.description, personas: scenario.personas.map(p => ({ id: p.id, name: p.name, role: p.role })), interactions: scenario.interactions.map(i => ({ title: i.title, kind: i.kind, objective: i.objective_type, focus: i.focus || undefined })) }, null, 2)}\n\nTRANSCRIPT:\n${transcript.map(e => `[${e.kind}] ${e.name ? e.name + ": " : ""}${e.text}`).join("\n")}\n\nPontue. Retorne SOMENTE o JSON.`;
        const r = await client.responses.create({ model: PRINCIPAL, instructions: sys, input: [{ role: "user", content: usr }], truncation: "auto" });
        const parsed = extractJsonObject(r.output_text || "");
        return parsed || { scores: {}, overall: null, notes: "(juiz não retornou JSON)", flags: ["judge_parse_fail"] };
    };
}

// ---- driver de um cenário ----
function currentSegment(transcript) {
    const out = []; for (let i = transcript.length - 1; i >= 0; i--) { if (transcript[i].kind === "interaction") break; out.unshift(transcript[i]); } return out;
}
const fmtSeg = seg => seg.map(e => `${e.kind === "student" ? "EU" : (e.name || "persona")}: ${e.text}`).join("\n");

async function runScenario(scenario) {
    const personasById = Object.fromEntries(scenario.personas.map(p => [p.id, p]));
    const total = scenario.interactions.length;
    const transcript = [scenarioFrame(scenario)];
    for (let idx = 0; idx < total; idx++) {
        const it = scenario.interactions[idx];
        const runMemory = buildRunMemory(scenario, transcript, idx);
        const start = await interactionStartLive(agent, { scenario, interaction: it, personasById, idx, total, runMemory, interactionMode: "text" });
        transcript.push(...start);
        if (it.kind === "persona_exchange") continue; // aluno observa e avança

        let memory = null;
        for (let turn = 0; turn < MAX_TURNS_PER_INTERACTION; turn++) {
            const lastPersona = [...transcript].reverse().find(e => e.kind === "persona");
            const reply = await askStudent({ scenario, interaction: it, personaLine: lastPersona?.text, history: fmtSeg(currentSegment(transcript)) });
            transcript.push({ speaker: "student", kind: "student", text: reply });
            const r = await respondLive(agent, { scenario, interaction: it, personasById, idx, total, transcript, memory, interactionMode: "text" });
            memory = r.memory;
            transcript.push(...r.entries);
            if (r.capped || ["advance", "finalize"].includes(r.action?.kind)) break;
        }
    }
    const verdict = await askJudge({ scenario, transcript });
    return { transcript, verdict };
}

// ---- transcript legível (.txt) ----
function renderTranscriptTxt(r) {
    const L = [`CENÁRIO: ${r.name}  —  juiz: geral ${r.verdict?.overall ?? "?"}/5`];
    for (const e of r.transcript || []) {
        if (e.kind === "scenario") L.push(`\n[CENÁRIO] ${e.text}`);
        else if (e.kind === "interaction") L.push(`\n——— ${e.text}${e.meta ? ` · ${e.meta}` : ""} ———`);
        else if (e.kind === "student") L.push(`  ALUNO: ${e.text}`);
        else if (e.kind === "aside") L.push(`  ${e.name} → (entre personas): ${e.text}`);
        else L.push(`  ${e.name}: ${e.text}`);
    }
    if (r.verdict?.notes) L.push(`\nJUIZ: ${r.verdict.notes}`);
    if (r.verdict?.flags?.length) L.push(`FLAGS: ${r.verdict.flags.join("; ")}`);
    return L.join("\n");
}

// ---- estimativa de custo (impressa no dry) ----
function estimateUsd() {
    // grosseiro: orquestrador ~$0,024/turno (gpt-5.5), aluno ~$0,003 (mini), juiz ~$0,06.
    let turns = 0, studentInteractions = 0;
    for (const s of scenarios) for (const it of s.interactions) { if (it.kind === "student") { studentInteractions++; turns += MAX_TURNS_PER_INTERACTION; } else turns += 1; }
    const orch = turns * 0.024, stu = studentInteractions * MAX_TURNS_PER_INTERACTION * 0.003, judge = scenarios.length * 0.06;
    return orch + stu + judge;
}

// ---- main ----
(async () => {
    console.log(`Fase 1 — ${DRY ? "DRY (stubs, ZERO token)" : "REAL"} | cenários: ${scenarios.map(s => s.id).join(", ")}`);
    console.log(`modelos: orquestrador/juiz=${PRINCIPAL}, aluno=${FAST} | max-turns/etapa=${MAX_TURNS_PER_INTERACTION}`);
    if (!DRY) console.log(`teto: $${MAX_USD.toFixed(2)} (alerta em $${WARN_USD.toFixed(2)})`);
    console.log(`estimativa grosseira: ~$${estimateUsd().toFixed(2)}\n`);

    const results = [];
    for (const s of scenarios) {
        process.stdout.write(`▶ ${s.id} (${s.name})… `);
        try {
            const { transcript, verdict } = await runScenario(s);
            results.push({ id: s.id, name: s.name, verdict, turns: transcript.length, transcript });
            console.log(`ok — geral ${verdict.overall ?? "?"}/5${DRY ? "" : ` | acumulado $${tally.spent.toFixed(2)}`}`);
        } catch (e) {
            results.push({ id: s.id, name: s.name, error: e.message });
            console.log(`FALHOU: ${e.message}`);
            if (/TETO DE CUSTO/.test(e.message)) break;
        }
    }

    console.log(`\n==== RESUMO ====`);
    for (const r of results) {
        if (r.error) { console.log(`  ${r.id}: ERRO — ${r.error}`); continue; }
        const sc = r.verdict.scores || {};
        const dims = Object.entries(sc).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(" ");
        console.log(`  ${r.id}: geral ${r.verdict.overall ?? "?"}/5 | ${dims}`);
        if (r.verdict.flags?.length) console.log(`     flags: ${r.verdict.flags.join("; ")}`);
    }
    if (!DRY) {
        console.log(`\nCUSTO TOTAL: $${tally.spent.toFixed(2)} em ${tally.calls} chamadas (${Object.entries(tally.byModel).map(([m, c]) => `${m}: $${c.toFixed(2)}`).join(", ")})`);
        const outDir = path.join(DIR, "runs-text");
        fs.mkdirSync(outDir, { recursive: true });
        const stamp = Date.now();
        const outPath = path.join(outDir, `scenario-eval-${stamp}.json`);
        fs.writeFileSync(outPath, JSON.stringify({ when: new Date().toISOString(), tally, results }, null, 2));
        const txtPath = path.join(outDir, `scenario-eval-${stamp}.txt`);
        fs.writeFileSync(txtPath, results.filter(r => r.transcript).map(renderTranscriptTxt).join("\n\n" + "=".repeat(72) + "\n\n"));
        console.log(`relatório: ${path.relative(path.join(DIR, ".."), outPath)}`);
        console.log(`transcripts: ${path.relative(path.join(DIR, ".."), txtPath)}`);
    } else {
        console.log(`\n(dry) pipeline validado. Para rodar de verdade: node tests/scenario-eval.mjs --max-usd ${MAX_USD}`);
    }
})();
