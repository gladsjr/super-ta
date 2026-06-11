// A/B adversarial em MODO TEXTO. Mesmo aluno simulado ADVERSARIAL rodado contra
// o servidor com o prompt NOVO e com o prompt ANTIGO (troca feita por fora, via
// git stash + restart do servidor). Mede quantas vezes a entrevistadora EXIGE
// um número recalculado ao vivo.
//
// O aluno domina o trabalho, mas é adversarial: quando o ponto é quantitativo,
// é evasivo e OFERECE "rodar a planilha depois" — justamente para tentar a
// entrevistadora a pedir o valor exato. Cutuca divergências texto×tabela. Mas
// NUNCA despeja um número recalculado de cabeça: se insistirem, reafirma que
// precisaria abrir a planilha e oferece direção + mecanismo + ordem de grandeza.
//
// Uso: RUN_TAG=new node -r dotenv/config tests/text-e2e-adversarial.mjs
//      RUN_TAG=old node -r dotenv/config tests/text-e2e-adversarial.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openai } from "../lib/openaiClient.js";
import { FAST_MODEL } from "../lib/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.E2E_BASE || "http://127.0.0.1:5099";
const RUN_TAG = process.env.RUN_TAG || "adv";
const MINERACAO = "C:/Users/glads/Dropbox/Projetos/ORATIA/mineracao";
const ENUNCIADO_PDF = path.join(MINERACAO, "Enunciado Trabalho Mineração Bitcoin - Cliente.pdf");
const TRABALHO_PDF = path.join(MINERACAO, "Trabalho-Claude-02.pdf");
const MAX_STUDENT_TURNS = 24;

const STUDENT_SYSTEM =
    "Você é Bruno, um aluno que FEZ e ENTENDE o seu trabalho de viabilidade de mineração de Bitcoin " +
    "(fazenda com energia excedente, três cenários, VPL em 10 anos, taxa de desconto, hashrate da rede, " +
    "trajetória de preço do BTC). Está numa entrevista ORAL ao vivo com a cliente/dona, SEM planilha nem " +
    "calculadora agora. Fale português do Brasil falado: frases curtas, tom de conversa, sem listas.\n\n" +
    "POSTURA ADVERSARIAL (de propósito, para estressar a entrevistadora): quando o ponto for QUANTITATIVO, " +
    "seja EVASIVO e fique OFERECENDO calcular — diga coisas como 'se você quiser eu rodo a planilha e te " +
    "trago o número certinho', 'posso refazer essa conta', 'consigo te dar o valor exato depois' — para " +
    "tentar fazer ela PEDIR o número exato. Dê respostas vagas/incompletas que convidem a um 'mas de quanto " +
    "exatamente?'. De vez em quando, aponte de leve uma divergência entre o texto e a tabela do seu relatório " +
    "(ex.: 'no texto eu citei um número e na tabela aparece outro'), sem resolver na hora.\n\n" +
    "MAS — regra inquebrável: você NUNCA para para 'fazer a conta' e despeja um número recalculado de cabeça. " +
    "Isso não é possível ao vivo. Se a entrevistadora insistir no valor exato, você reafirma com naturalidade " +
    "que precisaria abrir a planilha depois e, aí sim, oferece DIREÇÃO (sobe/desce), MECANISMO (por quê) e " +
    "ORDEM DE GRANDEZA (mexe pouco, mexe muito, ou vira o sinal). Se ela aceitar o qualitativo e seguir, " +
    "coopere normalmente. Responda só o que foi perguntado. Nome: 'Bruno'. Se pedirem ok para começar, confirme curto.";

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
function pdfBlob(file) { return new Blob([fs.readFileSync(file)], { type: "application/pdf" }); }

function looksLikeRecomputeDemand(text) {
    const t = text.toLowerCase();
    return /(de quanto|quanto (cai|sobe|muda|fica|seria|passa|ganha|perde|tira)|qual (o |a )?(vpl|tir|valor)|recalcul|me d[áa] o n[úu]mero|valor exato|n[úu]mero exato|em quanto|chega a quanto|d[áa] quanto)/.test(t);
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
    console.log(`[seed] base=${BASE} run_tag=${RUN_TAG}`);
    await asJson(await jfetch(j, "/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "professor", password: "senha123" }),
    }), "login");

    const { work } = await asJson(await jfetch(j, "/admin/works", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `ADVERSARIAL ${RUN_TAG.toUpperCase()} - principio resposta de cabeca` }),
    }), "create work");
    const workToken = work.work_token;
    console.log(`[seed] work=${workToken}`);

    {
        const fd = new FormData();
        fd.append("file", pdfBlob(ENUNCIADO_PDF), "enunciado-mineracao.pdf");
        await asJson(await jfetch(j, `/w/${workToken}/enunciado`, { method: "POST", body: fd }), "upload enunciado");
    }
    {
        const tpl = await jfetch(j, `/interviewers/templates/${encodeURIComponent("Business Owner.yaml")}`);
        const yamlText = await tpl.text();
        await asJson(await jfetch(j, `/w/${workToken}/interviewer`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ yaml: yamlText }),
        }), "save interviewer");
    }
    await asJson(await jfetch(j, `/w/${workToken}/question-count`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question_count: 6 }),
    }), "question-count");
    await asJson(await jfetch(j, `/w/${workToken}/interaction`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "text" }),
    }), "interaction mode");

    const { submissions } = await asJson(await jfetch(j, `/w/${workToken}/submissions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: `Bruno adversarial (${RUN_TAG})` }),
    }), "create submission");
    const subToken = submissions[0].submission_token;
    console.log(`[seed] submissão=${subToken}; modo=texto, 6 perguntas`);

    await asJson(await jfetch(j, `/s/${subToken}/start`, { method: "POST" }), "start");
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
        console.log(`\n──────── ALUNO (adversarial) ────────\n${reply}`);
        history.push({ role: "student", text: reply });
        const chat = await asJson(await jfetch(j, `/s/${subToken}/chat`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: reply }),
        }), `chat turn ${turn}`);
        assistant = chat.assistant;
        if (chat.phase) phase = chat.phase;
        if (chat.channel === "modal") console.log("  [meta_modal]");
    }

    const outDir = path.join(__dirname, "runs-text");
    fs.mkdirSync(outDir, { recursive: true });
    const md = [
        `# Transcrição ADVERSARIAL (${RUN_TAG}) — princípio resposta de cabeça`,
        `work=${workToken} submissão=${subToken}`,
        ``,
        ...history.map(h => `**${h.role === "interviewer" ? "Larissa" : "Bruno"}:** ${h.text}`),
        ``,
        `## Flags de exigência de recálculo: ${flags.length}`,
        ...flags.map(f => `- turno ${f.turn}: ${f.text}`),
    ].join("\n\n");
    const outFile = path.join(outDir, `adversarial-${RUN_TAG}.md`);
    fs.writeFileSync(outFile, md, "utf-8");
    console.log(`\n================ RESUMO (${RUN_TAG}) ================`);
    console.log(`Turnos da entrevistadora: ${history.filter(h => h.role === "interviewer").length}`);
    console.log(`Flags de exigência de recálculo (heurística): ${flags.length}`);
    console.log(`Transcrição: ${outFile}`);
    console.log(`work=${workToken} sub=${subToken}`);
}

main().catch(err => { console.error("ERRO:", err.message); process.exit(1); });
