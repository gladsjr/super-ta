// Driver de teste E2E em MODO TEXTO para validar o "princípio da resposta
// formulável de cabeça". Não dirige browser nem áudio: fala direto com os
// endpoints HTTP do servidor (que já deve estar no ar), exercitando o
// PrepBuilder (plano) e o SuperOrchestrator (asks + follow_ups) reais.
//
// Cenário: enunciado e trabalho REAIS de mineração de Bitcoin, persona
// Business Owner, 6 perguntas. O aluno simulado DOMINA o trabalho mas está
// numa conversa ao vivo e se RECUSA a recalcular números na hora — responde
// com direção + mecanismo + ordem de grandeza. O que queremos observar: a
// Larissa aceita isso e segue, em vez de insistir pelo valor exato recalculado?
//
// Uso: node -r dotenv/config tests/text-e2e-mineracao.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openai } from "../lib/openaiClient.js";
import { FAST_MODEL } from "../lib/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE || "http://127.0.0.1:5099";
const MINERACAO = "C:/Users/glads/Dropbox/Projetos/ORATIA/mineracao";
const ENUNCIADO_PDF = path.join(MINERACAO, "Enunciado Trabalho Mineração Bitcoin - Cliente.pdf");
const TRABALHO_PDF = path.join(MINERACAO, "Trabalho-Claude-02.pdf");
const MAX_STUDENT_TURNS = 20;

const STUDENT_SYSTEM =
    "Você é Bruno, um aluno que FEZ e ENTENDE o seu trabalho de viabilidade econômica de " +
    "mineração de Bitcoin (fazenda que aproveita energia excedente, três cenários — otimista, " +
    "neutro, pessimista —, VPL em 10 anos, taxa de desconto, crescimento do hashrate da rede, " +
    "trajetória de preço do Bitcoin). Está numa entrevista ORAL ao vivo com a cliente/dona do " +
    "empreendimento. Fale em português do Brasil falado: frases curtas, tom de conversa, sem ler " +
    "em voz alta, sem listas.\n\n" +
    "DOMÍNIO: você recorda, explica, compara e defende com naturalidade os números e premissas que " +
    "JÁ ESTÃO no seu relatório quando fizer sentido (ex.: VPL por cenário, taxa de desconto, " +
    "hashrate, preço do BTC). Isso você sabe de cabeça porque é seu trabalho.\n\n" +
    "LIMITE REALISTA (IMPORTANTE): você NÃO tem planilha nem calculadora à mão agora. Se a " +
    "entrevistadora pedir para RECALCULAR um número novo sob outra premissa (ex.: 'de quanto cairia " +
    "o VPL se o CAPEX subisse', 'recalcule a sensibilidade', 'qual o VPL exato sem o upgrade', 'quanto " +
    "muda a TIR'), você NÃO inventa nem chuta um número preciso. Você responde com a DIREÇÃO (sobe ou " +
    "desce, melhora ou piora), o MECANISMO (por quê) e a ORDEM DE GRANDEZA (mexe pouco, mexe muito, " +
    "ou vira o sinal), e diz com naturalidade que para o valor fechado precisaria abrir a planilha " +
    "depois. NUNCA pare para 'fazer a conta' e despejar um número recalculado — isso não é possível de " +
    "cabeça e você não faz isso.\n\n" +
    "Responda só o que foi perguntado, sem despejar tudo. Se pedirem seu nome, diga 'Bruno'. Se " +
    "pedirem um ok para começar, confirme de forma curta e natural.";

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
function pdfBlob(file) {
    return new Blob([fs.readFileSync(file)], { type: "application/pdf" });
}

// Heurística leve: a fala da entrevistadora está exigindo um número recalculado?
function looksLikeRecomputeDemand(text) {
    const t = text.toLowerCase();
    const asksQuant = /(de quanto|quanto (cai|sobe|muda|fica|seria|passa|ganha|perde|tira)|qual (o |a )?(vpl|tir|valor)|recalcul|me d[áa] o n[úu]mero|valor exato|n[úu]mero exato|em quanto)/.test(t);
    return asksQuant;
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

async function main() {
    const j = jar();
    console.log(`[seed] base=${BASE}`);

    await asJson(await jfetch(j, "/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "professor", password: "senha123" }),
    }), "login");
    console.log("[seed] login ok");

    const { work } = await asJson(await jfetch(j, "/admin/works", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "TEXT E2E Mineracao - principio resposta de cabeca" }),
    }), "create work");
    const workToken = work.work_token;
    console.log(`[seed] work=${workToken}`);

    {
        const fd = new FormData();
        fd.append("file", pdfBlob(ENUNCIADO_PDF), "enunciado-mineracao.pdf");
        await asJson(await jfetch(j, `/w/${workToken}/enunciado`, { method: "POST", body: fd }), "upload enunciado");
        console.log("[seed] enunciado real enviado");
    }
    {
        const tpl = await jfetch(j, `/interviewers/templates/${encodeURIComponent("Business Owner.yaml")}`);
        const yamlText = await tpl.text();
        await asJson(await jfetch(j, `/w/${workToken}/interviewer`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ yaml: yamlText }),
        }), "save interviewer");
        console.log("[seed] persona Business Owner salva");
    }
    await asJson(await jfetch(j, `/w/${workToken}/question-count`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_count: 6 }),
    }), "question-count");
    await asJson(await jfetch(j, `/w/${workToken}/interaction`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "text" }),
    }), "interaction mode");
    console.log("[seed] modo=texto, 6 perguntas");

    const { submissions } = await asJson(await jfetch(j, `/w/${workToken}/submissions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Bruno (aluno simulado)" }),
    }), "create submission");
    const subToken = submissions[0].submission_token;
    console.log(`[seed] submissão=${subToken}`);

    // ---- Lado do aluno ----
    await asJson(await jfetch(j, `/s/${subToken}/start`, { method: "POST" }), "start");
    console.log("[aluno] start ok; subindo o trabalho (dispara PrepBuilder/plano)...");

    let assistant;
    {
        const fd = new FormData();
        fd.append("file", pdfBlob(TRABALHO_PDF), "Trabalho-Claude-02.pdf");
        const up = await asJson(await jfetch(j, `/s/${subToken}/upload`, { method: "POST", body: fd }), "upload trabalho");
        assistant = up.assistant;
    }

    const history = [];
    const flags = [];
    let phase = "intro";
    for (let turn = 1; turn <= MAX_STUDENT_TURNS; turn++) {
        console.log(`\n──────── ENTREVISTADORA (turno ${turn}, fase=${phase}) ────────\n${assistant}`);
        history.push({ role: "interviewer", text: assistant });
        if (phase === "interviewing" && looksLikeRecomputeDemand(assistant)) {
            flags.push({ turn, text: assistant });
            console.log("  ⚠️  [flag] possível exigência de número recalculado");
        }
        if (phase === "finalizing" || phase === "finalized") { console.log("\n[fim] entrevista finalizada."); break; }

        const reply = await studentReply(history, assistant);
        console.log(`\n──────── ALUNO ────────\n${reply}`);
        history.push({ role: "student", text: reply });

        const chat = await asJson(await jfetch(j, `/s/${subToken}/chat`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: reply }),
        }), `chat turn ${turn}`);
        assistant = chat.assistant;
        if (chat.phase) phase = chat.phase;
        if (chat.channel === "modal") console.log("  [meta_modal]");
    }

    // ---- Persistir transcrição ----
    const outDir = path.join(__dirname, "runs-text");
    fs.mkdirSync(outDir, { recursive: true });
    const md = [
        `# Transcrição — TEXT E2E Mineração (princípio resposta de cabeça)`,
        `work=${workToken} submissão=${subToken}`,
        ``,
        ...history.map(h => `**${h.role === "interviewer" ? "Larissa" : "Bruno"}:** ${h.text}`),
        ``,
        `## Flags de exigência de recálculo: ${flags.length}`,
        ...flags.map(f => `- turno ${f.turn}: ${f.text}`),
    ].join("\n\n");
    const outFile = path.join(outDir, "transcript.md");
    fs.writeFileSync(outFile, md, "utf-8");
    console.log(`\n================ RESUMO ================`);
    console.log(`Turnos da entrevistadora: ${history.filter(h => h.role === "interviewer").length}`);
    console.log(`Flags de exigência de recálculo (heurística): ${flags.length}`);
    console.log(`Transcrição: ${outFile}`);
    console.log(`Trabalho (token p/ ver no painel do professor): ${workToken} / sub ${subToken}`);
}

main().catch(err => { console.error("ERRO:", err.message); process.exit(1); });
